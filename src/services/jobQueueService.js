/**
 * Async job queue service for lightweight, dependency-free background sync.
 *
 * Instead of blocking an HTTP request while syncService.syncAll() runs (which can
 * take seconds due to Shopee API calls + DB writes), we persist a job record and
 * process it asynchronously in a background worker loop.
 *
 * The worker runs inside the same Express server process (no separate daemon needed),
 * but jobs are stored in the database so they survive restarts.
 */
const prisma = require('../utils/prisma');
const syncService = require('./syncService');
const syncLockService = require('./syncLockService');

const POLL_INTERVAL_MS = 1000;
const ACTIVE_WORKERS = 3; // process up to 3 jobs concurrently
const JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes max per job
const JOB_STALE_MS = 60 * 60 * 1000; // 1 hour before a RUNNING job is considered stuck

class JobQueueService {
  constructor() {
    this.isRunning = false;
    this.workers = new Set();
    this.workerCount = 0;
  }

  /** Add a new job to the queue. Returns the job record. */
  async enqueue({
    type = 'SYNC_ALL',
    storeId = null,
    origin = 'MANUAL',
    payload = {},
  }) {
    const job = await prisma.syncJob.create({
      data: { type, storeId, origin, payload },
    });
    await this.logJob(job.id, type, 'STARTED', storeId, payload.userId || null, 'Job enqueued');
    return job;
  }

  /** Query the current job status. */
  async getJob(id) {
    return prisma.syncJob.findUnique({ where: { id } });
  }

  /** Paginated list of recent jobs (for /sync/jobs endpoint). */
  async listJobs({ status = null, limit = 50, page = 1 } = {}) {
    const skip = (Number(page) - 1) * Number(limit || 50);
    const where = {};
    if (status) where.status = status;
    return prisma.syncJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Number(limit) || 50,
      skip,
    });
  }

  async logJob(jobId, type, status, storeId, userId, message, durationMs = null) {
    try {
      // Use existing SyncJobLog table — store extra metadata in the message field
      const logMessage = durationMs ? `${message} (${durationMs}ms)` : message;
      await prisma.syncJobLog.create({
        data: {
          jobType: type,
          status,
          message: logMessage || '',
        },
      });
    } catch (err) {
      // Non-critical: don't let logging failures break sync runs
      console.warn('[JobQueue] Failed to write sync log:', err.message);
    }
  }

  /** Pick up the next pending job and run it. Returns true if a job was processed. */
  async processNext() {
    if (this.workerCount >= ACTIVE_WORKERS) return false;

    // Claim a job: move PENDING → RUNNING atomically.
    // Also recover jobs that were RUNNING but whose worker died (stale recovery),
    // and skip jobs that are already RUNNING by another active worker.
    const now = new Date();
    const staleThreshold = new Date(now.getTime() - JOB_STALE_MS);

    const job = await prisma.$transaction(async (tx) => {
      // 1. Reclaim stale RUNNING jobs (worker crashed)
      await tx.syncJob.updateMany({
        where: { status: 'RUNNING', startedAt: { lt: staleThreshold } },
        data: { status: 'PENDING', startedAt: null },
      });

      // 2. Claim the next PENDING job
      const next = await tx.syncJob.findFirst({
        where: { status: 'PENDING' },
        orderBy: [{ createdAt: 'asc' }, { type: 'asc' }],
        // Skip if there's already a RUNNING job of the same type+storeId (dedup)
        // — prevents duplicate sync jobs piling up.
      });

      if (!next) return null;

      // Dedup: skip if another RUNNING job has same type+storeId
      const running = await tx.syncJob.findFirst({
        where: {
          status: 'RUNNING',
          type: next.type,
          storeId: next.storeId,
        },
      });
      if (running) return null; // another worker is already on this job type

      // Claim it
      return tx.syncJob.update({
        where: { id: next.id },
        data: { status: 'RUNNING', startedAt: now },
      });
    });

    if (!job) return false;

    this.workerCount += 1;
    const workerId = `${process.pid}-${this.workerCount}`;
    this.workers.add(workerId);

    const startTime = Date.now();
    await this.logJob(job.id, job.type, 'STARTED', job.storeId, job.payload?.userId || null, `Worker ${workerId} started job ${job.type}`);

    try {
      const result = await syncLockService.runExclusive(
        async () => {
          const syncResult = await syncService.syncAll({
            origin: job.origin || 'MANUAL',
            storeId: job.storeId || undefined,
          });
          return syncResult;
        },
        { ttlMs: JOB_TTL_MS }
      );

      const durationMs = Date.now() - startTime;
      const resultJson = typeof result === 'string' ? result : JSON.stringify(result);

      await prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          result: resultJson || undefined,
          completedAt: new Date(),
        },
      });

      await this.logJob(
        job.id, job.type, 'COMPLETED', job.storeId, job.payload?.userId || null,
        typeof result === 'object' ? result.message || 'Completed' : 'Completed',
        durationMs
      );

      return true;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const lockError = err?.code === 'SYNC_ALREADY_RUNNING';

      if (lockError) {
        // Another process picked up this sync — mark as completed-skipped
        await prisma.syncJob.update({
          where: { id: job.id },
          data: {
            status: 'COMPLETED',
            result: JSON.stringify({ skipped: true, reason: 'SYNC_ALREADY_RUNNING', message: err.message }),
            completedAt: new Date(),
          },
        });
        await this.logJob(job.id, job.type, 'COMPLETED', job.storeId, job.payload?.userId || null, 'Skipped: another sync in progress', durationMs);
      } else {
        const errorMsg = err?.message || 'Unknown sync error';
        await prisma.syncJob.update({
          where: { id: job.id },
          data: {
            status: 'FAILED',
            error: errorMsg,
            result: JSON.stringify({ success: false, error: errorMsg }).substring(0, 4000),
            completedAt: new Date(),
          },
        });
        await this.logJob(job.id, job.type, 'FAILED', job.storeId, job.payload?.userId || null, errorMsg, durationMs);
      }

      return true;
    } finally {
      this.workerCount -= 1;
      this.workers.delete(workerId);
    }
  }

  /** Start the background worker loop. */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log('[JobQueue] Worker loop started — polling for jobs every', POLL_INTERVAL_MS + 'ms');

    // Initial sweep: recover any stale RUNNING jobs
    this.recoverStaleJobs();

    this.interval = setInterval(() => {
      this.processNext().catch((err) => {
        console.error('[JobQueue] Worker error:', err.message);
      });
    }, POLL_INTERVAL_MS);
  }

  /** Recover stale RUNNING jobs when starting up */
  async recoverStaleJobs() {
    const staleThreshold = new Date(Date.now() - JOB_STALE_MS);
    const recovered = await prisma.syncJob.updateMany({
      where: { status: 'RUNNING', startedAt: { lt: staleThreshold } },
      data: { status: 'PENDING', startedAt: null },
    });
    if (recovered.count > 0) {
      console.log('[JobQueue] Recovered', recovered.count, 'stale RUNNING jobs to PENDING');
    }
  }

  /** Stop the worker loop (call on shutdown). */
  stop() {
    this.isRunning = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    console.log('[JobQueue] Worker loop stopped');
  }
}

module.exports = new JobQueueService();
