/*
 * Read-only diagnostic for the exact Seller Center endpoint used by
 * /shopee/performance. It intentionally prints metadata and selected values
 * only; never print cookies, CSRF tokens, or database credentials.
 */
require('dotenv').config();

const { shopeeRequest } = require('./src/utils/shopeeHttp');
const { extractCsrfFromCookie, getShopeeHeaders } = require('./src/utils/headerGenerator');
const shopeeService = require('./src/services/shopeeService');

const ENDPOINT = 'https://seller.shopee.co.id/api/mydata/v4/product/performance/';
const PERIODS = ['past7days', 'past30days'];

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function selectedFields(value) {
  if (!value || typeof value !== 'object') return value;
  const keys = [
    'item_id', 'itemid', 'id', 'item_name', 'name',
    'confirmed_sales', 'sales', 'gmv',
    'confirmed_order', 'confirmed_orders', 'orders',
    'confirmed_units', 'confirmed_unit_num', 'units_sold', 'item_sold',
    'confirmed_buyers', 'buyers',
    'pv', 'item_views', 'views', 'impressions',
    'uv', 'item_uv', 'unique_visitors',
    'conversion_rate', 'confirmed_order_conversion_rate',
    'add_to_cart_units', 'uv_to_add_to_cart_rate',
  ];
  return Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(value, key)).map((key) => [key, value[key]]));
}

function getJakartaDayStart() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return Math.floor(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), -7, 0, 0) / 1000);
}

async function main() {
  const session = await shopeeService.getActiveSession(null);
  if (!session?.cookieString || !session?.storeId) {
    throw new Error('Tidak ada sesi Shopee aktif.');
  }

  const csrfToken = extractCsrfFromCookie(session.cookieString);
  if (!csrfToken) throw new Error('Sesi tidak memiliki token CSRF.');

  const currentDayStart = getJakartaDayStart();
  const oneDay = 86400;
  const output = { endpoint: ENDPOINT, storeIdPresent: Boolean(session.storeId), periods: {} };

  for (const period of PERIODS) {
    const days = period === 'past7days' ? 7 : 30;
    const startTime = currentDayStart - (days * oneDay);
    const endTime = currentDayStart - 1;
    const queryParams = new URLSearchParams({
      SPC_CDS: csrfToken,
      SPC_CDS_VER: '2',
      start_time: String(startTime),
      end_time: String(endTime),
      period,
      keyword: '',
      category_type: 'shopee',
      category_id: '-1',
      page_size: '10',
      page_num: '1',
      order_type: 'confirmed',
      order_by: 'confirmed_sales.desc',
    });

    const response = await shopeeRequest({
      method: 'get',
      url: `${ENDPOINT}?${queryParams.toString()}`,
      headers: {
        ...getShopeeHeaders(session.cookieString, csrfToken, session.userAgent),
        Referer: 'https://seller.shopee.co.id/portal/datacenter/product/performance',
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    const envelope = response.data || {};
    const container = envelope.data || envelope.result || {};
    const list = Array.isArray(container.items)
      ? container.items
      : (Array.isArray(container.list) ? container.list : (Array.isArray(container.products) ? container.products : []));
    const summary = container.summary && typeof container.summary === 'object' ? container.summary : null;

    output.periods[period] = {
      request: { period, startTime, endTime, pageSize: 10, pageNum: 1, orderType: 'confirmed', orderBy: 'confirmed_sales.desc' },
      envelopeKeys: Object.keys(envelope),
      dataKeys: Object.keys(container),
      code: envelope.code ?? null,
      total: safeNumber(container.total ?? container.total_count),
      pagination: {
        page: safeNumber(container.page ?? container.page_num),
        pageSize: safeNumber(container.page_size ?? container.pageSize),
        totalPages: safeNumber(container.total_pages ?? container.totalPages),
      },
      summaryKeys: summary ? Object.keys(summary) : [],
      summary,
      returnedItems: list.length,
      firstItems: list.slice(0, 3).map(selectedFields),
    };
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
