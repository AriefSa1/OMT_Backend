const optimizationService = require('../services/optimizationService');
const shopeeInsightsService = require('../services/shopeeInsightsService');
const snapshotService = require('../services/snapshotService');
const prisma = require('../utils/prisma');

async function getProductOpts(req, res) {
  const data = await optimizationService.getProductOptimizations();
  return res.json({ success: true, data });
}

async function getStoreOpts(req, res) {
  const data = await optimizationService.getStoreOptimizations();
  return res.json({ success: true, data });
}

async function getAdsOpts(req, res) {
  const data = await optimizationService.getAdsOptimizations();
  return res.json({ success: true, data });
}

async function applyOpt(req, res) {
  const result = await optimizationService.applyAction(req.body, req.user);
  return res.json(result);
}

async function getMarketplaceInsights(req, res) {
  const catalog = await snapshotService.getCatalogSnapshot({ page: 1, limit: 100 });
  return res.json({
    success: true,
    data: {
      source: catalog.meta.source,
      meta: catalog.meta,
      productPerformance: catalog.products.map((product) => ({ ...product.metric, itemId: product.shopeeItemId, name: product.name })),
      activeAdCampaigns: [],
      adsMonitor: { status: 'SNAPSHOT', message: 'Kampanye aktif tersedia pada halaman Iklan setelah Sync.' },
      productSignals: [],
    },
  });
}

async function getCompetitorInsights(req, res) {
  const product = await prisma.shopeeProduct.findUnique({ where: { shopeeItemId: String(req.query.itemId || '') } });
  return res.json({
    success: true,
    data: {
      source: 'SHOPEE_SNAPSHOT',
      status: product?.l2CategoryId && product?.l3CategoryId ? 'SIAP_SYNC' : 'TIDAK_TERSEDIA',
      product: product ? {
        itemId: product.shopeeItemId,
        l2CategoryId: product.l2CategoryId,
        l3CategoryId: product.l3CategoryId,
      } : null,
      message: product?.l2CategoryId && product?.l3CategoryId
        ? 'Gunakan tombol muat kompetitor untuk mengambil data terbaru secara eksplisit.'
        : 'Kategori level 2/3 belum tersedia pada snapshot produk. Jalankan Sync katalog terlebih dahulu.',
      products: [],
    },
  });
}

async function refreshCompetitorInsights(req, res) {
  const itemId = String(req.body.itemId || '');
  const product = await prisma.shopeeProduct.findUnique({ where: { shopeeItemId: itemId } });
  const result = await shopeeInsightsService.getCompetitorProducts({
    itemId,
    l2CategoryId: product?.l2CategoryId || req.body.l2CategoryId,
    l3CategoryId: product?.l3CategoryId || req.body.l3CategoryId,
  });
  return res.json({ success: result.source === 'SHOPEE_API', data: result });
}

module.exports = {
  getProductOpts,
  getStoreOpts,
  getAdsOpts,
  applyOpt,
  getMarketplaceInsights,
  getCompetitorInsights,
  refreshCompetitorInsights,
};
