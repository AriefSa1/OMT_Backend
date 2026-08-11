const analyticsService = require('../services/analyticsService');
const { wrapHandlers } = require('../utils/asyncHandler');

async function getOverview(req, res) {
  try {
    const storeId = req.query.store_id || req.query.storeId || null;
    const period = req.query.period || 'real_time';
    const startDate = req.query.start_date || req.query.startDate;
    const endDate = req.query.end_date || req.query.endDate;
    const range = (startDate && endDate) ? { startDate, endDate } : null;
    const data = await analyticsService.getDashboardOverview(storeId, period, range);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = wrapHandlers({ getOverview });
