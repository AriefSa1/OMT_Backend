const prisma = require('../utils/prisma');

const STATUS = {
  FRESH: 'Segar',
  PENDING: 'Tertunda',
  CONNECTION: 'Perlu Koneksi',
  FAILED: 'Gagal',
  UNAVAILABLE: 'Tidak Tersedia',
};

const SOURCE = {
  SHOPEE: 'SHOPEE_SNAPSHOT',
  ADS: 'SHOPEE_ADS_SNAPSHOT',
  WAREHOUSE: 'WAREHOUSE_SNAPSHOT',
  DATABASE: 'DATABASE',
};

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function maxDate(values) {
  const valid = values.filter(Boolean).map((value) => new Date(value)).filter((value) => !Number.isNaN(value.valueOf()));
  if (!valid.length) return null;
  return new Date(Math.max(...valid.map((value) => value.valueOf())));
}

function normalizeRate(value) {
  const parsed = number(value);
  return parsed > 0 && parsed <= 1 ? parsed * 100 : parsed;
}

function freshnessMeta({ source, dataAsOf, connectionReady = true, hasData = true, failedAt = null, freshnessMinutes = 30, message = null }) {
  const asOf = dataAsOf ? new Date(dataAsOf) : null;
  const ageMinutes = asOf && !Number.isNaN(asOf.valueOf())
    ? Math.max(0, Math.round((Date.now() - asOf.valueOf()) / 60000))
    : null;
  const failedAfterData = failedAt && (!asOf || new Date(failedAt) > asOf);

  let status = STATUS.FRESH;
  if (!connectionReady) status = STATUS.CONNECTION;
  else if (failedAfterData) status = STATUS.FAILED;
  else if (!hasData) status = STATUS.UNAVAILABLE;
  else if (ageMinutes !== null && ageMinutes > freshnessMinutes) status = STATUS.PENDING;

  return {
    source,
    dataAsOf: asOf ? asOf.toISOString() : null,
    freshness: status,
    status,
    ageMinutes,
    message: message || (status === STATUS.FRESH
      ? 'Snapshot lokal siap digunakan.'
      : status === STATUS.PENDING
        ? 'Snapshot tersedia, namun perlu diperbarui melalui Sync.'
        : status === STATUS.CONNECTION
          ? 'Hubungkan sumber data di Pengaturan lalu jalankan Sync.'
          : status === STATUS.FAILED
            ? 'Sinkronisasi terakhir gagal. Data sebelumnya tetap ditampilkan.'
            : 'Belum ada snapshot yang dapat ditampilkan.'),
  };
}

