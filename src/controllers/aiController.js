const aiService = require('../services/aiService');
const snapshotService = require('../services/snapshotService');
const { wrapHandlers } = require('../utils/asyncHandler');

/**
 * Every FITUR endpoint below shares one shape: optionally override the Gemini key for
 * this request (Settings can save a key without restarting the server), call one
 * aiService method with a fixed slice of the request body, and return its envelope
 * untouched — aiService.js already encodes success/failure/provider/errorCode, so this
 * layer must not re-wrap it.
 *
 * `pickArgs` names exactly the fields each feature reads, the same way the original
 * per-endpoint destructuring did — nothing is passed through blind.
 *
 * To add a new AI endpoint: write the method on aiService, then one line here —
 * `const myEndpoint = aiEndpoint('myServiceMethod', ({ a, b }) => ({ a, b }));` — and
 * export + route it. See docs/AI_SERVICE.md for the full walkthrough.
 */
function aiEndpoint(serviceMethod, pickArgs) {
  return async function handler(req, res) {
    try {
      const { geminiApiKey } = req.body;
      if (geminiApiKey) aiService.setApiKey(geminiApiKey);
      const result = await aiService[serviceMethod](pickArgs(req.body));
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  };
}

// 1. A/B Testing Copywriter
const generateABCopy = aiEndpoint('generateABTestCopy', ({ name, category, price, description, targetAudience }) => (
  { name, category, price, description, targetAudience }
));

// 2. Predictive Restock & Liquidation
const predictRestock = aiEndpoint('predictRestockAndLiquidation', ({ name, sku, stock, salesCount, warehouseStock, leadTimeDays, category }) => (
  { name, sku, stock, salesCount, warehouseStock, leadTimeDays, category }
));

// 3. Dynamic Pricing Simulator
const simulatePricing = aiEndpoint('simulateDynamicPricing', ({ name, currentPrice, targetPrice, unitCost, unitAdCost, shippingCost, platformFeePercent, competitorPrice }) => (
  { name, currentPrice, targetPrice, unitCost, unitAdCost, shippingCost, platformFeePercent, competitorPrice }
));

// 5. Ads Keyword & Bid Optimizer
const optimizeAdsKeywords = aiEndpoint('optimizeAdsKeywordsAndBids', ({ campaignName, spend, sales, roas, ctr, category }) => (
  { campaignName, spend, sales, roas, ctr, category }
));

// 6. Scale-Up Strategy per produk — dibangun di atas penjualan per varian, jadi menerima
// `variations` dan `variationSummary` apa adanya dari snapshot produk.
const suggestScaleUp = aiEndpoint('suggestScaleUpStrategy', ({ name, category, price, stock, salesCount, metric, variations, variationSummary }) => (
  { name, category, price, stock, salesCount, metric, variations, variationSummary }
));

// 4. Daily Briefing — kept as its own function: unlike the four above, it does not take
// a request body, it composes three snapshots first, and its response shape wraps the
// service result inside `briefing` rather than returning it directly.
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

module.exports = wrapHandlers({
  generateABCopy,
  predictRestock,
  simulatePricing,
  getDailyBriefing,
  optimizeAdsKeywords,
  suggestScaleUp,
});
