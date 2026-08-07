const { parseShopeeCookie } = require('../utils/cookieParser');
const shopeeService = require('../services/shopeeService');
const configService = require('../services/configService');
const snapshotService = require('../services/snapshotService');
const syncService = require('../services/syncService');
const prisma = require('../utils/prisma');
const { wrapHandlers } = require('../utils/asyncHandler');
const { getPeriodSlices, aggregateAdsRows, compareAdsMetric } = require('../utils/adsPeriod');

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
    userId: session.userId || null,
    owner: session.user || session.owner || null,
  };
}

/**
 * Verify if the request user is authorized to access a given storeId.
 * - ADMIN: can access any storeId.
 * - USER: can only access stores that belong to them (session.userId === req.user.id).
 * If requestedStoreId is null, falls back to the user's active/latest store.
 */
async function resolveAuthorizedStoreId(req, requestedStoreId = null) {
  const user = req.user;

  if (requestedStoreId) {
    const session = await prisma.storeSession.findUnique({
      where: { storeId: String(requestedStoreId) },
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
    });

    if (!session) {
      return { error: 'Toko tidak ditemukan.', status: 404 };
    }

    if (user && user.role !== 'ADMIN' && session.userId && session.userId !== user.id) {
      return { error: 'Akses ditolak: Anda tidak memiliki akses ke toko ini.', status: 403 };
    }

    return { storeId: session.storeId, session };
  }

  // Look up user's active session
  const activeSession = await shopeeService.getActiveSession(null, user);
  if (!activeSession) {
    return { storeId: null, session: null };
  }

  return { storeId: activeSession.storeId, session: activeSession };
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

  // Associate new/updated store with the currently logged-in user
  const session = await shopeeService.saveSession({
    storeName: storeName?.trim() || 'Toko Shopee',
    storeId: analysis.storeId,
    cookieString: rawCookie,
    userAgent: req.get('user-agent') || '',
    csrfToken: analysis.csrfToken || null,
    isActive: true,
    userId: req.user?.id || null,
  });

  await configService.setMany({ storeName: session.storeName, cookieString: rawCookie });
  const sync = await syncService.syncShopee({ origin: 'CONNECT', storeId: session.storeId });

  return res.json({
    success: sync.success,
    analysis: toPublicAnalysis(analysis),
    session: toPublicSession(session),
    sync,
    message: sync.message,
  });
}

async function getSessionStatus(req, res) {
  const storeId = req.query.store_id || req.query.storeId || null;
  const resolved = await resolveAuthorizedStoreId(req, storeId);

  if (resolved.error) {
    return res.status(resolved.status).json({ success: false, error: resolved.error });
  }

  const [session, allSessions] = await Promise.all([
    shopeeService.getActiveSession(resolved.storeId, req.user),
    shopeeService.getAllSessions(req.user),
  ]);

  const stores = allSessions.map((s) => ({
    ...toPublicSession(s),
    productCount: s.productCount || 0,
  }));

  return res.json({
    success: true,
    session: toPublicSession(session) || {
      storeName: '',
      storeId: '',
      cookieConfigured: false,
      csrfConfigured: false,
      lastSyncedAt: null,
      userId: req.user?.id || null,
    },
    stores,
  });
}

async function getAllStores(req, res) {
  const allSessions = await shopeeService.getAllSessions(req.user);

  const stores = allSessions.map((s) => ({
    ...toPublicSession(s),
    productCount: s.productCount || 0,
  }));

  return res.json({
    success: true,
    stores,
  });
}

async function setActiveStore(req, res) {
  const { storeId, isActive = true } = req.body;
  if (!storeId) {
    return res.status(400).json({ success: false, error: 'storeId wajib diisi.' });
  }

  const targetSession = await prisma.storeSession.findUnique({
    where: { storeId: String(storeId) },
  });

  if (!targetSession) {
    return res.status(404).json({ success: false, error: 'Toko tidak ditemukan.' });
  }

  if (req.user.role !== 'ADMIN' && targetSession.userId && targetSession.userId !== req.user.id) {
    return res.status(403).json({ success: false, error: 'Akses ditolak: Anda bukan pemilik toko ini.' });
  }

  const updated = await shopeeService.updateSession(storeId, { isActive: Boolean(isActive) });

  return res.json({
    success: true,
    message: `Status toko ${updated.storeName} berhasil diperbarui.`,
    session: toPublicSession(updated),
  });
}

async function deleteStoreSession(req, res) {
  const { storeId } = req.params;
  if (!storeId) {
    return res.status(400).json({ success: false, error: 'storeId wajib diisi.' });
  }

  const targetSession = await prisma.storeSession.findUnique({
    where: { storeId: String(storeId) },
  });

  if (!targetSession) {
    return res.status(404).json({ success: false, error: 'Toko tidak ditemukan.' });
  }

  if (req.user.role !== 'ADMIN' && targetSession.userId && targetSession.userId !== req.user.id) {
    return res.status(403).json({ success: false, error: 'Akses ditolak: Anda bukan pemilik toko ini.' });
  }

  await shopeeService.deleteSession(storeId);
  return res.json({
    success: true,
    message: 'Sesi toko berhasil dihapus.',
  });
}

