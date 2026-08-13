/* Regression test for the paginated Seller Center product-performance response. */
require('dotenv').config();

const shopeeHttp = require('./src/utils/shopeeHttp');
const prisma = require('./src/utils/prisma');

const originalRequest = shopeeHttp.shopeeRequest;
const originalCatalogFindMany = prisma.shopeeProduct.findMany;

const allItems = Array.from({ length: 120 }, (_, index) => ({
  id: 1000 + index,
  name: `Product ${index + 1}`,
  confirmed_sales: (index + 1) * 100,
  confirmed_orders: 1,
  confirmed_units: 2,
  confirmed_buyers: 1,
  pv: 10,
  uv: 5,
  confirmed_order_conversion_rate: 0.2,
}));

shopeeHttp.shopeeRequest = async ({ url }) => {
  const query = new URL(url).searchParams;
  const pageSize = Math.min(Number(query.get('page_size')) || 10, 50);
  const pageNum = Number(query.get('page_num')) || 1;
  const start = (pageNum - 1) * pageSize;
  return {
    data: {
      code: 0,
      result: {
        total: allItems.length,
        items: allItems.slice(start, start + pageSize),
      },
    },
  };
};

async function main() {
  const shopeeService = require('./src/services/shopeeService');
  shopeeService.getActiveSession = async () => ({
    storeId: 'store-test',
    storeName: 'Test Store',
    cookieString: 'SPC_CDS=test-csrf',
    userAgent: 'test-agent',
  });
  prisma.shopeeProduct.findMany = async () => [];

  const result = await shopeeService.fetchProductPerformance({
    period: 'past7days',
    pageSize: 10,
    pageNum: 2,
    orderBy: 'confirmed_sales.desc',
    storeId: 'store-test',
  });

  const expectedSales = allItems.reduce((sum, item) => sum + item.confirmed_sales, 0);
  const checks = [
    ['live response is used', result.dataSource === 'SHOPEE_API'],
    ['all products are counted', result.total === 120],
    ['requested page remains page 2', result.pagination.page === 2 && result.products.length === 10],
    ['rank continues from page 2', result.products[0]?.rank === 11],
    ['summary sales uses all pages', result.summary.totalSales === expectedSales],
    ['summary orders uses all pages', result.summary.totalOrders === 120],
    ['summary units uses all pages', result.summary.totalUnits === 240],
    ['summary visitors uses all pages', result.summary.totalVisitors === 600],
    ['summary views uses all pages', result.summary.totalViews === 1200],
    ['conversion is calculated from full aggregate', result.summary.averageConversionRate === 20],
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
    shopeeHttp.shopeeRequest = originalRequest;
    prisma.shopeeProduct.findMany = originalCatalogFindMany;
    prisma.$disconnect().catch(() => {});
  });
