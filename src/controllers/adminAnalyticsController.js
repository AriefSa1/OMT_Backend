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

module.exports = wrapHandlers({ getStoresStats });
