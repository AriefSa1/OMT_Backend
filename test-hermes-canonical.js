const shopeeService = require('./src/services/shopeeService');
const canonicalService = require('./src/services/hermesCanonicalDataService');
const { getSkill } = require('./src/services/hermesSkillRegistry');
const { reviewContext } = require('./src/services/hermesDecisionReviewer');

const original = {
  ads: shopeeService.fetchShopeeAdsMetrics,
  overview: shopeeService.fetchProductOverview,
  products: shopeeService.fetchProductPerformance,
};

const range = { startDate: '2026-07-14', endDate: '2026-08-12', days: 30 };

async function main() {
  shopeeService.fetchShopeeAdsMetrics = async () => ({
    success: true,
    dataSource: 'SHOPEE_API',
    totalSpend: 100,
    totalSalesGenerated: 250,
    roas: 2.5,
    impressions: 1000,
    clicks: 50,
    ctr: 5,
    orders: 2,
    itemSold: 3,
    topCampaigns: [],
    period: { type: 'past30days', startTime: 100, endTime: 200 },
  });
  shopeeService.fetchProductOverview = async () => ({
    source: 'SHOPEE_API',
    metrics: {
      confirmed_gmv: { value: 1000000 },
      confirmed_buyers: { value: 10 },
      confirmed_unit_num: { value: 20 },
      uv: { value: 100 },
    },
  });
  shopeeService.fetchProductPerformance = async () => ({
    success: true,
    dataSource: 'SHOPEE_API',
    live: true,
    period: 'past30days',
    startTime: 100,
    endTime: 200,
    total: 2,
    summary: {
      totalSales: 1000000,
      totalOrders: 12,
      totalUnits: 20,
      totalViews: 500,
      totalVisitors: 300,
      totalBuyers: 11,
      averageConversionRate: 4,
    },
    products: [{ itemId: '1', confirmedSales: 1000000 }],
  });

  const ads = await canonicalService.load({ intent: 'IKLAN', range, storeId: 'store-test' });
  const store = await canonicalService.load({ intent: 'PERFORMA_TOKO', range, storeId: 'store-test' });
  const products = await canonicalService.load({ intent: 'PERFORMA_PRODUK', range, storeId: 'store-test' });
  const reviewer = reviewContext({
    ...products,
    skill: getSkill('PERFORMA_PRODUK'),
  });

  const mismatchOverview = async () => ({
    source: 'SHOPEE_API',
    metrics: {
      confirmed_gmv: { value: 999999 },
      confirmed_unit_num: { value: 19 },
    },
  });
  shopeeService.fetchProductOverview = mismatchOverview;
  const mismatch = await canonicalService.load({ intent: 'PERFORMA_PRODUK', range, storeId: 'store-test' });

  const checks = [
    ['ads uses live canonical source', ads.success && ads.quality.status === 'SAFE' && ads.sourceMode === 'LIVE_CANONICAL'],
    ['store uses Product Overview confirmed metrics', store.trustedMetrics.confirmedGmv === 1000000 && store.trustedMetrics.confirmedUnits === 20],
    ['product core totals reconcile', products.quality.reconciliation.status === 'MATCH'],
    ['product evidence ledger is populated', products.evidence.length >= 8],
    ['product skill is selected', getSkill('PERFORMA_PRODUK')?.id === 'product-portfolio-analyst'],
    ['critical reviewer accepts safe reconciled context', reviewer.pass === true],
    ['mismatch blocks product source', mismatch.quality.status === 'BLOCKED' && mismatch.quality.reconciliation.status === 'MISMATCH'],
  ];

  let passed = 0;
  for (const [label, condition] of checks) {
    if (condition) {
      passed += 1;
      console.log(`  PASS ${label}`);
    } else {
      console.log(`  FAIL ${label}`);
    }
  }
  console.log(`\n=== ${passed}/${checks.length} checks passed ===`);
  process.exitCode = passed === checks.length ? 0 : 1;
}

main()
  .catch((error) => {
    console.error('Suite crashed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    shopeeService.fetchShopeeAdsMetrics = original.ads;
    shopeeService.fetchProductOverview = original.overview;
    shopeeService.fetchProductPerformance = original.products;
  });
