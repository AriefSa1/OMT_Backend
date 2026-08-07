const { wrapHandlers } = require('../utils/asyncHandler');
const jobQueueService = require('../services/jobQueueService');

/**
 * GET /api/sync/jobs
 * List recent sync jobs with optional status filter.
 * Query params: status (PENDING/RUNNING/COMPLETED/FAILED), page, limit
 */
async function getJobs(req, res) {
  const { status, page = 1, limit = 50 } = req.query;
  const jobs = await jobQueueService.listJobs({
    status: status || null,
    page: Number(page),
    limit: Number(limit),
  });
  return res.json({ success: true, jobs });
}

/**
 * GET /api/sync/jobs/:id
 * Get status of a specific job.
 */
async function getJob(req, res) {
  const job = await jobQueueService.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job tidak ditemukan.' });
  }

  // Compute duration from timestamps if completed
  let durationMs = null;
  if (job.startedAt && job.completedAt) {
    durationMs = new Date(job.completedAt) - new Date(job.startedAt);
  } else if (job.startedAt && job.status === 'RUNNING') {
    // Running job: live elapsed duration
    durationMs = Date.now() - new Date(job.startedAt);
  }

  return res.json({
    success: true,
    job: {
      id: job.id,
      type: job.type,
      storeId: job.storeId,
      origin: job.origin,
      status: job.status,
      payload: job.payload,
      result: job.result ? JSON.parse(job.result) : null,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      durationMs: durationMs !== null ? Math.round(durationMs) : null,
    },
  });
}

/**
 * POST /api/sync/run-async
 * Enqueue a sync job to run in the background and return immediately.
 * Body: { type?: string, store_id?: string, origin?: string, payload?: object }
 */
async function runAsync(req, res) {
  const {
    type = 'SYNC_ALL',
    store_id: storeIdQuery = req.query.store_id,
    storeId: storeIdBody = req.query.storeId,
    origin = 'MANUAL',
    payload = {},
  } = { ...req.query, ...req.body };

  const storeId = storeIdQuery || storeIdBody || req.body.store_id || req.body.storeId || null;

  const job = await jobQueueService.enqueue({
    type,
    storeId,
    origin,
    payload: { ...payload, userId: req.user?.id, userEmail: req.user?.email },
  });

  return res.json({
    success: true,
    jobId: job.id,
    status: job.status,
    message: `Job ${type} dimasukkan ke antrean dan akan diproses di background. Pantau di /api/sync/jobs/${job.id}`,
    pollingUrl: `/api/sync/jobs/${job.id}`,
    immediateFallbackUrl: '/api/sync/run',
  });
}

module.exports = wrapHandlers({ getJobs, getJob, runAsync });
