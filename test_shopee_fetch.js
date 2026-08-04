const axios = require('axios');
const { extractCsrfFromCookie, getShopeeHeaders } = require('./src/utils/headerGenerator');

async function testFetch() {
  const rawCookie = process.env.SHOPEE_TEST_COOKIE;
  const csrfToken = extractCsrfFromCookie(rawCookie);
  if (!rawCookie || !csrfToken) {
    throw new Error('Set SHOPEE_TEST_COOKIE to a current Seller Center Cookie header that includes CTOKEN or SPC_CDS.');
  }

  const query = new URLSearchParams({ SPC_CDS: csrfToken, SPC_CDS_VER: '2', page_size: '1', list_type: 'live_all' });
  const response = await axios.get(`https://seller.shopee.co.id/api/v3/opt/mpsku/list/v2/search_product_list?${query}`, {
    headers: { ...getShopeeHeaders(rawCookie, csrfToken), Referer: 'https://seller.shopee.co.id/portal/product/list/all' },
    timeout: 10000,
  });

  console.log(JSON.stringify({ status: response.status, code: response.data?.code, productCount: response.data?.data?.products?.length || 0 }));
}

testFetch().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
