const snapshotService = require('./snapshotService');
const taskService = require('./taskService');

function healthScore(recommendations) {
  if (!recommendations.length) return null;
  return Math.max(0, 100 - recommendations.reduce((score, item) => score + (item.priority === 'HIGH' ? 12 : item.priority === 'MEDIUM' ? 6 : 3), 0));
}

class OptimizationService {
  async getProductOptimizations() {
    const data = await snapshotService.getActionSnapshot();
    const recommendations = data.recommendations.filter((item) => item.source === 'KATALOG_SHOPEE');
    return {
      overallProductHealthScore: healthScore(recommendations),
      recommendations,
      dataSource: data.sources.catalog.source,
      meta: data.sources.catalog,
      message: recommendations.length ? null : data.sources.catalog.message,
    };
  }

  async getStoreOptimizations() {
    const data = await snapshotService.getActionSnapshot();
    const recommendations = data.recommendations.filter((item) => item.source === 'GUDANG');
    return {
      storeHealthScore: healthScore(recommendations),
      metrics: {
        chatResponseRate: null,
        fulfillmentSpeed: null,
        storeRating: null,
        cancellationRate: null,
      },
      decorationsAndPromos: recommendations,
      meta: data.sources.warehouse,
      message: recommendations.length ? null : data.sources.warehouse.message,
    };
  }

  async getAdsOptimizations() {
    const data = await snapshotService.getActionSnapshot();
    const recommendations = data.recommendations.filter((item) => item.source === 'IKLAN_SHOPEE');
    return {
      adsHealthScore: healthScore(recommendations),
      currentROAS: data.sources.ads ? (await snapshotService.getAdsSnapshot()).roas : null,
      targetROAS: null,
      keywordBids: recommendations,
      meta: data.sources.ads,
      message: recommendations.length ? null : data.sources.ads.message,
    };
  }

  async applyAction(payload, actor) {
    const recommendation = payload.recommendation || payload;
    const created = await taskService.create({
      recommendationId: recommendation.recommendationId || recommendation.id || payload.actionId,
      type: recommendation.type || payload.type,
      title: recommendation.title || `Tinjau rekomendasi ${payload.actionId || ''}`.trim(),
      description: recommendation.description || 'Tugas dibuat dari rekomendasi optimasi. Tinjau dan jalankan perubahan secara manual di Seller Center.',
      source: recommendation.source || 'SYSTEM',
      entityType: recommendation.entityType || 'PRODUCT',
      entityId: recommendation.entityId || null,
      priority: recommendation.priority || 'MEDIUM',
    }, actor);
    return {
      success: true,
      task: created.task,
      duplicate: created.duplicate,
      message: created.duplicate ? 'Tugas aktif untuk rekomendasi ini sudah ada.' : 'Tugas usulan berhasil dibuat. Tidak ada perubahan otomatis ke Seller Center.',
    };
  }
}

module.exports = new OptimizationService();
