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
 * @param {'visitors'|'units'|'sales'} [opts.metric='visitors'] metrik penentu status menurun
 * @param {number} [opts.minStreak=2] panjang streak turun minimum agar dianggap menurun
 */

// Metrik yang dihitung mingguan. `visitors` = pengunjung (UV) dari Shopee. Ketiganya
// selalu dihitung agar UI dan diagnosis bisa membandingkan trafik vs konversi vs omzet;
// `metric` hanya menentukan mana yang MEMICU status "menurun".
const WEEKLY_METRICS = {
  visitors: { field: 'visitors', label: 'Pengunjung (UV)', kind: 'count' },
  units: { field: 'confirmedUnits', label: 'Unit Terjual', kind: 'count' },
  sales: { field: 'confirmedSales', label: 'Omzet', kind: 'currency' }
};
// Ambang penurunan bersih (persen) untuk memberi label diagnosis penyebab.
const DIAGNOSIS_DROP_PCT = -15;

/** Analisa satu deret mingguan → streak turun, perubahan minggu-terakhir, dan bersih. */
function analyzeSeries(weekly) {
  const latest = weekly[weekly.length - 1];
  const first = weekly[0];
  let streak = 0;
  for (let i = weekly.length - 1; i > 0; i -= 1) {
    if (weekly[i] < weekly[i - 1]) streak += 1;
    else break;
  }
  const prev = weekly[weekly.length - 2] ?? 0;
  const wowPct = prev ? ((latest - prev) / prev) * 100 : (latest ? null : 0);
  const netPct = first ? ((latest - first) / first) * 100 : (latest ? null : 0);
  const peak = Math.max(...weekly);
  return { weekly, latest, streak, wowPct, netPct, peak };
}

/**
 * Diagnosis penyebab penurunan dengan membandingkan tren trafik (UV) dan konversi (unit).
 * Inilah yang menerjemahkan angka menjadi tindakan:
 *  - TRAFIK: pengunjung turun → periksa iklan, peringkat pencarian, musiman.
 *  - KONVERSI: pengunjung stabil tapi unit turun → periksa harga, stok, ulasan, listing.
 *  - TRAFIK_DAN_KONVERSI: keduanya turun → masalah menumpuk, prioritas tertinggi.
 */
function diagnose(visitorsNet, unitsNet) {
  const trafficDown = visitorsNet !== null && visitorsNet <= DIAGNOSIS_DROP_PCT;
  const conversionDown = unitsNet !== null && unitsNet <= DIAGNOSIS_DROP_PCT;
  if (trafficDown && conversionDown) return 'TRAFIK_DAN_KONVERSI';
  if (trafficDown) return 'TRAFIK';
  if (conversionDown) return 'KONVERSI';
  return 'RINGAN';
}

async function getWeeklyProductPerformance({ storeId, weeks = 4, metric = 'visitors', minStreak = 2 }) {
  const weekCount = Math.min(Math.max(Math.floor(weeks) || 4, 2), 12);
  const primary = WEEKLY_METRICS[metric] ? metric : 'visitors';

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
    select: {
      shopeeItemId: true, productName: true, category: true, date: true,
      visitors: true, confirmedUnits: true, confirmedSales: true
    }
  });

  // Agregasi per produk per blok minggu, untuk KETIGA metrik sekaligus.
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
        series: {
          visitors: new Array(weekCount).fill(0),
          units: new Array(weekCount).fill(0),
          sales: new Array(weekCount).fill(0)
        }
      };
      products.set(row.shopeeItemId, entry);
    }
    entry.series.visitors[bucket.index] += row.visitors || 0;
    entry.series.units[bucket.index] += row.confirmedUnits || 0;
    entry.series.sales[bucket.index] += row.confirmedSales || 0;
    if (row.productName) entry.name = row.productName;
  }

  const analyzed = [...products.values()].map((p) => {
    const metrics = {
      visitors: analyzeSeries(p.series.visitors),
      units: analyzeSeries(p.series.units),
      sales: analyzeSeries(p.series.sales)
    };
    const primaryStats = metrics[primary];
    const declining = primaryStats.streak >= minStreak && primaryStats.peak > 0;
    const diagnosis = declining ? diagnose(metrics.visitors.netPct, metrics.units.netPct) : null;

    // Skor keparahan untuk pengurutan "paling perlu ditindak lebih dulu": streak dominan,
    // lalu besar penurunan bersih metrik penentu.
    const severity = declining
      ? primaryStats.streak * 100 + Math.min(100, Math.abs(primaryStats.netPct ?? 0))
      : 0;

    return {
      shopeeItemId: p.shopeeItemId,
      name: p.name,
      category: p.category,
      // Ringkasan metrik penentu (kompatibel dengan pemakai lama: weekly/declineStreak/…).
      weekly: primaryStats.weekly,
      latest: primaryStats.latest,
      declineStreak: primaryStats.streak,
      wowChangePct: primaryStats.wowPct,
      netChangePct: primaryStats.netPct,
      declining,
      diagnosis,
      severity,
      // Semua metrik untuk konteks di UI (trafik vs konversi vs omzet).
      metrics: {
        visitors: { weekly: metrics.visitors.weekly, netPct: metrics.visitors.netPct, streak: metrics.visitors.streak },
        units: { weekly: metrics.units.weekly, netPct: metrics.units.netPct, streak: metrics.units.streak },
        sales: { weekly: metrics.sales.weekly, netPct: metrics.sales.netPct, streak: metrics.sales.streak }
      }
    };
  });

  // Menurun didahulukan; di antara yang menurun, keparahan tertinggi di atas.
  analyzed.sort((a, b) => {
    if (a.declining !== b.declining) return a.declining ? -1 : 1;
    if (b.severity !== a.severity) return b.severity - a.severity;
    return (a.netChangePct ?? 0) - (b.netChangePct ?? 0);
  });

  // Rincian diagnosis untuk kartu ringkasan.
  const byDiagnosis = { TRAFIK: 0, KONVERSI: 0, TRAFIK_DAN_KONVERSI: 0, RINGAN: 0 };
  for (const p of analyzed) if (p.declining && byDiagnosis[p.diagnosis] !== undefined) byDiagnosis[p.diagnosis] += 1;

  return {
    storeId,
    metric: primary,
    metricLabel: WEEKLY_METRICS[primary].label,
    metricKind: WEEKLY_METRICS[primary].kind,
    minStreak,
    weeks: buckets.map((b) => ({ label: b.label, start: b.start, end: b.end })),
    products: analyzed,
    decliningCount: analyzed.filter((p) => p.declining).length,
    diagnosisBreakdown: byDiagnosis
  };
}

module.exports = { getStoreMetrics, buildWindows, getWeeklyProductPerformance, WEEKLY_METRICS };
