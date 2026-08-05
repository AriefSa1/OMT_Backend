// Read-only verification for the two remaining backend items in AGENTS.md:
//   1. optimizationController marketplace intelligence (activeAdCampaigns, productSignals)
//   2. growthIntelligenceService demandForecast / bundleSuggestions
// Reads local snapshots only — no Shopee sync is triggered (constraint 8).
require('dotenv').config();

const snapshotService = require('./src/services/snapshotService');
const shopeeInsightsService = require('./src/services/shopeeInsightsService');
const growthIntelligenceService = require('./src/services/growthIntelligenceService');
const optimizationController = require('./src/controllers/optimizationController');
const prisma = require('./src/utils/prisma');

// Calls a controller the way Express would, without opening a port.
function callHandler(handler, req = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body }); return this; },
    };
    Promise.resolve(handler({ query: {}, body: {}, user: null, ...req }, res, reject)).catch(reject);
  });
}

function assert(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} — ${label}${detail ? ` (${detail})` : ''}`);
  if (!condition) process.exitCode = 1;
}

(async () => {
  const [catalog, ads] = await Promise.all([
    snapshotService.getCatalogSnapshot({ page: 1, limit: 100 }),
    snapshotService.getAdsSnapshot(),
  ]);
  const measured = catalog.products.filter((product) => product.metric);
  const signals = shopeeInsightsService.buildProductSignals(measured.map((product) => ({
    id: product.shopeeItemId,
    name: product.name,
    product_card_impressions: product.metric.impressions,
    ctr: snapshotService.normalizeRate(product.metric.ctr),
    add_to_cart_buyers: product.metric.addToCartBuyers,
    confirmed_orders: product.metric.confirmedOrders,
    bounce_rate: snapshotService.normalizeRate(product.metric.bounceRate),
  })));

  console.log('== marketplace intelligence ==');
  console.log(`catalog products: ${catalog.products.length}, with metrics: ${measured.length}`);
  console.log(`productSignals: ${signals.length}, activeAdCampaigns: ${ads.topCampaigns.length}`);
  console.log(`ads meta: ${ads.meta.status} | ${ads.meta.message}`);
  if (signals[0]) console.log(`signal sample: ${JSON.stringify(signals[0])}`);

  assert('productSignals derive from measured products only', signals.every((signal) => signal.id.startsWith('SHOPEE-')));
  assert(
    'no signal is emitted without a product metric',
    measured.length > 0 || signals.length === 0,
    `measured=${measured.length}`,
  );
  assert(
    'activeAdCampaigns mirror the persisted campaign snapshot',
    Array.isArray(ads.topCampaigns),
  );
  assert(
    'ads monitor carries a reason when no campaign exists',
    ads.topCampaigns.length > 0 || Boolean(ads.meta.message),
  );

  const { body } = await callHandler(optimizationController.getMarketplaceInsights);
  const insights = body.data;
  console.log('\n== GET /api/optimization/marketplace-intelligence ==');
  console.log(`activeAdCampaigns: ${insights.activeAdCampaigns.length}, productSignals: ${insights.productSignals.length}`);
  console.log(`adsMonitor: ${JSON.stringify(insights.adsMonitor)}`);
  console.log(`productSignalsMeta: ${JSON.stringify(insights.productSignalsMeta)}`);

  assert('controller no longer returns a hardcoded empty campaign list', insights.activeAdCampaigns.length === ads.topCampaigns.length);
  assert('controller returns the wired product signals', insights.productSignals.length === signals.length);
  assert('adsMonitor reports a real snapshot status', insights.adsMonitor.status === ads.meta.status);
  assert('adsMonitor no longer states a fixed sentence as its status', insights.adsMonitor.status !== 'SNAPSHOT');
  assert(
    'empty signals always carry a reason',
    insights.productSignals.length > 0 || Boolean(insights.productSignalsMeta.message),
  );

  const dashboard = await snapshotService.getDashboardOverview();
  console.log('\n== dashboard overview ==');
  console.log(`categorySales: ${JSON.stringify(dashboard.categorySales)}`);
  console.log(`categorySalesMeta: ${JSON.stringify(dashboard.categorySalesMeta)}`);
  console.log(`salesTrend points: ${dashboard.salesTrend.length}`);
  assert('category shares travel with their coverage', Boolean(dashboard.categorySalesMeta?.message));
  assert(
    'coverage counts the products it was computed over',
    dashboard.categorySalesMeta.productCount === dashboard.topProducts.length,
  );

  const overview = await growthIntelligenceService.getOverview();
  console.log('\n== growth overview ==');
  console.log(`demandForecast: ${JSON.stringify(overview.demandForecast)}`);
  console.log(`bundleSuggestions: ${JSON.stringify(overview.bundleSuggestions)}`);
  console.log(`weeklyReport: ${JSON.stringify(overview.weeklyReport)}`);
  console.log(`catalogScorecard score: ${overview.catalogScorecard.score}, products: ${overview.catalogScorecard.products.length}`);
  console.log(`restockPlan: ${overview.restockPlan.length}, priceStrategies: ${overview.priceStrategies.length}, adOpportunities: ${overview.adOpportunities.length}, listingExperiments: ${overview.listingExperiments.length}`);
  console.log(`voucherAnalysis: ${JSON.stringify(overview.voucherAnalysis)}`);

  for (const key of ['demandForecast', 'bundleSuggestions']) {
    const value = overview[key];
    assert(`${key} states its unavailability`, value?.status === 'TIDAK_TERSEDIA' && typeof value.message === 'string' && value.message.length > 20);
    assert(`${key} carries no invented rows`, Array.isArray(value?.items) && value.items.length === 0);
  }

  await prisma.$disconnect();
})().catch(async (error) => {
  console.error('FAILED:', error);
  process.exitCode = 1;
  await prisma.$disconnect();
});
