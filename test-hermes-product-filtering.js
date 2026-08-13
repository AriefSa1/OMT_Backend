const shopeeService = require('./src/services/shopeeService');
const canonicalService = require('./src/services/hermesCanonicalDataService');
const { validateAnalysisOutput } = require('./src/services/hermesOutputValidator');

const originalPerformance = shopeeService.fetchProductPerformance;
const originalOverview = shopeeService.fetchProductOverview;

async function main() {
  const products = Array.from({ length: 12 }, (_, index) => ({
    rank: index + 1,
    itemId: `item-${index + 1}`,
    name: `Produk ${index + 1}`,
    sku: `SKU-${index + 1}`,
    price: 100000 + index,
    confirmedSales: 1200000 - (index * 10000),
    confirmedOrders: 100 - index,
    confirmedUnits: 110 - index,
    confirmedBuyers: 90 - index,
    views: 10000 - (index * 100),
    visitors: 5000 - (index * 50),
    addToCartUnits: 500 - index,
    addToCartRate: 10 - (index * 0.1),
    conversionRate: 2.5 - (index * 0.05),
    bounceRate: 30,
    raw: { raw_sales: 999999999, raw_conversion_rate: 0.31 },
  }));

  shopeeService.fetchProductPerformance = async () => ({
    dataSource: 'SHOPEE_API',
    live: true,
    total: products.length,
    startTime: 100,
    endTime: 200,
    products,
    summary: {
      totalSales: 13260000,
      totalOrders: 1134,
      totalUnits: 1254,
      totalViews: 113400,
      totalVisitors: 56700,
      totalBuyers: 1014,
      averageConversionRate: 2,
    },
  });
  shopeeService.fetchProductOverview = async () => ({
    source: 'SHOPEE_API',
    metrics: {
      confirmed_gmv: { value: 13260000 },
      confirmed_unit_num: { value: 1254 },
    },
  });

  const result = await canonicalService.load({
    intent: 'PERFORMA_PRODUK',
    range: { startDate: '2026-07-15', endDate: '2026-08-13', days: 30 },
    storeId: 'store-test',
  });
  const detailProducts = result.details.products;
  const productEvidence = result.evidence.filter((item) => item.grain === 'product' && item.entityId);
  const firstProductEvidence = productEvidence.find((item) => item.entityId === 'item-1' && item.metric === 'averageConversionRate');
  const output = {
    schemaVersion: '1.0',
    executiveVerdict: 'Produk teratas perlu diuji.',
    criticalFindings: [{
      severity: 'MEDIUM',
      title: 'Produk teratas',
      description: 'Temuan berbasis evidence produk.',
      evidenceIds: [firstProductEvidence?.id],
      impact: { metric: 'averageConversionRate', value: firstProductEvidence?.value, unit: '%' },
      confidence: 'HIGH',
    }],
    rootCauseAnalysis: [],
    prioritizedActions: [],
    dataGaps: [],
    uncertainty: [],
  };
  const validation = validateAnalysisOutput(output, {
    intent: 'PERFORMA_PRODUK',
    evidence: result.evidence,
    trustedMetrics: result.trustedMetrics,
  });
  const checks = [
    ['product source reconciles', result.quality.reconciliation.status === 'MATCH'],
    ['raw and ungrounded price fields are removed', detailProducts.every((product) => product.raw === undefined && product.price === undefined)],
    ['detail list is bounded to top ten', detailProducts.length === 10],
    ['detail scope is explicit', result.details.detailScope === 'TOP_PRODUCTS_BY_CONFIRMED_SALES'],
    ['product evidence is bounded and present', productEvidence.length > 0 && productEvidence.length <= 90],
    ['product conversion evidence uses percentage unit', firstProductEvidence?.unit === '%' && firstProductEvidence?.value === 2.5],
    ['product evidence can be cited by validator', validation.valid === true],
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
    shopeeService.fetchProductPerformance = originalPerformance;
    shopeeService.fetchProductOverview = originalOverview;
  });
