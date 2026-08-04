const cron = require('node-cron');
const syncService = require('../services/syncService');

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
      const result = await syncService.syncAll({ origin: 'CRON' });
      console.log(`[CRON] ${result.message}`);
    } catch (error) {
      console.error('[CRON] Sinkronisasi gagal:', error.message);
    }
  }));
}

module.exports = { initCronJobs };
