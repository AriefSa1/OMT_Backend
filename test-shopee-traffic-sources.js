/** Regression: traffic-source responses expose the resolved span without a stale variable. */
const shopeeHttp = require('./src/utils/shopeeHttp');

const originalRequest = shopeeHttp.shopeeRequest;
shopeeHttp.shopeeRequest = async () => ({
  data: {
    code: 0,
    result: {
      overview: {
        total_sales: 1000,
        product_card: 600,
        product_card_ratio: 0.6,
        product_card_pct_diff: 0.1,
        paid_ads: 400,
        paid_ads_ratio: 0.4,
        paid_ads_pct_diff: -0.05,
      },
    },
  },
});

async function main() {
  const service = require('./src/services/shopeeService');
  service.getActiveSession = async () => ({ storeId: 'store-test', userAgent: 'test-agent' });
  service._resolveCookie = async () => 'SPC_CDS=test-csrf';

  const result = await service.fetchTrafficSources({ days: 7, storeId: 'store-test' });
  const checks = [
    ['returns the live source', result.source === 'SHOPEE_API'],
    ['returns the resolved day span', result.days === 7],
    ['keeps measured channels', result.channels.length === 2],
    ['keeps Shopee ratios as fractions', result.channels[0].ratio === 0.6],
  ];
  const passed = checks.filter(([label, ok]) => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}`);
    return ok;
  }).length;
  console.log(`\n=== ${passed}/${checks.length} checks passed ===`);
  process.exitCode = passed === checks.length ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    shopeeHttp.shopeeRequest = originalRequest;
  });
