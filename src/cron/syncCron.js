const cron = require('node-cron');
const jobQueueService = require('../services/jobQueueService');

let scheduledJobs = [];

function toCronExpression(interval) {
  const expressions = {
    '5m': '*/5 * * * *',
    '15m': '*/15 * * * *',
    '30m': '*/30 * * * *',
    '1h': '0 * * * *',
  };
  return expressions[interval] || expressions['15m'];
}

function initCronJobs(interval = '15m') {
  scheduledJobs.forEach((job) => job.stop());
  scheduledJobs = [];
  const schedule = toCronExpression(interval);
  console.log(`[CRON Engine] Sync snapshot terjadwal: ${schedule}`);

  scheduledJobs.push(cron.schedule(schedule, async () => {
    try {
      // Enqueue sync job to the background queue instead of running synchronously.
      // The worker loop in jobQueueService.start() will pick it up automatically.
      const job = await jobQueueService.enqueue({
        type: 'SYNC_ALL',
        origin: 'CRON',
      });
      console.log(`[CRON] Sync job enqueued: ${job.id}`);
    } catch (error) {
      console.error('[CRON] Gagal mengantrekan sync job:', error.message);
    }
  }));
}

module.exports = { initCronJobs };
