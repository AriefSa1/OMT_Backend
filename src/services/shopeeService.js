const axios = require('axios');
const prisma = require('../utils/prisma');
const configService = require('./configService');
const { extractCsrfFromCookie, extractCatalogCsrfFromCookie, getShopeeHeaders } = require('../utils/headerGenerator');

let activeCookie = '';
let cachedNormalizedProducts = [];
const SHOPEE_HOMEPAGE_ADS_ENDPOINT = 'https://seller.shopee.co.id/api/pas/v1/homepage/query/';
const ADS_AMOUNT_DIVISOR = 100000;

function asFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeRatePercent(value, fallback = 0) {
  const rate = asFiniteNumber(value);
  if (!rate && fallback) return fallback;
  return rate > 0 && rate <= 1 ? rate * 100 : rate;
}

function findCategoryPath(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return [];
  for (const [key, candidate] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (Array.isArray(candidate) && /categor(y|ies).*(path|list)|cat.*path/.test(normalizedKey)) {
      return candidate.filter((item) => item && typeof item === 'object');
    }
  }
  for (const candidate of Object.values(value)) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const path = findCategoryPath(candidate, depth + 1);
      if (path.length) return path;
    }
  }
  return [];
}

function categoryId(category) {
  const value = category?.id ?? category?.category_id ?? category?.catid ?? null;
  return value === null || value === undefined || value === '' ? null : String(value);
}

function getJakartaDayRange() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  // Homepage Ads accepts a complete Jakarta calendar day, not a partial live range.
  const currentDayStart = Math.floor(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), -7, 0, 0) / 1000);
  const startTime = currentDayStart - (24 * 60 * 60);
  return { startTime, endTime: currentDayStart - 1 };
}

function emptyShopeeState(message = 'Connect your Shopee store in Settings to view real data.', errorCode = 'NOT_CONNECTED') {
  return {
    success: true,
    live: false,
    isRealDataActive: false,
    dataSource: 'EMPTY',
    errorCode,
    message,
    storeName: '',
    storeId: '',
    summary: {
      todayGmv: 0,
      todayOrders: 0,
      conversionRate: 0,
      averageOrderValue: 0,
      activeProductsCount: 0,
      pendingFulfillments: 0,
    },
    products: [],
  };
}

class ShopeeService {
  setCookie(cookie) {
    activeCookie = cookie || '';
    console.log(`[Shopee Service] Active store cookie ${activeCookie ? 'updated' : 'cleared'}.`);
  }

  async getActiveSession() {
    const session = await prisma.storeSession.findFirst({
      where: { isActive: true },
      orderBy: { updatedAt: 'desc' },
    });

    if (session?.cookieString && !activeCookie) {
      activeCookie = session.cookieString;
    }

    return session;
  }

  async saveSession({ storeName, storeId, cookieString, userAgent, csrfToken, isActive = true }) {
    await prisma.storeSession.updateMany({ data: { isActive: false } });

    const session = await prisma.storeSession.upsert({
      where: { storeId },
      update: {
        storeName,
        cookieString,
        userAgent,
        csrfToken,
        isActive,
        lastSyncedAt: new Date(),
      },
      create: {
        storeName,
        storeId,
        cookieString,
        userAgent,
        csrfToken,
        isActive,
      },
    });

    this.setCookie(cookieString);
    return session;
  }

  async persistProducts(storeId, products) {
    await prisma.$transaction(
      products.map((product) =>
        prisma.shopeeProduct.upsert({
          where: { shopeeItemId: product.shopeeItemId },
          update: {
            storeId,
            name: product.name || '',
            sku: product.sku || '',
            price: Number(product.price || 0),
            stock: Number(product.stock || 0),
            salesCount: Number(product.salesCount || 0),
            views: Number(product.views || 0),
            addToCart: Number(product.addToCart || 0),
            category: product.category || 'Uncategorized',
            ...(product.l2CategoryId ? { l2CategoryId: product.l2CategoryId } : {}),
            ...(product.l3CategoryId ? { l3CategoryId: product.l3CategoryId } : {}),
            ...(product.l2CategoryName ? { l2CategoryName: product.l2CategoryName } : {}),
            ...(product.l3CategoryName ? { l3CategoryName: product.l3CategoryName } : {}),
            imageUrl: product.imageUrl || null,
            rating: Number(product.rating || 0),
          },
          create: {
            storeId,
            shopeeItemId: product.shopeeItemId,
            name: product.name || '',
            sku: product.sku || '',
            price: Number(product.price || 0),
            stock: Number(product.stock || 0),
            salesCount: Number(product.salesCount || 0),
            views: Number(product.views || 0),
            addToCart: Number(product.addToCart || 0),
            category: product.category || 'Uncategorized',
            l2CategoryId: product.l2CategoryId || null,
            l3CategoryId: product.l3CategoryId || null,
            l2CategoryName: product.l2CategoryName || null,
            l3CategoryName: product.l3CategoryName || null,
            imageUrl: product.imageUrl || null,
            rating: Number(product.rating || 0),
          },
        })
      )
    );
  }

