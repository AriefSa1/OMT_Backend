const prisma = require('../utils/prisma');
const snapshotService = require('./snapshotService');
const storeStatsService = require('./storeStatsService');
const aiService = require('./aiService');

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Gabungkan metrik per-toko (Map dari storeStatsService.getStoreMetrics) menjadi satu
 * ringkasan tim: absolut dijumlah, tren = rata-rata tertimbang GMV.
 */
function aggregateStoreMetrics(map) {
  const rows = [...(map?.values?.() || [])];
  if (!rows.length) return {};
  let gmv = 0, orders = 0, cancelled = 0, adsSpend = 0, adsSales = 0;
  let gmvTrendW = 0, ordersTrendW = 0, trendWeight = 0;
  for (const r of rows) {
    gmv += number(r.gmv);
    orders += number(r.orders);
    cancelled += number(r.cancelledOrders);
    adsSpend += number(r.adsSpend);
    adsSales += number(r.adsSales);
    const w = Math.max(1, number(r.gmv));
    if (r.gmvTrendPct != null) { gmvTrendW += r.gmvTrendPct * w; trendWeight += w; }
    if (r.ordersTrendPct != null) { ordersTrendW += r.ordersTrendPct * w; }
  }
  return {
    gmv,
    orders,
    avgOrderValue: orders ? gmv / orders : 0,
    cancelRate: orders ? (cancelled / orders) * 100 : 0,
    adsRoas: adsSpend ? adsSales / adsSpend : null,
    gmvTrendPct: trendWeight ? gmvTrendW / trendWeight : null,
    ordersTrendPct: trendWeight ? ordersTrendW / trendWeight : null,
  };
}

class AiAnalysisService {
  /**
   * Analisa mendalam bersama untuk Pusat Optimasi, Aksi & Tugas, dan Wawasan Growth.
   * Merakit konteks KAYA dari snapshot lokal + tren storeStats, lalu memanggil mesin AI.
   */
  async getActionCenterAnalysis({ periodLabel = '7 hari terakhir' } = {}) {
    const sessions = await prisma.storeSession.findMany({
      select: { storeId: true, isActive: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });
    const storeIds = sessions.map((s) => s.storeId).filter(Boolean);
    const primaryStoreId = (sessions.find((s) => s.isActive) || sessions[0])?.storeId || null;

    const [action, perf, ads, catalog, storeMetricsMap, weeklyProduct, orderRows] = await Promise.all([
      snapshotService.getActionSnapshot().catch(() => ({ recommendations: [], tasks: [] })),
      snapshotService.getProductPerformanceSnapshot({ pageSize: 20, pageNum: 1, period: 'past7days', orderBy: 'item_views.desc' }).catch(() => null),
      snapshotService.getAdsSnapshot().catch(() => null),
      snapshotService.getCatalogSnapshot({ page: 1, limit: 100, sort: 'salesCount' }).catch(() => null),
      storeIds.length ? storeStatsService.getStoreMetrics(storeIds, 30).catch(() => new Map()) : new Map(),
      primaryStoreId ? storeStatsService.getWeeklyProductPerformance({ storeId: primaryStoreId, weeks: 4, metric: 'visitors', minStreak: 2 }).catch(() => null) : null,
      prisma.shopeeOrderSummary.findMany({ orderBy: { date: 'desc' }, take: 7 }).catch(() => []),
    ]);

    const store = aggregateStoreMetrics(storeMetricsMap);

    // Ringkasan 7 hari dari order summary harian.
    const weeklyRows = [...(orderRows || [])].reverse();
    const weeklyGmv = weeklyRows.reduce((s, r) => s + number(r.gmv), 0);
    const weeklyOrders = weeklyRows.reduce((s, r) => s + number(r.orderCount), 0);
    const weekly = {
      gmv: weeklyRows.length ? weeklyGmv : null,
      orders: weeklyRows.length ? weeklyOrders : null,
      averageOrderValue: weeklyOrders ? weeklyGmv / weeklyOrders : null,
    };

    // Funnel per-produk (teratas by traffic).
    const funnelProducts = (perf?.products || []).slice(0, 15).map((p) => ({
      name: p.name,
      visitors: number(p.visitors),
      ctr: null, // tidak tersedia di snapshot performa; biarkan n/a
      addToCartRate: number(p.addToCartRate),
      conversionRate: number(p.conversionRate),
      salesCount: number(p.confirmedUnits ?? p.confirmedOrders),
      stock: null,
    }));

    // Produk kehilangan momentum (turun beruntun).
    const decliningProducts = (weeklyProduct?.products || [])
      .filter((p) => p.declining)
      .slice(0, 10)
      .map((p) => ({
        name: p.name,
        metric: weeklyProduct.metricLabel || 'pengunjung',
        streak: number(p.declineStreak),
        latest: number(p.latest),
        baseline: number(p.metrics?.visitors?.weekly?.[0] ?? p.latest),
      }));

    // Ekonomi iklan per-kampanye (by spend).
    const adsCampaigns = (ads?.topCampaigns || [])
      .filter((c) => number(c.spend) > 0)
      .slice(0, 15)
      .map((c) => ({
        name: c.name,
        spend: number(c.spend),
        sales: number(c.sales),
        roas: number(c.roas),
        ctr: number(c.ctr),
      }));

    // Risiko stok: stok rendah tapi masih terjual.
    const stockRisks = (catalog?.products || [])
      .filter((p) => number(p.stock) <= 5 && number(p.salesCount) > 0)
      .slice(0, 12)
      .map((p) => ({ name: p.name, sku: p.sku, stock: number(p.stock), salesCount: number(p.salesCount), variance: null }));

    const existingSignals = (action?.recommendations || []).map((r) => ({ priority: r.priority, title: r.title }));

    const analysis = await aiService.generateActionCenterAnalysis({
      periodLabel, store, weekly, funnelProducts, decliningProducts, adsCampaigns, stockRisks, existingSignals,
    });

    return {
      ...analysis,
      // Konteks mentah agar UI bisa menampilkan bukti / debug bila perlu.
      context: {
        storeCount: storeIds.length,
        funnelProductCount: funnelProducts.length,
        decliningCount: decliningProducts.length,
        adsCampaignCount: adsCampaigns.length,
        stockRiskCount: stockRisks.length,
        existingSignalCount: existingSignals.length,
      },
    };
  }
}

module.exports = new AiAnalysisService();
