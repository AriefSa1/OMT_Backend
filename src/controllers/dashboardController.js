const analyticsService = require('../services/analyticsService');

async function getOverview(req, res) {
  try {
    const data = await analyticsService.getDashboardOverview();
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { getOverview };