async function getShopeeMetrics(req, res) {
  const reqStoreId = req.query.store_id || req.query.storeId || null;
  const { storeId, session, error, status } = await resolveAuthorizedStoreId(req, reqStoreId);

  if (error) {
    return res.status(status).json({ success: false, error });
  }

  if (!storeId) {
    return res.json({
      success: true,
      products: [],
      filters: { categories: [], total: 0 },
      pagination: { page: 1, limit: 24, totalPages: 0, totalProducts: 0 },
      meta: {
        source: 'SHOPEE_SNAPSHOT',
        dataAsOf: null,
        freshness: 'Perlu Koneksi',
        status: 'Perlu Koneksi',
        message: 'Silakan hubungkan toko Shopee Anda terlebih dahulu di Pengaturan.',
      },
      dataSource: 'EMPTY',
      dataAsOf: null,
      message: 'Tidak ada toko aktif yang terhubung untuk akun Anda.',
    });
  }

  const snapshot = await snapshotService.getCatalogSnapshot({ ...req.query, storeId });
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
  const { id } = req.params;
  const product = await prisma.shopeeProduct.findUnique({
    where: { shopeeItemId: String(id) },
  });

  if (!product) {
    return res.status(404).json({ success: false, message: 'Produk tidak ditemukan pada snapshot katalog.' });
  }

  if (product.storeId) {
    const session = await prisma.storeSession.findUnique({
      where: { storeId: product.storeId },
    });
    if (session && req.user.role !== 'ADMIN' && session.userId && session.userId !== req.user.id) {
      return res.status(403).json({ success: false, error: 'Akses ditolak ke produk toko ini.' });
    }
  }

  const snapshot = await snapshotService.getProductSnapshot(id);
  if (!snapshot) return res.status(404).json({ success: false, message: 'Produk tidak ditemukan pada snapshot katalog.' });
  return res.json({ success: true, ...snapshot });
}

async function updateProductEconomics(req, res) {
  const { id } = req.params;
  const product = await prisma.shopeeProduct.findUnique({
    where: { shopeeItemId: String(id) },
  });

  if (!product) {
    return res.status(404).json({ success: false, error: 'Produk tidak ditemukan.' });
  }

  if (product.storeId) {
    const session = await prisma.storeSession.findUnique({
      where: { storeId: product.storeId },
    });
    if (session && req.user.role !== 'ADMIN' && session.userId && session.userId !== req.user.id) {
      return res.status(403).json({ success: false, error: 'Akses ditolak untuk mengedit produk toko ini.' });
    }
  }

  const keys = ['unitCost', 'unitAdCost', 'shippingCost', 'platformFeePercent'];
  const data = Object.fromEntries(keys.filter((key) => req.body[key] !== undefined).map((key) => {
    const value = req.body[key];
    return [key, value === null || value === '' ? null : Number(value)];
  }));

  if (Object.values(data).some((value) => value !== null && !Number.isFinite(value))) {
    return res.status(400).json({ success: false, error: 'Nilai ekonomi produk harus berupa angka.' });
  }

  const updatedProduct = await prisma.shopeeProduct.update({ where: { shopeeItemId: String(id) }, data });
  return res.json({ success: true, product: updatedProduct });
}

