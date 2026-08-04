/**
 * Generates custom HTTP headers for querying Shopee Seller Center internal endpoints
 */
function getShopeeHeaders(cookieString, csrfToken = '', userAgent = '') {
  const defaultUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  // cookie.parse decodes values once, preventing double URL encoding in requests.
  const parsed = parseCookieValues(cookieString);
  const extractedCsrf = parsed.SPC_CDS || parsed.CTOKEN || parsed.shopee_csrf_token || csrfToken;

  return {
    'Cookie': cookieString,
    'User-Agent': userAgent || defaultUA,
    'x-shopee-csrf-token': extractedCsrf,
    'x-csrf-token': extractedCsrf,
    'x-csrftoken': extractedCsrf,
    'Referer': 'https://seller.shopee.co.id/datacenter/product/performance',
    'Origin': 'https://seller.shopee.co.id',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'X-Requested-With': 'XMLHttpRequest'
  };
}

/**
 * Extracts CSRF token from cookie string if present
 */
function extractCsrfFromCookie(cookieString) {
  const parsed = parseCookieValues(cookieString);
  return parsed.SPC_CDS || parsed.CTOKEN || parsed.shopee_csrf_token || '';
}

function extractCatalogCsrfFromCookie(cookieString) {
  return parseCookieValues(cookieString).SPC_CDS || '';
}

module.exports = { getShopeeHeaders, extractCsrfFromCookie, extractCatalogCsrfFromCookie };
const cookie = require('cookie');

function parseCookieValues(cookieString) {
  if (!cookieString || typeof cookieString !== 'string') return {};

  try {
    return cookie.parse(cookieString);
  } catch {
    return {};
  }
}
