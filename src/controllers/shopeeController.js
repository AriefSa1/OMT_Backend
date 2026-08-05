const { parseShopeeCookie } = require('../utils/cookieParser');
const shopeeService = require('../services/shopeeService');
const configService = require('../services/configService');
const snapshotService = require('../services/snapshotService');
const syncService = require('../services/syncService');
const prisma = require('../utils/prisma');
const { wrapHandlers } = require('../utils/asyncHandler');

function toPublicAnalysis(analysis) {
  return {
    isValid: analysis.isValid,
    missingTokens: analysis.missingTokens || [],
    storeId: analysis.storeId || '',
    hasCsrfToken: Boolean(analysis.hasCsrfToken),
  };
}

function toPublicSession(session) {
  if (!session) return null;
  return {
    storeName: session.storeName,
    storeId: session.storeId,
    isActive: session.isActive,
    cookieConfigured: Boolean(session.cookieString),
    csrfConfigured: Boolean(session.csrfToken),
    lastSyncedAt: session.lastSyncedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

async function parseCookie(req, res) {
  const { rawCookie, storeName } = req.body;
  const analysis = parseShopeeCookie(rawCookie || '');
  if (!rawCookie) return res.status(400).json({ success: false, error: 'Cookie Shopee wajib diisi.' });
  if (!analysis.hasCsrfToken) {
    return res.status(400).json({
      success: false,
      error: 'Cookie tidak memiliki token CSRF (CTOKEN atau SPC_CDS).',
      analysis: toPublicAnalysis(analysis),
    });
  }
  if (!analysis.storeId) {
    return res.status(400).json({
      success: false,
      error: 'Cookie tidak memiliki identitas toko (SPC_U atau SPC_SI).',
      analysis: toPublicAnalysis(analysis),
    });
  }

  const session = await shopeeService.saveSession({
    storeName: storeName?.trim() || 'Toko Shopee',
    storeId: analysis.storeId,
    cookieString: rawCookie,
    userAgent: req.get('user-agent') || '',
    csrfToken: analysis.csrfToken || null,
    isActive: true,
  });
  await configService.setMany({ storeName: session.storeName, cookieString: rawCookie });
  const sync = await syncService.syncShopee({ origin: 'CONNECT' });
  return res.json({
    success: sync.success,
    analysis: toPublicAnalysis(analysis),
    session: toPublicSession(session),
    sync,
    message: sync.message,
  });
}

async function getSessionStatus(req, res) {
  const session = await shopeeService.getActiveSession();
  return res.json({
    success: true,
    session: toPublicSession(session) || {
      storeName: '', storeId: '', cookieConfigured: false, csrfConfigured: false, lastSyncedAt: null,
    },
  });
}

async function getShopeeMetrics(req, res) {
  const snapshot = await snapshotService.getCatalogSnapshot(req.query);
  return res.json({
    success: true,
    products: snapshot.products,
    filters: snapshot.filters,
    pagination: snapshot.pagination,
    meta: snapshot.meta,
    dataSource: snapshot.meta.source,
    dataAsOf: snapshot.meta.dataAsOf,
    message: snapshot.meta.message,
  });
}

async function getProductDetail(req, res) {
  const snapshot = await snapshotService.getProductSnapshot(req.params.id);
  if (!snapshot) return res.status(404).json({ success: false, message: 'Produk tidak ditemukan pada snapshot katalog.' });
  return res.json({ success: true, ...snapshot });
}

async function updateProductEconomics(req, res) {
  const { id } = req.params;
  const keys = ['unitCost', 'unitAdCost', 'shippingCost', 'platformFeePercent'];
  const data = Object.fromEntries(keys.filter((key) => req.body[key] !== undefined).map((key) => {
    const value = req.body[key];
    return [key, value === null || value === '' ? null : Number(value)];
  }));
  if (Object.values(data).some((value) => value !== null && !Number.isFinite(value))) {
    return res.status(400).json({ success: false, error: 'Nilai ekonomi produk harus berupa angka.' });
  }
  const product = await prisma.shopeeProduct.update({ where: { shopeeItemId: String(id) }, data });
  return res.json({ success: true, product });
}

async function getShopeeAds(req, res) {
  const {
    period = 'real_time',
    start_time,
    end_time,
    sort_by = 'spend',
    direction = 'desc',
    force_snapshot = 'false',
  } = req.query;

  const sortBy = sort_by;
  const ascending = direction === 'asc';

  if (force_snapshot !== 'true') {
    try {
      const liveData = await shopeeService.fetchShopeeAdsMetrics({
        period,
        startTime: start_time,
        endTime: end_time,
      });

      if (liveData.success && liveData.dataSource === 'SHOPEE_API') {
        if (period === 'real_time' || period === 'today') {
          syncService.persistAdsSnapshot(liveData).catch((err) => {
            console.warn('[ShopeeController] Failed to persist background ads snapshot:', err.message);
          });
        }

        const sortFields = {
          name: 'name',
          state: 'state',
          dailyBudget: 'dailyBudget',
          spend: 'spend',
          sales: 'sales',
          ctr: 'ctr',
          roas: 'roas',
        };
        const sortField = sortFields[sortBy] || 'spend';
        const sortedCampaigns = [...(liveData.topCampaigns || [])].sort((left, right) => {
          const leftValue = typeof left[sortField] === 'string' ? left[sortField].toLowerCase() : Number(left[sortField] || 0);
          const rightValue = typeof right[sortField] === 'string' ? right[sortField].toLowerCase() : Number(right[sortField] || 0);
          if (leftValue === rightValue) return String(left.name).localeCompare(String(right.name));
          return (leftValue > rightValue ? 1 : -1) * (ascending ? 1 : -1);
        });

        const session = await shopeeService.getActiveSession();
        const dbHistory = await prisma.shopeeAdsData.findMany({
          where: session?.storeId ? { storeId: session.storeId } : {},
          orderBy: { date: 'desc' },
          take: 30,
        });

        const history = dbHistory.reverse().map((row) => ({
          date: row.date,
          spend: Number(row.spend || 0),
          sales: Number(row.sales || 0),
          roas: Number(row.roas || 0),
          ctr: Number(row.ctr || 0),
          dataAsOf: row.dataAsOf,
        }));

        const meta = {
          status: 'Segar',
          source: 'SHOPEE_API',
          dataAsOf: new Date().toISOString(),
          message: liveData.message,
          period: liveData.period,
        };

        return res.json({
          success: true,
          totalSpend: liveData.totalSpend,
          totalSalesGenerated: liveData.totalSalesGenerated,
          roas: liveData.roas,
          impressions: liveData.impressions,
          clicks: liveData.clicks,
          ctr: liveData.ctr,
          voucherSpend: liveData.voucherSpend,
          voucherSales: liveData.voucherSales,
          amountAudit: {
            rawSpend: liveData.rawSpend,
            rawSales: liveData.rawSales,
            rawVoucherSpend: liveData.rawVoucherSpend,
            rawVoucherSales: liveData.rawVoucherSales,
            divisor: liveData.amountDivisor || 100000,
          },
          topCampaigns: sortedCampaigns,
          sort: { sortBy: sortField, direction: ascending ? 'asc' : 'desc' },
          history,
          period: liveData.period,
          meta,
          dataSource: 'SHOPEE_API',
          dataAsOf: meta.dataAsOf,
        });
      }
    } catch (err) {
      console.warn('[ShopeeController] Live ads fetch failed, falling back to snapshot:', err.message);
    }
  }

  const snapshot = await snapshotService.getAdsSnapshot({
    sortBy,
    direction,
  });
  return res.json({ success: true, ...snapshot, dataSource: snapshot.meta.source, dataAsOf: snapshot.meta.dataAsOf });
}

async function triggerSync(req, res) {
  const result = await syncService.syncShopee({ origin: 'MANUAL' });
  return res.status(result.success ? 200 : 502).json(result);
}

async function validateCookie(req, res) {
  const snapshot = await snapshotService.getCatalogSnapshot({ page: 1, limit: 1 });
  return res.json({
    success: true,
    valid: snapshot.meta.status === 'Segar' || snapshot.meta.status === 'Tertunda',
    message: 'Status sesi ditentukan dari snapshot terakhir. Gunakan Sync untuk memvalidasi sesi ke Seller Center.',
    meta: snapshot.meta,
  });
}

async function getProductPerformance(req, res) {
  try {
    const {
      period = 'real_time',
      start_time,
      end_time,
      keyword = '',
      category_type = 'shopee',
      category_id = '-1',
      page_size = 10,
      page_num = 1,
      order_type = 'confirmed',
      order_by = 'confirmed_sales.desc',
    } = req.query;

    const request = {
      period,
      startTime: start_time,
      endTime: end_time,
      keyword,
      categoryType: category_type,
      categoryId: category_id,
      pageSize: Number(page_size) || 10,
      pageNum: Number(page_num) || 1,
      orderType: order_type,
      orderBy: order_by,
    };
    const data = await shopeeService.fetchProductPerformance(request);
    const shouldUseSnapshot = data.dataSource !== 'SHOPEE_API'
      || !data.success
      || (data.total > 0 && !data.products?.length);
    if (shouldUseSnapshot) {
      const snapshot = await snapshotService.getProductPerformanceSnapshot(request);
      if (snapshot.total > 0) {
        return res.json({
          ...snapshot,
          liveError: data.message || null,
        });
      }
    }

    return res.json(data);
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Terjadi kesalahan saat memuat performa produk.',
      details: err.message,
    });
  }
}

async function getTrafficSources(req, res) {
  // Live read: a store-level breakdown of a moving window, with nothing snapshotted to
  // keep in step. An outage is reported through `source`, not hidden behind zeros.
  const result = await shopeeService.fetchTrafficSources({ days: Number(req.query.days) || 7 });
  return res.json({ success: result.source === 'SHOPEE_API', ...result });
}

module.exports = wrapHandlers({
  parseCookie,
  getSessionStatus,
  getShopeeMetrics,
  getProductDetail,
  updateProductEconomics,
  getShopeeAds,
  getProductPerformance,
  getTrafficSources,
  triggerSync,
  validateCookie,
});