  async persistOrderSummary(storeId, summary) {
    const today = new Date().toISOString().slice(0, 10);
    await prisma.shopeeOrderSummary.upsert({
      where: { storeId_date: { storeId, date: today } },
      update: {
        gmv: summary.todayGmv,
        orderCount: summary.todayOrders,
        conversionRate: summary.conversionRate,
        averageOrderValue: summary.averageOrderValue,
      },
      create: {
        storeId,
        date: today,
        gmv: summary.todayGmv,
        orderCount: summary.todayOrders,
        conversionRate: summary.conversionRate,
        averageOrderValue: summary.averageOrderValue,
      },
    });
  }

  async fetchOrderSummary(cookie, session) {
    const config = await configService.getAll();
    if (!config.shopeeOrderSummaryUrl) return null;

    const response = await axios.get(config.shopeeOrderSummaryUrl, {
      headers: getShopeeHeaders(cookie, session?.csrfToken, session?.userAgent),
      timeout: 10000,
    });
    const data = response.data?.data || response.data || {};
    const gmv = Number(data.gmv ?? data.total_gmv ?? data.sales ?? 0);
    const orderCount = Number(data.orderCount ?? data.order_count ?? data.orders ?? 0);
    const conversionRate = Number(data.conversionRate ?? data.conversion_rate ?? 0);
    const averageOrderValue = Number(data.averageOrderValue ?? data.average_order_value ?? (orderCount ? gmv / orderCount : 0));

    if (!Number.isFinite(gmv) || !Number.isFinite(orderCount)) return null;
    return { todayGmv: gmv, todayOrders: orderCount, conversionRate, averageOrderValue };
  }

