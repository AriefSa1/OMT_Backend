const axios = require('axios');
const shopeeService = require('./shopeeService');
const { extractCsrfFromCookie, getShopeeHeaders } = require('../utils/headerGenerator');

class ShopeeInsightsService {
  asNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  async request(path, parameters = {}) {
    const session = await shopeeService.getActiveSession();
    const cookie = session?.cookieString || '';
    const csrfToken = extractCsrfFromCookie(cookie);
    if (!cookie || !csrfToken) throw new Error('A valid Shopee session is required for marketplace intelligence.');

    const params = new URLSearchParams({ SPC_CDS: csrfToken, SPC_CDS_VER: '2', ...parameters });
    const response = await axios.get(`https://seller.shopee.co.id${path}?${params}`, {
      timeout: 10000,
      headers: getShopeeHeaders(cookie, csrfToken, session.userAgent),
    });
    return response.data;
  }

  extractList(payload) {
    const data = payload?.data ?? payload?.result ?? payload ?? {};
    if (Array.isArray(data)) return data;
    return data.list || data.items || data.products || [];
  }

  async getMarketplaceInsights({ campaignIds = [] } = {}) {
    const now = Math.floor(Date.now() / 1000);
    try {
      const performancePayload = await this.request('/api/mydata/v4/product/performance/', {
        start_time: String(now - 3600), end_time: String(now), period: 'real_time', keyword: '',
        category_type: 'shopee', category_id: '-1', page_size: '50', page_num: '1',
        order_type: 'confirmed', order_by: 'confirmed_sales.desc',
      });
      const normalizedCampaignIds = campaignIds.map(String).map((id) => id.trim()).filter(Boolean);
      const adsPayload = normalizedCampaignIds.length
        ? await this.request('/api/pas/v1/todo/daily_budget/check_campaign_list/', {
          campaign_ids: normalizedCampaignIds.join(','),
        })
        : null;
      return {
        source: 'SHOPEE_API',
        message: null,
        productPerformance: this.extractList(performancePayload),
        activeAdCampaigns: adsPayload ? this.extractList(adsPayload) : [],
        adsMonitor: {
          status: adsPayload ? 'LOADED' : 'INPUT_REQUIRED',
          message: adsPayload ? null : 'Enter campaign IDs to check daily advertising budgets.',
          checkedCampaignIds: normalizedCampaignIds.length,
        },
        productSignals: this.buildProductSignals(this.extractList(performancePayload)),
      };
    } catch (err) {
      const status = err.response?.status;
      return {
        source: 'EMPTY',
        message: status === 401 || status === 403
          ? 'Seller Center rejected the current session for marketplace intelligence.'
          : status ? `Shopee marketplace intelligence returned HTTP ${status}.` : err.message,
        productPerformance: [],
        activeAdCampaigns: [],
        adsMonitor: {
          status: 'UNAVAILABLE',
          message: 'Shopee campaign monitor is unavailable.',
          checkedCampaignIds: 0,
        },
        productSignals: [],
      };
    }
  }

  buildProductSignals(products) {
    const signals = [];
    for (const product of products) {
      const id = String(product.id || product.name || 'unknown');
      const impressions = this.asNumber(product.product_card_impressions);
      const ctr = this.asNumber(product.ctr);
      const addToCart = this.asNumber(product.add_to_cart_buyers);
      const confirmedOrders = this.asNumber(product.confirmed_orders);
      const bounceRate = this.asNumber(product.bounce_rate);

      if (impressions >= 100 && ctr > 0 && ctr < 1) {
        signals.push({
          id: `SHOPEE-CTR-${id}`,
          sku: '', productName: product.name || '', type: 'LOW_CLICK_THROUGH_RATE', severity: 'MEDIUM',
          impact: `${impressions} impressions with ${ctr}% CTR.`,
          actionText: 'Improve primary image, title keywords, and price visibility.',
        });
      }
      if (addToCart > 0 && confirmedOrders === 0) {
        signals.push({
          id: `SHOPEE-CONVERSION-${id}`,
          sku: '', productName: product.name || '', type: 'CART_TO_ORDER_GAP', severity: 'HIGH',
          impact: `${addToCart} buyers added this product to cart with no confirmed order.`,
          actionText: 'Review shipping promise, voucher eligibility, and final checkout price.',
        });
      }
      if (bounceRate >= 60) {
        signals.push({
          id: `SHOPEE-BOUNCE-${id}`,
          sku: '', productName: product.name || '', type: 'HIGH_BOUNCE_RATE', severity: 'MEDIUM',
          impact: `${bounceRate}% bounce rate on the product card.`,
          actionText: 'Align thumbnail, title, and product details with search intent.',
        });
      }
    }
    return signals.slice(0, 30);
  }

  async getCompetitorProducts({ itemId, l2CategoryId, l3CategoryId }) {
    if (!itemId || !l2CategoryId || !l3CategoryId) {
      return { source: 'EMPTY', message: 'itemId, l2CategoryId, and l3CategoryId are required.', products: [] };
    }
    try {
      const payload = await this.request('/api/mydata/v4/seller-coach/seller-competing-products/', {
        itemid: String(itemId), l2catid: String(l2CategoryId), l3catid: String(l3CategoryId),
      });
      return { source: 'SHOPEE_API', message: null, products: this.extractList(payload) };
    } catch (err) {
      return { source: 'EMPTY', message: `Competitor data could not be loaded${err.response?.status ? ` (HTTP ${err.response.status})` : ''}.`, products: [] };
    }
  }
}

module.exports = new ShopeeInsightsService();
