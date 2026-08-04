const prisma = require('../utils/prisma');
const shopeeService = require('./shopeeService');
const shopeeInsightsService = require('./shopeeInsightsService');
const warehouseService = require('./warehouseService');
const snapshotService = require('./snapshotService');

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRate(value) {
  const parsed = number(value);
  return parsed > 0 && parsed <= 1 ? parsed * 100 : parsed;
}

function firstValue(value, keys) {
  for (const key of keys) {
    const candidate = value?.[key];
    if (candidate !== undefined && candidate !== null && String(candidate).trim()) return candidate;
  }
  return null;
}

function findNestedValue(value, matcher, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findNestedValue(entry, matcher, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (matcher(key) && candidate !== undefined && candidate !== null && String(candidate).trim()) return candidate;
    if (candidate && typeof candidate === 'object') {
      const found = findNestedValue(candidate, matcher, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function findNestedCategoryPath(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return [];
  if (Array.isArray(value)) return [];
  for (const [key, candidate] of Object.entries(value)) {
    if (Array.isArray(candidate) && /categor(y|ies).*(path|list)|cat.*path/i.test(key)) return candidate;
    if (candidate && typeof candidate === 'object') {
      const path = findNestedCategoryPath(candidate, depth + 1);
      if (path.length) return path;
    }
  }
  return [];
}

function categoryValue(row, level, field = 'id') {
  const group = row?.[`l${level}_category`] || row?.[`category_l${level}`] || row?.[`level_${level}_category`] || {};
  const identifiers = [`l${level}_category_id`, `l${level}catid`, `l${level}_cat_id`, `category_l${level}_id`, `level_${level}_category_id`];
  const names = [`l${level}_category_name`, `l${level}_category_display_name`, `category_l${level}_name`, `level_${level}_category_name`];
  const direct = firstValue(row, field === 'id' ? identifiers : names);
  if (direct) return String(direct);
  const groupValue = firstValue(group, field === 'id' ? ['id', 'category_id', 'catid'] : ['display_name', 'name']);
  if (groupValue) return String(groupValue);
  const nested = findNestedValue(row, (key) => field === 'id'
    ? new RegExp(`(^|_)l?${level}(_|$).*?(category|cat).*?(id)?$|^(category|cat).*?l?${level}.*?(id)?$`, 'i').test(key)
    : new RegExp(`(^|_)(l?${level}).*?(category|cat).*?(name|display)|^(category|cat).*?l?${level}.*?(name|display)`, 'i').test(key));
  if (nested) return String(nested);
  const path = findNestedCategoryPath(row);
  const entry = path.find((item) => Number(item?.level ?? item?.category_level) === level) || path[level] || path[level - 1];
  if (!entry) return null;
  const pathValue = field === 'id' ? firstValue(entry, ['id', 'category_id', 'catid']) : firstValue(entry, ['display_name', 'name']);
  return pathValue ? String(pathValue) : null;
}

function asDateKey(date = new Date()) {
  return snapshotService.dateKey(date);
}

class SyncService {
  async writeLog(jobType, status, message, timestamp = new Date()) {
    return prisma.syncJobLog.create({ data: { jobType, status, message, timestamp } });
  }

  async persistProductMetrics(storeId, performance = []) {
    if (!storeId || !Array.isArray(performance) || !performance.length) return 0;
    const date = asDateKey();
    const dataAsOf = new Date();
    const knownProducts = await prisma.shopeeProduct.findMany({
      where: { storeId },
      select: { shopeeItemId: true, name: true, category: true },
    });
    const byId = new Map(knownProducts.map((product) => [product.shopeeItemId, product]));
    const byName = new Map(knownProducts.map((product) => [product.name.trim().toLowerCase(), product]));
    const productUpdates = [];
    const records = performance.map((row) => {
      const itemId = String(row.item_id ?? row.itemid ?? row.product_id ?? row.id ?? '');
      const matched = byId.get(itemId) || byName.get(String(row.name || row.product_name || '').trim().toLowerCase());
      if (!matched) return null;
      const l2CategoryId = categoryValue(row, 2, 'id');
      const l3CategoryId = categoryValue(row, 3, 'id');
      const l2CategoryName = categoryValue(row, 2, 'name');
      const l3CategoryName = categoryValue(row, 3, 'name');
      if (l2CategoryId || l3CategoryId || l2CategoryName || l3CategoryName) {
        productUpdates.push(prisma.shopeeProduct.update({
          where: { shopeeItemId: matched.shopeeItemId },
          data: {
            ...(l2CategoryId ? { l2CategoryId } : {}),
            ...(l3CategoryId ? { l3CategoryId } : {}),
            ...(l2CategoryName ? { l2CategoryName } : {}),
            ...(l3CategoryName ? { l3CategoryName } : {}),
          },
        }));
      }
      const impressions = number(row.product_card_impressions ?? row.impressions ?? row.impression);
      const clicks = number(row.clicks ?? row.product_click);
      return {
        storeId,
        shopeeItemId: matched.shopeeItemId,
        date,
        productName: matched.name,
        category: matched.category || 'Tanpa kategori',
        impressions,
        clicks,
        ctr: normalizeRate(row.ctr ?? (impressions > 0 ? (clicks / impressions) * 100 : 0)),
        bounceRate: normalizeRate(row.bounce_rate),
        addToCartBuyers: number(row.add_to_cart_buyers ?? row.add_to_cart),
        confirmedOrders: number(row.confirmed_orders ?? row.order_count),
        confirmedSales: number(row.confirmed_sales ?? row.confirmed_gmv ?? row.sales),
        conversionRate: normalizeRate(row.conversion_rate),
        dataAsOf,
      };
    }).filter(Boolean);
    if (!records.length) return 0;
    await prisma.$transaction([
      ...records.map((record) => prisma.productMetricSnapshot.upsert({
      where: { storeId_shopeeItemId_date: { storeId: record.storeId, shopeeItemId: record.shopeeItemId, date: record.date } },
      update: record,
      create: record,
      })),
      ...productUpdates,
    ]);
    return records.length;
  }

  async persistAdsSnapshot(metrics) {
    if (!metrics?.success || !metrics.storeId) return null;
    const date = asDateKey();
    const dataAsOf = new Date();
    const total = {
      storeId: metrics.storeId,
      date,
      spend: number(metrics.totalSpend),
      sales: number(metrics.totalSalesGenerated),
      roas: number(metrics.roas),
      impressions: number(metrics.impressions),
      clicks: number(metrics.clicks),
      ctr: normalizeRate(metrics.ctr),
      rawSpend: number(metrics.rawSpend),
      rawSales: number(metrics.rawSales),
      rawVoucherSpend: number(metrics.rawVoucherSpend),
      rawVoucherSales: number(metrics.rawVoucherSales),
      amountDivisor: number(metrics.amountDivisor) || 100000,
      voucherSpend: number(metrics.voucherSpend),
      voucherSales: number(metrics.voucherSales),
      dataAsOf,
    };
    await prisma.$transaction([
      prisma.shopeeAdsData.upsert({
        where: { storeId_date: { storeId: total.storeId, date } },
        update: total,
        create: total,
      }),
      ...metrics.topCampaigns.map((campaign) => prisma.shopeeAdsCampaignSnapshot.upsert({
        where: { storeId_campaignId_date: { storeId: metrics.storeId, campaignId: campaign.id, date } },
        update: {
          name: campaign.name,
          type: campaign.type,
          state: campaign.state,
          dailyBudget: number(campaign.dailyBudget),
          spend: number(campaign.spend),
          sales: number(campaign.sales),
          rawSpend: number(campaign.rawSpend),
          rawSales: number(campaign.rawSales),
          rawDailyBudget: number(campaign.rawDailyBudget),
          amountDivisor: number(campaign.amountDivisor) || 100000,
          impressions: number(campaign.impressions),
          clicks: number(campaign.clicks),
          ctr: normalizeRate(campaign.ctr),
          roas: number(campaign.roas),
          voucherSpend: number(campaign.voucherSpend),
          voucherSales: number(campaign.voucherSales),
          rawVoucherSpend: number(campaign.rawVoucherSpend),
          rawVoucherSales: number(campaign.rawVoucherSales),
          dataAsOf,
        },
        create: {
          storeId: metrics.storeId,
          campaignId: campaign.id,
          date,
          name: campaign.name,
          type: campaign.type,
          state: campaign.state,
          dailyBudget: number(campaign.dailyBudget),
          spend: number(campaign.spend),
          sales: number(campaign.sales),
          rawSpend: number(campaign.rawSpend),
          rawSales: number(campaign.rawSales),
          rawDailyBudget: number(campaign.rawDailyBudget),
          amountDivisor: number(campaign.amountDivisor) || 100000,
          impressions: number(campaign.impressions),
          clicks: number(campaign.clicks),
          ctr: normalizeRate(campaign.ctr),
          roas: number(campaign.roas),
          voucherSpend: number(campaign.voucherSpend),
          voucherSales: number(campaign.voucherSales),
          rawVoucherSpend: number(campaign.rawVoucherSpend),
          rawVoucherSales: number(campaign.rawVoucherSales),
          dataAsOf,
        },
      })),
    ]);
    return { date, campaignCount: metrics.topCampaigns.length, dataAsOf };
  }

  async persistWarehouseSnapshots(items, source) {
    if (!Array.isArray(items) || !items.length) return 0;
    const date = asDateKey();
    const dataAsOf = new Date();
    const records = items.filter((item) => item.sku).map((item) => ({
      sku: String(item.sku),
      date,
      name: item.name || '',
      totalStock: number(item.totalStock),
      reservedStock: number(item.reservedStock),
      availableStock: number(item.availableStock ?? item.warehouseStock),
      source: source || 'WAREHOUSE_API',
      dataAsOf,
    }));
    await prisma.$transaction(records.map((record) => prisma.warehouseStockSnapshot.upsert({
      where: { sku_date: { sku: record.sku, date: record.date } },
      update: record,
      create: record,
    })));
    return records.length;
  }

  async syncShopee({ origin = 'MANUAL' } = {}) {
    const timestamp = new Date();
    try {
      const metrics = await shopeeService.fetchLiveShopeeMetrics();
      if (!metrics.isRealDataActive) {
        await this.writeLog('SHOPEE_SYNC', 'FAILED', metrics.message || 'Sinkronisasi katalog Shopee gagal.', timestamp);
        return { success: false, source: 'Shopee', status: 'Gagal', message: metrics.message, origin };
      }
      const intelligence = await shopeeInsightsService.getMarketplaceInsights();
      const metricCount = intelligence.source === 'SHOPEE_API'
        ? await this.persistProductMetrics(metrics.storeId, intelligence.productPerformance)
        : 0;
      const message = metricCount
        ? `Katalog disinkronkan bersama ${metricCount} snapshot performa produk.`
        : 'Katalog disinkronkan. Snapshot performa produk belum tersedia dari Seller Center.';
      await this.writeLog('SHOPEE_SYNC', intelligence.source === 'SHOPEE_API' ? 'SUCCESS' : 'DEGRADED', message, timestamp);
      return { success: true, source: 'Shopee', status: intelligence.source === 'SHOPEE_API' ? 'Segar' : 'Tertunda', message, productCount: metrics.products.length, metricCount, origin };
    } catch (err) {
      await this.writeLog('SHOPEE_SYNC', 'FAILED', err.message, timestamp);
      return { success: false, source: 'Shopee', status: 'Gagal', message: 'Sinkronisasi Shopee gagal.', origin };
    }
  }

  async syncAds({ origin = 'MANUAL' } = {}) {
    const timestamp = new Date();
    try {
      const metrics = await shopeeService.fetchShopeeAdsMetrics();
      if (!metrics.success) {
        await this.writeLog('ADS_SYNC', 'FAILED', metrics.message || 'Sinkronisasi iklan gagal.', timestamp);
        return { success: false, source: 'Iklan Shopee', status: 'Gagal', message: metrics.message, origin };
      }
      const result = await this.persistAdsSnapshot(metrics);
      const message = `${result.campaignCount} kampanye iklan disinkronkan. Nilai nominal dinormalisasi dengan pembagi ${metrics.amountDivisor}.`;
      await this.writeLog('ADS_SYNC', 'SUCCESS', message, timestamp);
      return { success: true, source: 'Iklan Shopee', status: 'Segar', message, campaignCount: result.campaignCount, origin };
    } catch (err) {
      await this.writeLog('ADS_SYNC', 'FAILED', err.message, timestamp);
      return { success: false, source: 'Iklan Shopee', status: 'Gagal', message: 'Sinkronisasi iklan gagal.', origin };
    }
  }

  async syncWarehouse({ origin = 'MANUAL' } = {}) {
    const timestamp = new Date();
    try {
      const reconciliation = await warehouseService.calculateReconciliation();
      const snapshotCount = await this.persistWarehouseSnapshots(reconciliation.reconciliationList, reconciliation.dataSource);
      const isLive = reconciliation.dataSource === 'WAREHOUSE_API';
      const status = isLive ? 'SUCCESS' : 'DEGRADED';
      const message = isLive
        ? `Gudang disinkronkan dengan ${reconciliation.discrepanciesCount} selisih stok.`
        : `Snapshot stok tersimpan dari baseline katalog; koneksi gudang belum tersedia (${reconciliation.discrepanciesCount} selisih).`;
      await this.writeLog('WAREHOUSE_SYNC', status, message, timestamp);
      return {
        success: true,
        source: 'Gudang',
        status: isLive ? 'Segar' : 'Tertunda',
        message,
        snapshotCount,
        discrepanciesCount: reconciliation.discrepanciesCount,
        origin,
      };
    } catch (err) {
      await this.writeLog('WAREHOUSE_SYNC', 'FAILED', err.message, timestamp);
      return { success: false, source: 'Gudang', status: 'Gagal', message: 'Sinkronisasi gudang gagal.', origin };
    }
  }

  async syncAll({ origin = 'MANUAL' } = {}) {
    const startedAt = new Date();
    const shopee = await this.syncShopee({ origin });
    const ads = await this.syncAds({ origin });
    const warehouse = await this.syncWarehouse({ origin });
    const results = [shopee, ads, warehouse];
    const successCount = results.filter((result) => result.success).length;
    const status = successCount === results.length ? 'SUCCESS' : successCount ? 'DEGRADED' : 'FAILED';
    const message = `${successCount}/${results.length} sumber selesai disinkronkan.`;
    await this.writeLog('FULL_SYNC', status, message, startedAt);
    return { success: successCount > 0, status, message, startedAt: startedAt.toISOString(), results };
  }
}

module.exports = new SyncService();
