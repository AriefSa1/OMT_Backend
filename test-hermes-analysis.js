/**
 * Regression tests for Hermes analysis intent normalization, default 30-day range,
 * trusted arithmetic, and the BLOCKED gate. No Hermes request or Shopee Sync is made.
 */
const hermesAnalysisService = require('./src/services/hermesAnalysisService');
const prisma = require('./src/utils/prisma');

let passed = 0;
let total = 0;

function check(label, condition) {
  total += 1;
  if (condition) {
    passed += 1;
    console.log(`  PASS ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
  }
}

async function main() {
  console.log('=== Hermes analysis validation suite — no live Hermes calls ===\n');

  console.log('1. Intent normalization');
  check('Iklan -> IKLAN', hermesAnalysisService.normalizeIntent('Iklan') === 'IKLAN');
  check('Performa Toko -> PERFORMA_TOKO', hermesAnalysisService.normalizeIntent('Performa   Toko') === 'PERFORMA_TOKO');
  check('Performa Produk -> PERFORMA_PRODUK', hermesAnalysisService.normalizeIntent('Performa Produk') === 'PERFORMA_PRODUK');
  check('unknown intent is rejected', hermesAnalysisService.normalizeIntent('Penjualan') === null);

  console.log('\n2. Default range');
  const defaultRange = hermesAnalysisService.resolveAnalysisRange({});
  check('defaults to exactly 30 calendar dates', defaultRange.days === 30);
  check('default range is marked as defaulted', defaultRange.defaulted === true);
  check('range endpoints are ISO dates', /^\d{4}-\d{2}-\d{2}$/.test(defaultRange.startDate) && /^\d{4}-\d{2}-\d{2}$/.test(defaultRange.endDate));

  console.log('\n3. Trusted arithmetic');
  const ads = hermesAnalysisService.aggregateAds([
    { spend: 100, sales: 250, impressions: 1000, clicks: 50, orders: 2, itemSold: 2 },
    { spend: 50, sales: 50, impressions: 500, clicks: 10, orders: 1, itemSold: 1 },
  ]);
  check('ROAS is calculated from sales/spend', ads.roas === 2);
  check('CTR is calculated from clicks/impressions', ads.ctr === 4);
  check('source rows are counted', ads.rows === 2);
  const noDenominator = hermesAnalysisService.aggregateAds([{ spend: 100, sales: 250, impressions: 0, clicks: 0, orders: 0, itemSold: 0 }]);
  check('CTR is null when denominator is zero', noDenominator.ctr === null);
  const orders = hermesAnalysisService.aggregateOrders([{ gmv: 100000, orderCount: 2, conversionRate: 0.025 }]);
  check('conversion rate fractions are normalized to percentage points', orders.conversionRate === 2.5);

  console.log('\n4. BLOCKED gate');
  const service = new hermesAnalysisService.HermesAnalysisService();
  service.resolveSession = async () => null;
  let upstreamCalls = 0;
  const originalChat = require('./src/services/hermesAgentService').chat;
  require('./src/services/hermesAgentService').chat = async () => {
    upstreamCalls += 1;
    return { success: true };
  };
  try {
    const validation = await service.validate({ intent: 'Iklan', user: { id: 'user-test', role: 'USER' } });
    check('missing authorized session becomes BLOCKED', validation.quality?.status === 'BLOCKED');
    check('BLOCKED context cannot call Hermes', validation.canCallHermes === false);
    const analysis = await service.analyze({ intent: 'Iklan', user: { id: 'user-test', role: 'USER' } });
    check('analysis returns DATA_BLOCKED', analysis.errorCode === 'DATA_BLOCKED');
    check('no upstream Hermes call was made', upstreamCalls === 0);
  } finally {
    require('./src/services/hermesAgentService').chat = originalChat;
  }

  console.log('\n5. Authorized context uses the 30-day window');
  const serviceWithData = new hermesAnalysisService.HermesAnalysisService();
  serviceWithData.resolveSession = async () => ({ storeId: 'store-test', userId: 'user-test' });
  const today = defaultRange.endDate;
  const originalAdsFindMany = prisma.shopeeAdsData.findMany;
  const originalCampaignFindMany = prisma.shopeeAdsCampaignSnapshot.findMany;
  let adsWhere = null;
  let campaignWhere = null;
  prisma.shopeeAdsData.findMany = async ({ where }) => {
    adsWhere = where;
    return [{ storeId: 'store-test', date: today, spend: 100, sales: 250, impressions: 1000, clicks: 50, orders: 2, itemSold: 2, dataAsOf: new Date() }];
  };
  prisma.shopeeAdsCampaignSnapshot.findMany = async ({ where }) => {
    campaignWhere = where;
    return [
      { storeId: 'store-test', campaignId: 'campaign-1', name: 'Campaign 1', state: 'ONGOING', date: today, spend: 50, sales: 100, impressions: 500, clicks: 25, dataAsOf: new Date() },
      { storeId: 'store-test', campaignId: 'campaign-2', name: 'Campaign 2', state: 'ONGOING', date: today, spend: 50, sales: 150, impressions: 500, clicks: 25, dataAsOf: new Date() },
    ];
  };
  try {
    const validation = await serviceWithData.validate({ intent: 'Iklan', user: { id: 'user-test', role: 'USER' } });
    check('authorized context keeps the default period at 30 days', validation.period?.days === 30);
    check('authorized context remains blocked while coverage is incomplete', validation.canCallHermes === false);
    check('trusted ROAS is exposed from backend arithmetic', validation.trustedContextPreview?.trustedMetrics?.roas?.value === 2.5);
    check('daily query is scoped to the authorized store and period', adsWhere?.storeId === 'store-test' && adsWhere?.date?.gte === validation.period.startDate && adsWhere?.date?.lte === validation.period.endDate);
    check('campaign query is scoped to the authorized store and period', campaignWhere?.storeId === 'store-test' && campaignWhere?.date?.gte === validation.period.startDate && campaignWhere?.date?.lte === validation.period.endDate);
  } finally {
    prisma.shopeeAdsData.findMany = originalAdsFindMany;
    prisma.shopeeAdsCampaignSnapshot.findMany = originalCampaignFindMany;
  }

  console.log(`\n=== ${passed}/${total} checks passed ===`);
  process.exitCode = passed === total ? 0 : 1;
}

main().catch((err) => {
  console.error('Suite crashed:', err);
  process.exitCode = 1;
});