async function getShopeeAds(req, res) {
  const {
    period = 'real_time',
    start_time,
    end_time,
    sort_by = 'spend',
    direction = 'desc',
    force_snapshot = 'false',
    store_id,
    storeId,
  } = req.query;

  const reqStoreId = store_id || storeId || null;
  const resolved = await resolveAuthorizedStoreId(req, reqStoreId);

  if (resolved.error) {
    return res.status(resolved.status).json({ success: false, error: resolved.error });
  }

  const targetStoreId = resolved.storeId;

  if (!targetStoreId) {
    return res.json({
      success: true,
      totalSpend: 0,
      totalSalesGenerated: 0,
      roas: 0,
      impressions: 0,
      clicks: 0,
      ctr: 0,
      voucherSpend: 0,
      voucherSales: 0,
      topCampaigns: [],
      history: [],
      period,
      meta: {
        status: 'Perlu Koneksi',
        source: 'DATABASE',
        dataAsOf: null,
        message: 'Belum ada toko yang terhubung untuk akun Anda.',
        period,
      },
      dataSource: 'EMPTY',
      dataAsOf: null,
    });
  }

  const sortBy = sort_by;
  const ascending = direction === 'asc';

  if (force_snapshot !== 'true') {
    try {
      const liveData = await shopeeService.fetchShopeeAdsMetrics({
        period,
        startTime: start_time,
        endTime: end_time,
        storeId: targetStoreId,
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

        // take: 64 so getPeriodSlices has enough rows for the past30days (32-day) comparison.
        const dbHistoryDesc = await prisma.shopeeAdsData.findMany({
          where: { storeId: targetStoreId },
          orderBy: { date: 'desc' },
          take: 64,
        });

        const history = [...dbHistoryDesc].reverse().map((row) => ({
          date: row.date,
          spend: Number(row.spend || 0),
          sales: Number(row.sales || 0),
          roas: Number(row.roas || 0),
          ctr: Number(row.ctr || 0),
          impressions: Number(row.impressions || 0),
          clicks: Number(row.clicks || 0),
          orders: Number(row.orders || 0),
          itemSold: Number(row.itemSold || 0),
          dataAsOf: row.dataAsOf,
        }));

        // "Current" is the live-fetched total for the selected period; "previous" is the
        // equal-length period immediately before it, aggregated from persisted daily snapshots
        // (there's no live equivalent for a past period). Same convention as the dashboard.
        const { previous: previousRows } = getPeriodSlices(period, dbHistoryDesc);
        const previousAgg = aggregateAdsRows(previousRows.map((row) => ({
          date: row.date,
          spend: Number(row.spend || 0),
          sales: Number(row.sales || 0),
          impressions: Number(row.impressions || 0),
          clicks: Number(row.clicks || 0),
          orders: Number(row.orders || 0),
          itemSold: Number(row.itemSold || 0),
        })));
        const trend = {
          previousDate: previousAgg?.date || null,
          impressions: compareAdsMetric(liveData.impressions, previousAgg?.impressions ?? null),
          clicks: compareAdsMetric(liveData.clicks, previousAgg?.clicks ?? null),
          ctr: compareAdsMetric(liveData.ctr, previousAgg?.ctr ?? null),
          orders: compareAdsMetric(liveData.orders, previousAgg?.orders ?? null),
          itemSold: compareAdsMetric(liveData.itemSold, previousAgg?.itemSold ?? null),
          sales: compareAdsMetric(liveData.totalSalesGenerated, previousAgg?.sales ?? null),
          spend: compareAdsMetric(liveData.totalSpend, previousAgg?.spend ?? null),
          roas: compareAdsMetric(liveData.roas, previousAgg?.roas ?? null),
        };

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
          orders: liveData.orders,
          itemSold: liveData.itemSold,
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
          trend,
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
    storeId: targetStoreId,
  });
  return res.json({ success: true, ...snapshot, dataSource: snapshot.meta.source, dataAsOf: snapshot.meta.dataAsOf });
}

async function triggerSync(req, res) {
  const reqStoreId = req.body.store_id || req.body.storeId || req.query.store_id || req.query.storeId || null;
  const resolved = await resolveAuthorizedStoreId(req, reqStoreId);

  if (resolved.error) {
    return res.status(resolved.status).json({ success: false, error: resolved.error });
  }

  if (!resolved.storeId) {
    return res.status(400).json({ success: false, error: 'Tidak ada toko aktif yang dapat disinkronkan.' });
  }

  const result = await syncService.syncShopee({ origin: 'MANUAL', storeId: resolved.storeId });
  return res.status(result.success ? 200 : 502).json(result);
}

async function validateCookie(req, res) {
  const reqStoreId = req.query.store_id || req.query.storeId || null;
  const resolved = await resolveAuthorizedStoreId(req, reqStoreId);

  if (resolved.error) {
    return res.status(resolved.status).json({ success: false, error: resolved.error });
  }

  const snapshot = await snapshotService.getCatalogSnapshot({ page: 1, limit: 1, storeId: resolved.storeId });
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
      store_id,
      storeId,
    } = req.query;

    const reqStoreId = store_id || storeId || null;
    const resolved = await resolveAuthorizedStoreId(req, reqStoreId);

    if (resolved.error) {
      return res.status(resolved.status).json({ success: false, error: resolved.error });
    }

    const targetStoreId = resolved.storeId;

    if (!targetStoreId) {
      return res.json({
        success: true,
        products: [],
        total: 0,
        summary: {},
        dataSource: 'EMPTY',
        message: 'Tidak ada toko yang terhubung untuk akun Anda.',
      });
    }

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
      storeId: targetStoreId,
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
  const reqStoreId = req.query.store_id || req.query.storeId || null;
  const resolved = await resolveAuthorizedStoreId(req, reqStoreId);

  if (resolved.error) {
    return res.status(resolved.status).json({ success: false, error: resolved.error });
  }

  if (!resolved.storeId) {
    return res.json({
      success: true,
      source: 'EMPTY',
      sources: [],
      message: 'Tidak ada toko terhubung.',
    });
  }

  const result = await shopeeService.fetchTrafficSources({
    days: Number(req.query.days) || 7,
    storeId: resolved.storeId,
  });

  return res.json({ success: result.source === 'SHOPEE_API', ...result });
}

module.exports = {
  ...wrapHandlers({
    parseCookie,
    getSessionStatus,
    getAllStores,
    setActiveStore,
    deleteStoreSession,
    getShopeeMetrics,
    getProductDetail,
    updateProductEconomics,
    getShopeeAds,
    getProductPerformance,
    getTrafficSources,
    triggerSync,
    validateCookie,
  }),
  resolveAuthorizedStoreId,
};
