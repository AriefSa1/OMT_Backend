const prisma = require('../utils/prisma');
const syncService = require('../services/syncService');
const { wrapHandlers } = require('../utils/asyncHandler');

async function getSyncLogs(req, res) {
  try {
    const logs = await prisma.syncJobLog.findMany({ orderBy: { timestamp: 'desc' }, take: 50 });
    return res.json({ success: true, logs });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Unable to load sync history' });
  }
}

async function runFullSync(req, res) {
  const result = await syncService.syncAll({ origin: 'MANUAL' });
  return res.status(result.success ? 200 : 502).json(result);
}

module.exports = wrapHandlers({ getSyncLogs, runFullSync });
