const prisma = require('../utils/prisma');
const snapshotService = require('./snapshotService');

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

class GrowthIntelligenceService {
  // Legacy Growth Intelligence remains available, but now reads the same local snapshots as Action Center.
  async getOverview() {
    const [actions, ads, orders] = await Promise.all([
      snapshotService.getActionSnapshot(),
      snapshotService.getAdsSnapshot(),
      prisma.shopeeOrderSummary.findMany({ orderBy: { date: 'desc' }, take: 7 }),
    ]);
    const productRecommendations = actions.recommendations.filter((item) => item.source === 'KATALOG_SHOPEE');
    const adsRecommendations = actions.recommendations.filter((item) => item.source === 'IKLAN_SHOPEE');
    const warehouseRecommendations = actions.recommendations.filter((item) => item.source === 'GUDANG');
    const weeklyRows = [...orders].reverse();
    const weeklyGmv = weeklyRows.reduce((sum, row) => sum + number(row.gmv), 0);
    const weeklyOrders = weeklyRows.reduce((sum, row) => sum + number(row.orderCount), 0);
    return {
      generatedAt: new Date().toISOString(),
      sources: actions.sources,
      catalogScorecard: {
        score: productRecommendations.length ? Math.max(0, 100 - productRecommendations.length * 8) : null,
        products: productRecommendations,
      },
      demandForecast: [],
      restockPlan: warehouseRecommendations,
      priceStrategies: productRecommendations.filter((item) => item.type === 'CONVERSION_REVIEW'),
      voucherAnalysis: {
        voucherSpend: ads.voucherSpend,
        voucherSales: ads.voucherSales,
        source: ads.meta.source,
        message: ads.meta.message,
      },
      adOpportunities: adsRecommendations,
      listingExperiments: productRecommendations.filter((item) => item.type === 'LISTING_CTR'),
      bundleSuggestions: [],
      weeklyReport: {
        daysWithData: weeklyRows.length,
        gmv: weeklyRows.length ? weeklyGmv : null,
        orders: weeklyRows.length ? weeklyOrders : null,
        averageOrderValue: weeklyOrders ? weeklyGmv / weeklyOrders : null,
        message: weeklyRows.length ? null : 'Data GMV dan pesanan belum tersedia dari endpoint ringkasan pesanan.',
      },
      taskBoard: actions.tasks,
      competitorMonitor: {
        status: 'PILIH_PRODUK',
        message: 'Pilih produk katalog untuk memeriksa kompetitor. ID kategori Shopee akan digunakan dari snapshot produk.',
        source: 'SHOPEE_SNAPSHOT',
      },
    };
  }
}

module.exports = new GrowthIntelligenceService();
