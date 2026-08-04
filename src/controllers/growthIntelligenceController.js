const growthIntelligenceService = require('../services/growthIntelligenceService');
const { wrapHandlers } = require('../utils/asyncHandler');

async function getGrowthOverview(req, res) {
  const data = await growthIntelligenceService.getOverview();
  return res.json({ success: true, data });
}

module.exports = wrapHandlers({ getGrowthOverview });
