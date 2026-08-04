const cookie = require('cookie');

/**
 * Parses raw cookie string from Shopee Seller Center
 * @param {string} cookieString 
 * @returns {object} parsed cookies & token analysis
 */
function parseShopeeCookie(cookieString) {
  if (!cookieString || typeof cookieString !== 'string') {
    return { isValid: false, cookies: {}, missingTokens: ['SPC_EC', 'SPC_ST'] };
  }

  try {
    const parsed = cookie.parse(cookieString);
    const sessionToken = parsed.SPC_ST || parsed.SPC_STK || parsed.SPC_SC_SESSION;
    const storeId = parsed.SPC_U || parsed.SPC_SI || '';
    const catalogCsrfToken = parsed.SPC_CDS || '';
    const csrfToken = catalogCsrfToken || parsed.CTOKEN || parsed.shopee_csrf_token || '';
    const missingTokens = [
      !sessionToken && 'SPC_ST, SPC_STK, or SPC_SC_SESSION',
      !storeId && 'SPC_U or SPC_SI',
      !csrfToken && 'SPC_CDS, CTOKEN, or shopee_csrf_token',
    ].filter(Boolean);

    return {
      isValid: missingTokens.length === 0,
      cookies: parsed,
      missingTokens,
      storeId,
      csrfToken,
      hasCsrfToken: Boolean(csrfToken),
      raw: cookieString.trim()
    };
  } catch (err) {
    return {
      isValid: false,
      error: err.message,
      cookies: {},
      missingTokens: ['SPC_EC', 'SPC_ST']
    };
  }
}

module.exports = { parseShopeeCookie };
