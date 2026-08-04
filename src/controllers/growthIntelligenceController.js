const growthIntelligenceService = require('../services/growthIntelligenceService');

async function getGrowthOverview(req, res) {
  const data = await growthIntelligenceService.getOverview();
  return res.json({ success: true, data });
}

module.exports = { getGrowthOverview };