  async fetchLiveShopeeMetrics(customCookie = '') {
    const session = await this.getActiveSession();
    const cookie = customCookie || activeCookie || session?.cookieString || '';

    if (!cookie) {
      return emptyShopeeState();
    }

    const csrfToken = extractCsrfFromCookie(cookie);
    const catalogCsrfToken = extractCatalogCsrfFromCookie(cookie) || csrfToken;
    if (!catalogCsrfToken) {
      return emptyShopeeState(
        'The Shopee cookie is missing a CSRF token. Include CTOKEN or SPC_CDS and try again.',
        'MISSING_CSRF_TOKEN'
      );
    }
    const searchParams = new URLSearchParams({
      SPC_CDS: catalogCsrfToken,
      SPC_CDS_VER: '2',
      page_size: '48',
      list_type: 'live_all',
      request_attribute: '',
      operation_sort_by: 'recommend_v4',
      need_ads: 'true',
    });
    const searchProductUrl = `https://seller.shopee.co.id/api/v3/opt/mpsku/list/v2/search_product_list?${searchParams.toString()}`;

    try {
      const headers = {
        ...getShopeeHeaders(cookie, catalogCsrfToken, session?.userAgent),
        Referer: 'https://seller.shopee.co.id/portal/product/list/all',
      };

      const res = await axios.get(searchProductUrl, { headers, timeout: 10000 });

      if (!res.data || res.data.code !== 0 || !Array.isArray(res.data.data?.products)) {
        return emptyShopeeState('Shopee returned no product data. Check the cookie in Settings.');
      }

      const rawProducts = res.data.data.products;
      const normalizedProducts = rawProducts
        .filter((item) => item.id !== undefined && item.id !== null)
        .map((item) => {
        const categoryPath = Array.isArray(item.category_path) ? item.category_path : findCategoryPath(item);
        const l2Category = categoryPath[1] || categoryPath[0] || null;
        const l3Category = categoryPath[2] || categoryPath[1] || null;
        const priceMin = parseFloat(item.price_detail?.price_min || item.price_detail?.origin_price || 0);
        const displayPrice = Math.round(priceMin);
        const stock = item.stock_detail?.total_available_stock || item.stock_detail?.total_seller_stock || 0;
        const sold = item.statistics?.sold_count || item.sales || 0;
        const imageUrl = item.cover_image
          ? item.cover_image.startsWith('http')
            ? item.cover_image
            : `https://down-id.img.susercontent.com/file/${item.cover_image}`
          : null;

        return {
          shopeeItemId: String(item.id),
          name: item.name || '',
          sku: String(item.parent_sku || item.id),
          price: displayPrice,
          stock,
          salesCount: sold,
          views: item.statistics?.view_count || 0,
          addToCart: item.statistics?.add_to_cart_count || 0,
          category: categoryPath[0]?.display_name || item.category_name || 'Uncategorized',
          l2CategoryId: categoryId(l2Category),
          l3CategoryId: categoryId(l3Category),
          l2CategoryName: l2Category?.display_name || l2Category?.name || null,
          l3CategoryName: l3Category?.display_name || l3Category?.name || null,
          imageUrl,
          rating: Number(item.statistics?.rating_star || 0),
          variations: Array.isArray(item.model_list)
            ? item.model_list.map((model, modelIdx) => ({
                id: String(model.id || ''),
                name: model.name || '',
                sku: model.sku || '',
                stock: model.stock_detail?.total_available_stock || model.stock_detail?.total_seller_stock || 0,
                soldCount: model.statistics?.sold_count || 0,
              }))
            : [],
        };
      });

      if (!session?.storeId) {
        return emptyShopeeState('No active Shopee store session was found. Save a valid cookie in Settings.');
      }

      const storeId = session.storeId;
      const orderSummary = await this.fetchOrderSummary(cookie, session).catch((err) => {
        console.warn('[Shopee Service] Order summary API unavailable:', err.message);
        return null;
      });
      const summary = {
        todayGmv: orderSummary?.todayGmv || 0,
        todayOrders: orderSummary?.todayOrders || 0,
        conversionRate: orderSummary?.conversionRate || 0,
        averageOrderValue: orderSummary?.averageOrderValue || 0,
        activeProductsCount: res.data.data.page_info?.total || normalizedProducts.length,
        pendingFulfillments: 0,
      };

      cachedNormalizedProducts = normalizedProducts;
      await this.persistProducts(storeId, normalizedProducts);
      if (orderSummary) await this.persistOrderSummary(storeId, summary);
      await prisma.storeSession.updateMany({
        where: { storeId },
        data: { lastSyncedAt: new Date(), csrfToken },
      });

      return {
        success: true,
        live: true,
        isRealDataActive: true,
        dataSource: 'LIVE',
        storeName: session?.storeName || 'Shopee Store',
        storeId,
        summary,
        products: normalizedProducts,
        message: orderSummary ? null : 'Product catalog synchronized. Configure an order summary endpoint to collect sales trends.',
      };
    } catch (err) {
      const status = err.response?.status;
      const code = err.code;
      console.warn('[Shopee Service] Catalog sync failed.', { status, code });

      if (status === 401 || status === 403) {
        return emptyShopeeState(
          'Seller Center rejected this session. Refresh the complete Cookie header with CTOKEN (and SPC_CDS when the browser provides it), then sync again.',
          'SESSION_REJECTED'
        );
      }
      if (status === 404 || status === 410) {
        return emptyShopeeState(
          'The Seller Center catalog endpoint is unavailable. Check the integration configuration and try again later.',
          'ENDPOINT_UNAVAILABLE'
        );
      }
      if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
        return emptyShopeeState('The Seller Center request timed out. Check your connection and try again.', 'REQUEST_TIMEOUT');
      }

      return emptyShopeeState(
        status ? `Seller Center returned HTTP ${status}; the session could not be validated.` : 'Seller Center could not be reached. Check your connection and try again.',
        status ? `HTTP_${status}` : 'NETWORK_ERROR'
      );
    }
  }

  async getProductById(itemId) {
    const cached = cachedNormalizedProducts.find((product) => product.shopeeItemId === String(itemId));
    if (cached) return cached;

    const product = await prisma.shopeeProduct.findUnique({ where: { shopeeItemId: String(itemId) } });
    return product || null;
  }

  async fetchShopeeAdsMetrics() {
    const session = await this.getActiveSession();
    if (!session?.cookieString || !session?.storeId) {
      return {
        success: false,
        dataSource: 'EMPTY',
        message: 'Hubungkan sesi Shopee terlebih dahulu sebelum menyinkronkan iklan.',
        topCampaigns: [],
      };
    }

    try {
      const csrfToken = extractCsrfFromCookie(session.cookieString);
      if (!csrfToken) throw new Error('Sesi Shopee aktif tidak memiliki token CSRF.');
      const { startTime, endTime } = getJakartaDayRange();
      const query = new URLSearchParams({ SPC_CDS: csrfToken, SPC_CDS_VER: '2' });
      const response = await axios.post(`${SHOPEE_HOMEPAGE_ADS_ENDPOINT}?${query}`, {
        start_time: startTime,
        end_time: endTime,
        filter_list: [{
          campaign_type: 'product_homepage_v3',
          state: 'ongoing',
          search_term: '',
          is_valid_rebate_only: false,
        }],
        offset: 0,
        limit: 50,
        use_paid_gmv: false,
      }, {
        headers: {
          ...getShopeeHeaders(session.cookieString, csrfToken, session.userAgent),
          Referer: 'https://seller.shopee.co.id/portal/marketing/ads/homepage',
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });
      const envelope = response.data || {};
      if (envelope.code !== 0) throw new Error(envelope.msg || 'Shopee Ads mengembalikan respons yang tidak valid.');
      const rawCampaigns = Array.isArray(envelope.data?.entry_list) ? envelope.data.entry_list : [];
      const campaigns = rawCampaigns.map((campaign) => {
        const report = campaign.report || {};
        const rawSpend = asFiniteNumber(report.cost);
        const rawSales = asFiniteNumber(report.broad_gmv ?? report.direct_gmv);
        const rawVoucherSpend = asFiniteNumber(report.voucher_amount);
        const rawVoucherSales = asFiniteNumber(report.voucher_sales);
        const rawDailyBudget = asFiniteNumber(campaign.campaign?.daily_budget);
        const impressions = asFiniteNumber(report.impression ?? report.product_impression);
        const clicks = asFiniteNumber(report.click ?? report.product_click);
        return {
          id: String(campaign.campaign?.campaign_id || campaign.id || ''),
          name: campaign.title || campaign.name || String(campaign.campaign?.campaign_id || ''),
          type: campaign.type || campaign.subtype || 'Shopee Ads',
          state: campaign.state || 'ongoing',
          rawDailyBudget,
          rawSpend,
          rawSales,
          rawVoucherSpend,
          rawVoucherSales,
          amountDivisor: ADS_AMOUNT_DIVISOR,
          dailyBudget: rawDailyBudget / ADS_AMOUNT_DIVISOR,
          spend: rawSpend / ADS_AMOUNT_DIVISOR,
          sales: rawSales / ADS_AMOUNT_DIVISOR,
          voucherSpend: rawVoucherSpend / ADS_AMOUNT_DIVISOR,
          voucherSales: rawVoucherSales / ADS_AMOUNT_DIVISOR,
          impressions,
          clicks,
          roas: asFiniteNumber(report.broad_roi ?? (rawSpend > 0 ? rawSales / rawSpend : 0)),
          ctr: normalizeRatePercent(report.ctr, impressions > 0 ? (clicks / impressions) * 100 : 0),
        };
      }).filter((campaign) => campaign.id && campaign.name);

      const totals = campaigns.reduce((acc, campaign) => ({
        rawSpend: acc.rawSpend + campaign.rawSpend,
        rawSales: acc.rawSales + campaign.rawSales,
        rawVoucherSpend: acc.rawVoucherSpend + campaign.rawVoucherSpend,
        rawVoucherSales: acc.rawVoucherSales + campaign.rawVoucherSales,
        impressions: acc.impressions + campaign.impressions,
        clicks: acc.clicks + campaign.clicks,
      }), { rawSpend: 0, rawSales: 0, rawVoucherSpend: 0, rawVoucherSales: 0, impressions: 0, clicks: 0 });
      const spend = totals.rawSpend / ADS_AMOUNT_DIVISOR;
      const sales = totals.rawSales / ADS_AMOUNT_DIVISOR;

      return {
        success: true,
        storeId: session.storeId,
        totalSpend: spend,
        totalSalesGenerated: sales,
        roas: totals.rawSpend > 0 ? totals.rawSales / totals.rawSpend : 0,
        impressions: totals.impressions,
        clicks: totals.clicks,
        ctr: totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0,
        voucherSpend: totals.rawVoucherSpend / ADS_AMOUNT_DIVISOR,
        voucherSales: totals.rawVoucherSales / ADS_AMOUNT_DIVISOR,
        rawSpend: totals.rawSpend,
        rawSales: totals.rawSales,
        rawVoucherSpend: totals.rawVoucherSpend,
        rawVoucherSales: totals.rawVoucherSales,
        amountDivisor: ADS_AMOUNT_DIVISOR,
        topCampaigns: campaigns,
        dataSource: 'SHOPEE_API',
        message: campaigns.length ? null : 'Tidak ada kampanye Product Ads aktif pada periode ini.',
        period: { startTime, endTime },
      };
    } catch (err) {
      const status = err.response?.status;
      console.warn('[Shopee Service] Ads sync failed.', { status, code: err.code });
      return {
        success: false,
        dataSource: 'EMPTY',
        message: status === 401 || status === 403
          ? 'Seller Center menolak sesi iklan. Perbarui cookie lalu jalankan Sync lagi.'
          : status ? `Shopee Ads mengembalikan HTTP ${status}.` : 'Shopee Ads tidak dapat dihubungi.',
        topCampaigns: [],
      };
    }
  }
}

module.exports = new ShopeeService();