function getLatestBy(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    const value = item[key];
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

class SnapshotService {
  async getContext() {
    const [session, latestShopeeLog, latestAdsLog, latestWarehouseLog] = await Promise.all([
      prisma.storeSession.findFirst({ where: { isActive: true }, orderBy: { updatedAt: 'desc' } }),
      prisma.syncJobLog.findFirst({ where: { jobType: 'SHOPEE_SYNC' }, orderBy: { timestamp: 'desc' } }),
      prisma.syncJobLog.findFirst({ where: { jobType: 'ADS_SYNC' }, orderBy: { timestamp: 'desc' } }),
      prisma.syncJobLog.findFirst({ where: { jobType: 'WAREHOUSE_SYNC' }, orderBy: { timestamp: 'desc' } }),
    ]);
    return { session, latestShopeeLog, latestAdsLog, latestWarehouseLog };
  }

  async getCatalogSnapshot({ page = 1, limit = 24, search = '', sort = 'updatedAt', direction = 'desc' } = {}) {
    const { session, latestShopeeLog } = await this.getContext();
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 24));
    const where = {
      ...(session?.storeId ? { storeId: session.storeId } : {}),
      ...(search ? { name: { contains: String(search) } } : {}),
    };
    const allowedSort = new Set(['updatedAt', 'name', 'price', 'stock', 'salesCount', 'views']);
    const orderBy = { [allowedSort.has(sort) ? sort : 'updatedAt']: direction === 'asc' ? 'asc' : 'desc' };
    const [total, products, metrics] = await Promise.all([
      prisma.shopeeProduct.count({ where }),
      prisma.shopeeProduct.findMany({ where, orderBy, skip: (safePage - 1) * safeLimit, take: safeLimit }),
      prisma.productMetricSnapshot.findMany({
        where: session?.storeId ? { storeId: session.storeId } : {},
        orderBy: { dataAsOf: 'desc' },
        take: 500,
      }),
    ]);
    const latestMetrics = new Map(getLatestBy(metrics, 'shopeeItemId').map((metric) => [metric.shopeeItemId, metric]));
    const dataAsOf = maxDate([metrics[0]?.dataAsOf, session?.lastSyncedAt]);
    const meta = freshnessMeta({
      source: SOURCE.SHOPEE,
      dataAsOf,
      connectionReady: Boolean(session),
      hasData: total > 0,
      failedAt: latestShopeeLog?.status === 'FAILED' ? latestShopeeLog.timestamp : null,
      freshnessMinutes: 45,
    });

    return {
      products: products.map((product) => ({
        ...product,
        metric: latestMetrics.get(product.shopeeItemId) || null,
        economics: {
          unitCost: product.unitCost,
          unitAdCost: product.unitAdCost,
          shippingCost: product.shippingCost,
          platformFeePercent: product.platformFeePercent,
        },
      })),
      pagination: { page: safePage, limit: safeLimit, total, totalPages: Math.max(1, Math.ceil(total / safeLimit)) },
      meta,
    };
  }

  async getProductSnapshot(itemId) {
    const [product, metrics] = await Promise.all([
      prisma.shopeeProduct.findUnique({ where: { shopeeItemId: String(itemId) } }),
      prisma.productMetricSnapshot.findMany({
        where: { shopeeItemId: String(itemId) },
        orderBy: { date: 'desc' },
        take: 30,
      }),
    ]);
    if (!product) return null;
    const session = await prisma.storeSession.findUnique({ where: { storeId: product.storeId } });
    const latestMetric = metrics[0] || null;
    const meta = freshnessMeta({
      source: SOURCE.SHOPEE,
      dataAsOf: maxDate([session?.lastSyncedAt, latestMetric?.dataAsOf]),
      hasData: true,
      connectionReady: true,
      freshnessMinutes: 45,
    });
    const unitCost = number(product.unitCost);
    const unitAdCost = number(product.unitAdCost);
    const shippingCost = number(product.shippingCost);
    const feeAmount = number(product.price) * (number(product.platformFeePercent) / 100);
    const estimatedMargin = product.unitCost === null && product.unitAdCost === null && product.shippingCost === null && product.platformFeePercent === null
      ? null
      : number(product.price) - unitCost - unitAdCost - shippingCost - feeAmount;
    return {
      product: {
        ...product,
        metric: latestMetric,
        metricHistory: metrics,
        economics: {
          unitCost: product.unitCost,
          unitAdCost: product.unitAdCost,
          shippingCost: product.shippingCost,
          platformFeePercent: product.platformFeePercent,
          estimatedMargin,
          estimatedMarginPercent: estimatedMargin === null || !number(product.price) ? null : (estimatedMargin / number(product.price)) * 100,
        },
      },
      meta,
    };
  }

  async getAdsSnapshot() {
    const { session, latestAdsLog } = await this.getContext();
    const where = session?.storeId ? { storeId: session.storeId } : {};
    const [latest, rows] = await Promise.all([
      prisma.shopeeAdsData.findFirst({ where, orderBy: { dataAsOf: 'desc' } }),
      prisma.shopeeAdsData.findMany({ where, orderBy: { date: 'desc' }, take: 30 }),
    ]);
    const campaignWhere = latest && session?.storeId ? { storeId: session.storeId, date: latest.date } : { id: '__missing__' };
    const campaigns = latest ? await prisma.shopeeAdsCampaignSnapshot.findMany({ where: campaignWhere, orderBy: [{ spend: 'desc' }, { name: 'asc' }] }) : [];
    const divisor = latest?.amountDivisor || 100000;
    const meta = freshnessMeta({
      source: SOURCE.ADS,
      dataAsOf: latest?.dataAsOf || latest?.createdAt,
      connectionReady: Boolean(session),
      hasData: Boolean(latest),
      failedAt: latestAdsLog?.status === 'FAILED' ? latestAdsLog.timestamp : null,
      freshnessMinutes: 24 * 60,
      message: latest
        ? null
        : 'Belum ada snapshot iklan. Jalankan Sync untuk mengambil kampanye aktif dari Seller Center.',
    });
    return {
      totalSpend: latest ? number(latest.spend) : null,
      totalSalesGenerated: latest ? number(latest.sales) : null,
      roas: latest ? number(latest.roas) : null,
      impressions: latest ? number(latest.impressions) : null,
      clicks: latest ? number(latest.clicks) : null,
      ctr: latest ? normalizeRate(latest.ctr) : null,
      voucherSpend: latest ? number(latest.voucherSpend) : null,
      voucherSales: latest ? number(latest.voucherSales) : null,
      amountAudit: latest ? {
        rawSpend: number(latest.rawSpend),
        rawSales: number(latest.rawSales),
        rawVoucherSpend: number(latest.rawVoucherSpend),
        rawVoucherSales: number(latest.rawVoucherSales),
        divisor,
      } : null,
      topCampaigns: campaigns.map((campaign) => ({ ...campaign, ctr: normalizeRate(campaign.ctr) })),
      history: rows.reverse().map((row) => ({
        date: row.date,
        spend: number(row.spend),
        sales: number(row.sales),
        roas: number(row.roas),
        ctr: normalizeRate(row.ctr),
        dataAsOf: row.dataAsOf,
      })),
      meta,
    };
  }

  async getWarehouseSnapshot({ page = 1, limit = 24, search = '' } = {}) {
    const { latestWarehouseLog } = await this.getContext();
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 24));
    const where = search ? { OR: [{ name: { contains: String(search) } }, { sku: { contains: String(search) } }] } : {};
    const [total, items, latestItem, reconciliationRows, aggregate] = await Promise.all([
      prisma.warehouseItem.count({ where }),
      prisma.warehouseItem.findMany({ where, orderBy: { lastUpdated: 'desc' }, skip: (safePage - 1) * safeLimit, take: safeLimit }),
      prisma.warehouseItem.findFirst({ orderBy: { lastUpdated: 'desc' }, select: { lastUpdated: true } }),
      prisma.stockReconciliation.findMany({ orderBy: { checkedAt: 'desc' }, take: 500 }),
      prisma.warehouseItem.aggregate({ where, _sum: { totalStock: true, availableStock: true } }),
    ]);
    const reconciliations = getLatestBy(reconciliationRows, 'sku');
    const reconciliationBySku = new Map(reconciliations.map((row) => [row.sku, row]));
    const dataAsOf = maxDate([latestItem?.lastUpdated, reconciliationRows[0]?.checkedAt]);
    const meta = freshnessMeta({
      source: SOURCE.WAREHOUSE,
      dataAsOf,
      connectionReady: true,
      hasData: total > 0,
      failedAt: latestWarehouseLog?.status === 'FAILED' ? latestWarehouseLog.timestamp : null,
      freshnessMinutes: 45,
    });
    return {
      items: items.map((item) => ({ ...item, reconciliation: reconciliationBySku.get(item.sku) || null })),
      totals: {
        skus: total,
        totalPhysicalUnits: number(aggregate._sum.totalStock),
        totalAvailableUnits: number(aggregate._sum.availableStock),
        discrepanciesCount: reconciliations.filter((row) => row.status !== 'MATCHED').length,
      },
      reconciliation: reconciliations,
      pagination: { page: safePage, limit: safeLimit, total, totalPages: Math.max(1, Math.ceil(total / safeLimit)) },
      meta,
    };
  }

  buildProductRecommendations(products) {
    const recommendations = [];
    for (const product of products) {
      const metric = product.metric;
      if (metric && number(metric.impressions) >= 100 && normalizeRate(metric.ctr) > 0 && normalizeRate(metric.ctr) < 1) {
        recommendations.push({
          id: `PRODUCT-CTR-${product.shopeeItemId}`,
          type: 'LISTING_CTR', priority: 'MEDIUM', source: 'KATALOG_SHOPEE', entityType: 'PRODUCT', entityId: product.shopeeItemId,
          title: `Perbaiki daya tarik listing: ${product.name}`,
          description: `${number(metric.impressions)} impresi dengan CTR ${normalizeRate(metric.ctr).toFixed(2)}%. Tinjau gambar utama, kata kunci judul, dan harga tampil.`,
        });
      }
      if (metric && number(metric.addToCartBuyers) > 0 && number(metric.confirmedOrders) === 0) {
        recommendations.push({
          id: `PRODUCT-CART-${product.shopeeItemId}`,
          type: 'CONVERSION_REVIEW', priority: 'HIGH', source: 'KATALOG_SHOPEE', entityType: 'PRODUCT', entityId: product.shopeeItemId,
          title: `Tinjau hambatan checkout: ${product.name}`,
          description: `${number(metric.addToCartBuyers)} pembeli menambahkan ke keranjang tanpa pesanan terkonfirmasi pada snapshot terakhir.`,
        });
      }
      if (number(product.stock) <= 3 && number(product.salesCount) > 0) {
        recommendations.push({
          id: `PRODUCT-STOCK-${product.shopeeItemId}`,
          type: 'STOCK_RISK', priority: number(product.stock) === 0 ? 'HIGH' : 'MEDIUM', source: 'KATALOG_SHOPEE', entityType: 'PRODUCT', entityId: product.shopeeItemId,
          title: `Cegah kehabisan stok: ${product.name}`,
          description: `Stok katalog tersisa ${number(product.stock)} unit dengan ${number(product.salesCount)} penjualan tercatat.`,
        });
      }
    }
    return recommendations.slice(0, 50);
  }

  buildAdsRecommendations(campaigns) {
    return campaigns.filter((campaign) => number(campaign.spend) > 0 && (normalizeRate(campaign.ctr) < 1 || number(campaign.roas) < 2)).map((campaign) => ({
      id: `ADS-${campaign.campaignId}`,
      type: normalizeRate(campaign.ctr) < 1 ? 'ADS_CTR' : 'ADS_ROAS',
      priority: number(campaign.roas) < 1 ? 'HIGH' : 'MEDIUM',
      source: 'IKLAN_SHOPEE', entityType: 'CAMPAIGN', entityId: campaign.campaignId,
      title: `Tinjau kampanye: ${campaign.name}`,
      description: `CTR ${normalizeRate(campaign.ctr).toFixed(2)}%, ROAS ${number(campaign.roas).toFixed(2)}x, biaya ${number(campaign.spend).toFixed(0)} pada snapshot terakhir.`,
    })).slice(0, 30);
  }

  async getActionSnapshot() {
    const [catalog, ads, warehouse, tasks] = await Promise.all([
      this.getCatalogSnapshot({ page: 1, limit: 100, sort: 'updatedAt' }),
      this.getAdsSnapshot(),
      this.getWarehouseSnapshot({ page: 1, limit: 100 }),
      prisma.optimizationTask.findMany({
        include: { events: { orderBy: { createdAt: 'desc' }, take: 5 } },
        orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
        take: 200,
      }),
    ]);
    const warehouseRecommendations = warehouse.reconciliation
      .filter((row) => row.status !== 'MATCHED')
      .map((row) => ({
        id: `WAREHOUSE-${row.sku}`,
        type: 'STOCK_RECONCILIATION', priority: row.status === 'CRITICAL' ? 'HIGH' : 'MEDIUM', source: 'GUDANG', entityType: 'SKU', entityId: row.sku,
        title: `Selisih stok: ${row.sku}`,
        description: `Stok Shopee ${number(row.shopeeStock)}, stok gudang ${number(row.warehouseStock)}, selisih ${number(row.variance)} unit.`,
      }));
    return {
      recommendations: [
        ...this.buildProductRecommendations(catalog.products),
        ...this.buildAdsRecommendations(ads.topCampaigns),
        ...warehouseRecommendations,
      ],
      tasks,
      sources: { catalog: catalog.meta, ads: ads.meta, warehouse: warehouse.meta },
    };
  }

  async getDashboardOverview() {
    const [context, catalog, ads, warehouse, orders] = await Promise.all([
      this.getContext(),
      this.getCatalogSnapshot({ page: 1, limit: 8, sort: 'salesCount' }),
      this.getAdsSnapshot(),
      this.getWarehouseSnapshot({ page: 1, limit: 8 }),
      prisma.shopeeOrderSummary.findMany({ orderBy: { date: 'desc' }, take: 30 }),
    ]);
    const latestOrder = orders[0] || null;
    const adByDate = new Map(ads.history.map((row) => [row.date, row]));
    const salesTrend = orders.reverse().map((row) => ({
      day: row.date,
      gmv: number(row.gmv),
      orders: number(row.orderCount),
      adSpend: number(adByDate.get(row.date)?.spend),
    }));
    const categoryTotals = catalog.products.reduce((acc, product) => {
      const category = product.category || 'Tanpa kategori';
      acc[category] = (acc[category] || 0) + number(product.salesCount);
      return acc;
    }, {});
    const categoryDenominator = Object.values(categoryTotals).reduce((sum, value) => sum + number(value), 0);
    const categorySales = categoryDenominator ? Object.entries(categoryTotals).map(([name, value]) => ({ name, value: Math.round((number(value) / categoryDenominator) * 100) })) : [];
    return {
      storeName: context.session?.storeName || 'Toko belum terhubung',
      lastSyncedAt: maxDate([context.latestShopeeLog?.timestamp, context.latestAdsLog?.timestamp, context.latestWarehouseLog?.timestamp]),
      dataState: { catalog: catalog.meta, ads: ads.meta, warehouse: warehouse.meta },
      kpis: {
        totalGmv: latestOrder ? number(latestOrder.gmv) : null,
        totalOrders: latestOrder ? number(latestOrder.orderCount) : null,
        conversionRate: latestOrder ? normalizeRate(latestOrder.conversionRate) : null,
        averageOrderValue: latestOrder ? number(latestOrder.averageOrderValue) : null,
        roas: ads.roas,
        adSpend: ads.totalSpend,
        warehouseUnits: warehouse.totals.totalAvailableUnits,
        discrepanciesAlerts: warehouse.totals.discrepanciesCount,
      },
      history: {
        orderAvailable: Boolean(latestOrder),
        message: latestOrder ? null : 'Data GMV dan pesanan belum tersedia karena endpoint ringkasan pesanan belum terhubung.',
      },
      salesTrend,
      categorySales,
      adsMetrics: ads,
      topProducts: catalog.products,
      reconciliationSummary: warehouse.totals,
    };
  }
}

module.exports = new SnapshotService();
module.exports.STATUS = STATUS;
module.exports.dateKey = dateKey;
module.exports.normalizeRate = normalizeRate;
