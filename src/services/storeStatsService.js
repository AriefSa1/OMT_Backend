const prisma = require('../utils/prisma');
const snapshotService = require('./snapshotService');

/**
 * Statistik agregat per toko atas satu jendela waktu, dipakai bersama oleh panel admin:
 * daftar statistik semua toko (Fitur 2) dan pembanding antar-toko (Fitur 3). Sengaja
 * dikumpulkan di satu tempat supaya kedua fitur menghitung angka dengan cara yang persis
 * sama — kalau definisi "omzet 30 hari" berubah, ia berubah untuk keduanya sekaligus.
 *
 * Semua tanggal disimpan sebagai teks 'YYYY-MM-DD', jadi perbandingan leksikografis (gte/lt)
 * sama dengan perbandingan kronologis — tidak perlu parsing tanggal di query.
 */

function shiftDateKey(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return snapshotService.dateKey(d);
}

/**
 * Dua jendela berurutan berukuran sama, supaya tren (naik/turun) bisa dihitung: jendela
 * "sekarang" = `days` hari terakhir, "sebelumnya" = `days` hari sebelum itu.
 */
function buildWindows(days) {
  const currentStart = shiftDateKey(-(days - 1)); // termasuk hari ini
  const previousStart = shiftDateKey(-(2 * days - 1));
  const previousEnd = currentStart; // eksklusif
  return { currentStart, previousStart, previousEnd };
}

function pctChange(current, previous) {
  if (!previous) return current ? null : 0; // tak ada dasar pembanding → tren tak terdefinisi
  return ((current - previous) / previous) * 100;
}

async function sumOrderSummary(storeIds, gte, lt) {
  const where = { storeId: { in: storeIds }, date: lt ? { gte, lt } : { gte } };
  const rows = await prisma.shopeeOrderSummary.groupBy({
    by: ['storeId'],
    where,
    _sum: { gmv: true, orderCount: true, cancelledOrders: true },
    _count: { id: true }
  });
  return new Map(rows.map((r) => [r.storeId, r]));
}

async function sumAds(storeIds, gte, lt) {
  const where = { storeId: { in: storeIds }, date: lt ? { gte, lt } : { gte } };
  const rows = await prisma.shopeeAdsData.groupBy({
    by: ['storeId'],
    where,
    _sum: { spend: true, sales: true, impressions: true, clicks: true }
  });
  return new Map(rows.map((r) => [r.storeId, r]));
}

/**
 * @param {string[]} storeIds
 * @param {number} days panjang jendela (default 30)
 * @returns Map<storeId, metrics>
 */
async function getStoreMetrics(storeIds, days = 30) {
  if (!storeIds.length) return new Map();
  const { currentStart, previousStart, previousEnd } = buildWindows(days);

  const [curOrders, prevOrders, curAds, prevAds, productCounts] = await Promise.all([
    sumOrderSummary(storeIds, currentStart),
    sumOrderSummary(storeIds, previousStart, previousEnd),
    sumAds(storeIds, currentStart),
    sumAds(storeIds, previousStart, previousEnd),
    prisma.shopeeProduct.groupBy({ by: ['storeId'], where: { storeId: { in: storeIds } }, _count: { shopeeItemId: true } })
  ]);
  const productByStore = new Map(productCounts.map((r) => [r.storeId, r._count.shopeeItemId]));

  const result = new Map();
  for (const storeId of storeIds) {
    const co = curOrders.get(storeId);
    const po = prevOrders.get(storeId);
    const ca = curAds.get(storeId);
    const pa = prevAds.get(storeId);

    const gmv = co?._sum.gmv || 0;
    const orders = co?._sum.orderCount || 0;
    const cancelled = co?._sum.cancelledOrders || 0;
    const prevGmv = po?._sum.gmv || 0;
    const prevOrdersCount = po?._sum.orderCount || 0;

    const adsSpend = ca?._sum.spend || 0;
    const adsSales = ca?._sum.sales || 0;
    const clicks = ca?._sum.clicks || 0;
    const impressions = ca?._sum.impressions || 0;

    result.set(storeId, {
      periodDays: days,
      productCount: productByStore.get(storeId) || 0,
      // Penjualan
      gmv,
      orders,
      avgOrderValue: orders ? gmv / orders : 0,
      cancelledOrders: cancelled,
      cancelRate: orders ? (cancelled / orders) * 100 : 0,
      daysWithSales: co?._count.id || 0,
      // Tren vs jendela sebelumnya (null bila tak ada dasar pembanding)
      gmvTrendPct: pctChange(gmv, prevGmv),
      ordersTrendPct: pctChange(orders, prevOrdersCount),
      // Iklan. ROAS dihitung dari total (sales/spend), bukan rata-rata roas harian —
      // rata-rata roas menimbang hari sepi sama beratnya dengan hari ramai.
      adsSpend,
      adsSales,
      adsRoas: adsSpend ? adsSales / adsSpend : null,
      adsCtr: impressions ? (clicks / impressions) * 100 : null,
      hasAdsData: Boolean(ca)
    });
  }
  return result;
}

module.exports = { getStoreMetrics, buildWindows };
