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

/**
 * Performa mingguan per produk untuk satu toko, dipakai memantau produk yang
 * "cenderung menurun setiap minggu". Minggu = blok 7 hari yang ditambatkan pada hari ini
 * (minggu 0 = 7 hari terakhir, minggu 1 = 7 hari sebelumnya, dst.), bukan minggu kalender —
 * supaya "minggu terakhir" selalu berarti tujuh hari terakhir apa pun harinya sekarang.
 *
 * Sebuah produk ditandai MENURUN bila metrik mingguannya turun berturut-turut minimal
 * `minStreak` minggu terakhir (default 2) DAN sempat punya aktivitas (baseline > 0) —
 * jadi hanya produk yang benar-benar kehilangan traksi, bukan yang memang selalu nol.
 *
 * @param {object} opts
 * @param {string} opts.storeId
 * @param {number} [opts.weeks=4] jumlah blok minggu yang dihitung
 * @param {'units'|'sales'} [opts.metric='units']
 * @param {number} [opts.minStreak=2] panjang streak turun minimum agar dianggap menurun
 */
async function getWeeklyProductPerformance({ storeId, weeks = 4, metric = 'units', minStreak = 2 }) {
  const weekCount = Math.min(Math.max(Math.floor(weeks) || 4, 2), 12);
  const metricField = metric === 'sales' ? 'confirmedSales' : 'confirmedUnits';

  // Bangun batas tiap blok minggu, urut dari terlama ke terbaru.
  const buckets = [];
  for (let k = weekCount - 1; k >= 0; k -= 1) {
    buckets.push({
      index: weekCount - 1 - k,
      start: shiftDateKey(-(7 * k + 6)),
      end: shiftDateKey(-(7 * k)),
      label: `Minggu ${weekCount - k}`
    });
  }
  const earliest = buckets[0].start;

  const rows = await prisma.productMetricSnapshot.findMany({
    where: { storeId, date: { gte: earliest } },
    select: { shopeeItemId: true, productName: true, category: true, date: true, confirmedUnits: true, confirmedSales: true }
  });

  // Agregasi per produk per blok minggu.
  const products = new Map();
  const bucketOf = (date) => buckets.find((b) => date >= b.start && date <= b.end);
  for (const row of rows) {
    const bucket = bucketOf(row.date);
    if (!bucket) continue;
    let entry = products.get(row.shopeeItemId);
    if (!entry) {
      entry = {
        shopeeItemId: row.shopeeItemId,
        name: row.productName,
        category: row.category,
        weekly: new Array(weekCount).fill(0)
      };
      products.set(row.shopeeItemId, entry);
    }
    entry.weekly[bucket.index] += metric === 'sales' ? (row.confirmedSales || 0) : (row.confirmedUnits || 0);
    if (row.productName) entry.name = row.productName;
  }

  const analyzed = [...products.values()].map((p) => {
    const w = p.weekly;
    const latest = w[w.length - 1];
    const first = w[0];

    // Streak turun dihitung dari minggu terbaru mundur: berapa langkah berturut-turut
    // metrik lebih kecil dari minggu sebelumnya.
    let declineStreak = 0;
    for (let i = w.length - 1; i > 0; i -= 1) {
      if (w[i] < w[i - 1]) declineStreak += 1;
      else break;
    }
    const prev = w[w.length - 2] ?? 0;
    const wowChangePct = prev ? ((latest - prev) / prev) * 100 : (latest ? null : 0);
    const netChangePct = first ? ((latest - first) / first) * 100 : (latest ? null : 0);
    const baseline = Math.max(...w);
    const declining = declineStreak >= minStreak && baseline > 0;

    return {
      shopeeItemId: p.shopeeItemId,
      name: p.name,
      category: p.category,
      weekly: w,
      latest,
      declineStreak,
      wowChangePct,
      netChangePct,
      declining
    };
  });

  // Yang menurun didahulukan; di antara yang menurun, streak terpanjang & penurunan
  // terbesar di atas.
  analyzed.sort((a, b) => {
    if (a.declining !== b.declining) return a.declining ? -1 : 1;
    if (b.declineStreak !== a.declineStreak) return b.declineStreak - a.declineStreak;
    return (a.netChangePct ?? 0) - (b.netChangePct ?? 0);
  });

  return {
    storeId,
    metric,
    metricField,
    minStreak,
    weeks: buckets.map((b) => ({ label: b.label, start: b.start, end: b.end })),
    products: analyzed,
    decliningCount: analyzed.filter((p) => p.declining).length
  };
}

module.exports = { getStoreMetrics, buildWindows, getWeeklyProductPerformance };
