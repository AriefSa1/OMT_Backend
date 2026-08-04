const analyticsService = require('../services/analyticsService');
const { wrapHandlers } = require('../utils/asyncHandler');

async function getOverview(req, res) {
  try {
    const data = await analyticsService.getDashboardOverview();
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = wrapHandlers({ getOverview });
