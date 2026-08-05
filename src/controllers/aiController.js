const aiService = require('../services/aiService');
const snapshotService = require('../services/snapshotService');
const { wrapHandlers } = require('../utils/asyncHandler');

// 1. A/B Testing Copywriter
async function generateABCopy(req, res) {
  try {
    const { name, category, price, description, targetAudience, geminiApiKey } = req.body;
    if (geminiApiKey) aiService.setApiKey(geminiApiKey);

    const result = await aiService.generateABTestCopy({
      name,
      category,
      price,
      description,
      targetAudience,
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

// 2. Predictive Restock & Liquidation
async function predictRestock(req, res) {
  try {
    const { name, sku, stock, salesCount, warehouseStock, leadTimeDays, category, geminiApiKey } = req.body;
    if (geminiApiKey) aiService.setApiKey(geminiApiKey);

    const result = await aiService.predictRestockAndLiquidation({
      name,
      sku,
      stock,
      salesCount,
      warehouseStock,
      leadTimeDays,
      category,
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

// 3. Dynamic Pricing Simulator
async function simulatePricing(req, res) {
  try {
    const { name, currentPrice, targetPrice, unitCost, unitAdCost, shippingCost, platformFeePercent, competitorPrice, geminiApiKey } = req.body;
    if (geminiApiKey) aiService.setApiKey(geminiApiKey);

    const result = await aiService.simulateDynamicPricing({
      name,
      currentPrice,
      targetPrice,
      unitCost,
      unitAdCost,
      shippingCost,
      platformFeePercent,
      competitorPrice,
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

// 4. Daily Briefing
async function getDailyBriefing(req, res) {
  try {
    const [overview, ads, warehouse] = await Promise.all([
      snapshotService.getDashboardOverview(),
      snapshotService.getAdsSnapshot(),
      snapshotService.getWarehouseSnapshot({ page: 1, limit: 10 }),
    ]);

    const result = await aiService.generateDailyBriefing({
      storeOverview: overview,
      adsMetrics: ads,
      warehouseTotals: warehouse.totals,
      topProducts: overview.topProducts || [],
    });

    // Must mirror the service's own verdict. Hardcoding true here made the card's
    // `if (res.success && res.briefing)` guard pass for a NOT_CONFIGURED briefing, so
    // canned content rendered exactly like live model output.
    return res.json({
      success: result.success,
      provider: result.provider,
      message: result.message,
      briefing: result,
      meta: {
        storeName: overview.storeName,
        lastSyncedAt: overview.lastSyncedAt,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

// 5. Ads Keyword & Bid Optimizer
async function optimizeAdsKeywords(req, res) {
  try {
    const { campaignName, spend, sales, roas, ctr, category, geminiApiKey } = req.body;
    if (geminiApiKey) aiService.setApiKey(geminiApiKey);

    const result = await aiService.optimizeAdsKeywordsAndBids({
      campaignName,
      spend,
      sales,
      roas,
      ctr,
      category,
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = wrapHandlers({
  generateABCopy,
  predictRestock,
  simulatePricing,
  getDailyBriefing,
  optimizeAdsKeywords,
});
