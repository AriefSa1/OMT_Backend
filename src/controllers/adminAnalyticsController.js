const prisma = require('../utils/prisma');
const { wrapHandlers } = require('../utils/asyncHandler');
const storeStatsService = require('../services/storeStatsService');

const MAX_PERIOD_DAYS = 180;

function parseDays(value, fallback = 30) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_PERIOD_DAYS);
}

async function loadStoresWithOwner() {
  const sessions = await prisma.storeSession.findMany({
    select: {
      id: true, storeName: true, storeId: true, isActive: true, lastSyncedAt: true, createdAt: true,
      user: { select: { id: true, name: true, email: true, role: true } }
    },
    orderBy: { createdAt: 'desc' }
  });
  return sessions.map((s) => ({
    id: s.id,
    storeId: s.storeId,
    storeName: s.storeName,
    isActive: s.isActive,
    lastSyncAt: s.lastSyncedAt,
    createdAt: s.createdAt,
    owner: s.user ? { id: s.user.id, name: s.user.name, email: s.user.email, role: s.user.role } : null
  }));
}

/**
 * GET /api/admin/stores/stats?days=30
 * Statistik ringkas SEMUA toko lintas user, untuk tabel pembanding di panel admin.
 * Setiap baris membawa pemilik + metrik agregat periode (omzet, order, AOV, iklan, tren).
 */
async function getStoresStats(req, res) {
  const days = parseDays(req.query.days);
  const stores = await loadStoresWithOwner();
  const storeIds = stores.map((s) => s.storeId);
  const metrics = await storeStatsService.getStoreMetrics(storeIds, days);

  const rows = stores.map((s) => ({ ...s, metrics: metrics.get(s.storeId) || null }));

  // Total lintas toko untuk kartu ringkasan di atas tabel.
  const totals = rows.reduce(
    (acc, r) => {
      if (!r.metrics) return acc;
      acc.gmv += r.metrics.gmv;
      acc.orders += r.metrics.orders;
      acc.adsSpend += r.metrics.adsSpend;
      acc.products += r.metrics.productCount;
      return acc;
    },
    { gmv: 0, orders: 0, adsSpend: 0, products: 0 }
  );

  return res.json({
    success: true,
    data: {
      periodDays: days,
      totalStores: rows.length,
      activeStores: rows.filter((r) => r.isActive).length,
      totals,
      stores: rows
    }
  });
}

const MAX_COMPARE_STORES = 6;

/**
 * Detail satu toko untuk pembanding: deret penjualan harian, top produk, dan mix kategori
 * atas jendela yang sama. Ketiganya diambil dengan groupBy/agregasi supaya tidak menarik
 * ribuan baris snapshot mentah ke aplikasi.
 */
async function buildStoreDetail(storeId, currentStart) {
  const [salesRows, categoryRows, topRows] = await Promise.all([
    prisma.shopeeOrderSummary.findMany({
      where: { storeId, date: { gte: currentStart } },
      select: { date: true, gmv: true, orderCount: true },
      orderBy: { date: 'asc' }
    }),
    prisma.productMetricSnapshot.groupBy({
      by: ['category'],
      where: { storeId, date: { gte: currentStart } },
      _sum: { confirmedSales: true }
    }),
    prisma.productMetricSnapshot.groupBy({
      by: ['shopeeItemId'],
      where: { storeId, date: { gte: currentStart } },
      _sum: { confirmedSales: true, confirmedUnits: true },
      orderBy: { _sum: { confirmedSales: 'desc' } },
      take: 5
    })
  ]);

  // Nama produk tidak ada di hasil groupBy shopeeItemId; ambil sekali untuk item teratas saja.
  const itemIds = topRows.map((r) => r.shopeeItemId);
  const products = itemIds.length
    ? await prisma.shopeeProduct.findMany({ where: { shopeeItemId: { in: itemIds } }, select: { shopeeItemId: true, name: true } })
    : [];
  const nameById = new Map(products.map((p) => [p.shopeeItemId, p.name]));

  const categoryMix = categoryRows
    .map((r) => ({ category: r.category, sales: r._sum.confirmedSales || 0 }))
    .filter((c) => c.sales > 0)
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 6);

  const topProducts = topRows.map((r) => ({
    shopeeItemId: r.shopeeItemId,
    name: nameById.get(r.shopeeItemId) || r.shopeeItemId,
    sales: r._sum.confirmedSales || 0,
    units: r._sum.confirmedUnits || 0
  }));

  return {
    salesSeries: salesRows.map((r) => ({ date: r.date, gmv: r.gmv, orders: r.orderCount })),
    categoryMix,
    topProducts
  };
}

/**
 * GET /api/admin/analytics/compare?storeIds=a,b&days=30
 * Pembanding mendalam 2-6 toko: metrik ringkas + deret penjualan + top produk + kategori.
 */
async function compareStores(req, res) {
  const storeIds = String(req.query.storeIds || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const uniqueIds = [...new Set(storeIds)].slice(0, MAX_COMPARE_STORES);
  if (uniqueIds.length < 2) {
    return res.status(400).json({ success: false, error: 'Pilih minimal 2 toko untuk dibandingkan.' });
  }

  const days = parseDays(req.query.days);
  const { currentStart } = require('../services/storeStatsService').buildWindows(days);

  const sessions = await prisma.storeSession.findMany({
    where: { storeId: { in: uniqueIds } },
    select: { storeId: true, storeName: true, user: { select: { name: true, email: true } } }
  });
  const sessionById = new Map(sessions.map((s) => [s.storeId, s]));

  const metrics = await storeStatsService.getStoreMetrics(uniqueIds, days);
  const details = await Promise.all(uniqueIds.map((id) => buildStoreDetail(id, currentStart)));

  const stores = uniqueIds.map((id, i) => {
    const sess = sessionById.get(id);
    return {
      storeId: id,
      storeName: sess?.storeName || id,
      owner: sess?.user ? { name: sess.user.name, email: sess.user.email } : null,
      metrics: metrics.get(id) || null,
      ...details[i]
    };
  });

  return res.json({ success: true, data: { periodDays: days, currentStart, stores } });
}

module.exports = wrapHandlers({ getStoresStats, compareStores });
