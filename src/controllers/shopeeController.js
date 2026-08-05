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
  const snapshot = await snapshotService.getAdsSnapshot({
    sortBy: req.query.sort_by,
    direction: req.query.direction,
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

module.exports = wrapHandlers({
  parseCookie,
  getSessionStatus,
  getShopeeMetrics,
  getProductDetail,
  updateProductEconomics,
  getShopeeAds,
  getProductPerformance,
  triggerSync,
  validateCookie,
});
