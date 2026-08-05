const optimizationService = require('../services/optimizationService');
const shopeeInsightsService = require('../services/shopeeInsightsService');
const snapshotService = require('../services/snapshotService');
const prisma = require('../utils/prisma');
const { wrapHandlers } = require('../utils/asyncHandler');

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
  const [catalog, ads] = await Promise.all([
    snapshotService.getCatalogSnapshot({ page: 1, limit: 100 }),
    snapshotService.getAdsSnapshot(),
  ]);

  // buildProductSignals reads Seller Center field names; the snapshot stores the same
  // measurements in camelCase, so map onto it instead of restating the rules here.
  // Products without a metric row have nothing measured — they are not signals.
  const measured = catalog.products.filter((product) => product.metric);
  const productSignals = shopeeInsightsService.buildProductSignals(measured.map((product) => ({
    id: product.shopeeItemId,
    name: product.name,
    product_card_impressions: product.metric.impressions,
    ctr: snapshotService.normalizeRate(product.metric.ctr),
    add_to_cart_buyers: product.metric.addToCartBuyers,
    confirmed_orders: product.metric.confirmedOrders,
    bounce_rate: snapshotService.normalizeRate(product.metric.bounceRate),
  })));

  return res.json({
    success: true,
    data: {
      source: catalog.meta.source,
      meta: catalog.meta,
      productPerformance: catalog.products.map((product) => ({ ...product.metric, itemId: product.shopeeItemId, name: product.name })),
      activeAdCampaigns: ads.topCampaigns,
      adsMonitor: {
        status: ads.meta.status,
        source: ads.meta.source,
        dataAsOf: ads.meta.dataAsOf,
        campaignCount: ads.topCampaigns.length,
        message: ads.topCampaigns.length ? null : ads.meta.message,
      },
      productSignals,
      productSignalsMeta: {
        status: measured.length ? catalog.meta.status : snapshotService.STATUS.UNAVAILABLE,
        evaluatedProducts: measured.length,
        catalogProducts: catalog.products.length,
        message: measured.length
          ? null
          : 'Belum ada snapshot metrik produk. Jalankan Sync performa produk agar sinyal listing dapat dihitung.',
      },
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

module.exports = wrapHandlers({
  getProductOpts,
  getStoreOpts,
  getAdsOpts,
  applyOpt,
  getMarketplaceInsights,
  getCompetitorInsights,
  refreshCompetitorInsights,
});
