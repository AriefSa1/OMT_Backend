const prisma = require('../utils/prisma');
const {
  ACTIVE_WAREHOUSES,
  ACTIVE_WAREHOUSE_ID_LIST,
  isActiveWarehouseId,
} = require('../constants/warehouseConstants');

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
  let latest = valid[0].valueOf();
  for (let index = 1; index < valid.length; index++) {
    latest = Math.max(latest, valid[index].valueOf());
  }
  return new Date(latest);
}

function shiftDateKey(value, days) {
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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
    const [session, latestShopeeLog, latestAdsLog, latestWarehouseLog, configRows] = await Promise.all([
      prisma.storeSession.findFirst({ where: { isActive: true }, orderBy: { updatedAt: 'desc' } }),
      prisma.syncJobLog.findFirst({ where: { jobType: 'SHOPEE_SYNC' }, orderBy: { timestamp: 'desc' } }),
      prisma.syncJobLog.findFirst({ where: { jobType: 'ADS_SYNC' }, orderBy: { timestamp: 'desc' } }),
      prisma.syncJobLog.findFirst({ where: { jobType: 'WAREHOUSE_SYNC' }, orderBy: { timestamp: 'desc' } }),
      prisma.systemConfig.findMany({
        where: { key: { in: ['warehouseLoginUrl', 'warehouseInventoryUrl', 'warehouseUsername', 'warehousePassword'] } },
        select: { key: true, value: true },
      }),
    ]);
    const config = Object.fromEntries(configRows.map((row) => [row.key, row.value]));
    const warehouseConfigured = Boolean(
      config.warehouseLoginUrl
      && config.warehouseInventoryUrl
      && config.warehouseUsername
      && config.warehousePassword
    );
    return { session, latestShopeeLog, latestAdsLog, latestWarehouseLog, warehouseConfigured };
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

  async getProductPerformanceSnapshot({
    period = 'real_time',
    keyword = '',
    pageSize = 10,
    pageNum = 1,
    orderBy = 'confirmed_sales.desc',
  } = {}) {
    const session = await prisma.storeSession.findFirst({ where: { isActive: true }, orderBy: { updatedAt: 'desc' } });
    const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 10));
    const safePageNum = Math.max(1, Number(pageNum) || 1);
    const endDate = dateKey();
    const days = period === 'yesterday' ? 1 : period === 'past30days' ? 30 : period === 'past7days' ? 7 : 0;
    const startDate = period === 'real_time'
      ? endDate
      : period === 'yesterday'
        ? shiftDateKey(endDate, -1)
        : shiftDateKey(endDate, -(days - 1));

    if (!session?.storeId) {
      return {
        success: true,
        live: false,
        isRealDataActive: false,
        dataSource: 'EMPTY',
        storeName: '',
        storeId: '',
        period,
        total: 0,
        products: [],
        summary: { totalSales: 0, totalOrders: 0, totalUnits: 0, totalViews: 0, totalVisitors: 0, totalBuyers: 0, averageConversionRate: 0 },
        pagination: { page: safePageNum, pageSize: safePageSize, total: 0, totalPages: 0 },
        message: 'Belum ada sesi Shopee aktif untuk membaca snapshot performa.',
      };
    }

    const [metrics, catalog] = await Promise.all([
      prisma.productMetricSnapshot.findMany({
        where: { storeId: session.storeId, date: { gte: startDate, lte: endDate } },
        orderBy: { dataAsOf: 'desc' },
      }),
      prisma.shopeeProduct.findMany({ where: { storeId: session.storeId } }),
    ]);
    const catalogById = new Map(catalog.map((product) => [String(product.shopeeItemId), product]));
    const aggregate = new Map();
    for (const metric of metrics) {
      const id = String(metric.shopeeItemId);
      const current = aggregate.get(id) || {
        itemId: id,
        name: metric.productName,
        sku: '',
        image: '',
        price: 0,
        itemStatus: 'SNAPSHOT',
        confirmedSales: 0,
        confirmedOrders: 0,
        confirmedUnits: 0,
        confirmedBuyers: 0,
        views: 0,
        visitors: 0,
        addToCartUnits: 0,
        addToCartRate: 0,
        conversionRate: 0,
        bounceRate: 0,
      };
      current.confirmedSales += number(metric.confirmedSales);
      current.confirmedOrders += number(metric.confirmedOrders);
      current.confirmedUnits += number(metric.confirmedUnits || 0);
      current.confirmedBuyers += number(metric.confirmedBuyers || 0);
      current.views += number(metric.views || metric.impressions);
      current.visitors += number(metric.visitors || 0);
      current.addToCartUnits += number(metric.addToCartUnits || metric.addToCartBuyers);
      current.bounceRate = number(metric.bounceRate);
      aggregate.set(id, current);
    }

    const products = [...aggregate.values()].map((item) => {
      const catalogProduct = catalogById.get(item.itemId);
      const visitors = item.visitors;
      return {
        ...item,
        name: catalogProduct?.name || item.name,
        sku: catalogProduct?.sku || '',
        image: catalogProduct?.imageUrl || '',
        price: number(catalogProduct?.price),
        addToCartRate: visitors > 0 ? (item.addToCartUnits / visitors) * 100 : 0,
        conversionRate: visitors > 0 ? (item.confirmedOrders / visitors) * 100 : 0,
      };
    }).filter((item) => {
      const query = String(keyword || '').trim().toLowerCase();
      return !query || item.name.toLowerCase().includes(query) || item.sku.toLowerCase().includes(query) || item.itemId.includes(query);
    });

    const [sortField, sortDirection = 'desc'] = String(orderBy || 'confirmed_sales.desc').split('.');
    const sortValues = {
      confirmed_sales: 'confirmedSales',
      confirmed_order: 'confirmedOrders',
      item_views: 'views',
      conversion_rate: 'conversionRate',
      add_to_cart_rate: 'addToCartRate',
    };
    const key = sortValues[sortField] || 'confirmedSales';
    products.sort((a, b) => {
      const difference = number(b[key]) - number(a[key]);
      return (sortDirection === 'asc' ? -difference : difference) || a.name.localeCompare(b.name);
    });
    products.forEach((product, index) => { product.rank = index + 1; });

    const summary = products.reduce((result, product) => ({
      totalSales: result.totalSales + number(product.confirmedSales),
      totalOrders: result.totalOrders + number(product.confirmedOrders),
      totalUnits: result.totalUnits + number(product.confirmedUnits),
      totalViews: result.totalViews + number(product.views),
      totalVisitors: result.totalVisitors + number(product.visitors),
      totalBuyers: result.totalBuyers + number(product.confirmedBuyers),
    }), { totalSales: 0, totalOrders: 0, totalUnits: 0, totalViews: 0, totalVisitors: 0, totalBuyers: 0 });
    summary.averageConversionRate = summary.totalVisitors > 0 ? (summary.totalOrders / summary.totalVisitors) * 100 : 0;
    const total = products.length;
    const offset = (safePageNum - 1) * safePageSize;

    return {
      success: true,
      live: false,
      isRealDataActive: false,
      dataSource: 'SHOPEE_SNAPSHOT',
      storeName: session.storeName,
      storeId: session.storeId,
      period,
      startTime: startDate,
      endTime: endDate,
      total,
      products: products.slice(offset, offset + safePageSize),
      summary,
      pagination: { page: safePageNum, pageSize: safePageSize, total, totalPages: Math.ceil(total / safePageSize) || 1 },
      message: 'Seller Center tidak tersedia. Menampilkan snapshot performa terakhir yang tersimpan secara lokal.',
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

  async getAdsSnapshot({ sortBy = 'spend', direction = 'desc' } = {}) {
    const { session, latestAdsLog } = await this.getContext();
    const where = session?.storeId ? { storeId: session.storeId } : {};
    const [latest, rows] = await Promise.all([
      // The business date is the authoritative snapshot key. Sorting only by
      // SQLite DateTime can select an older day when timestamps were migrated.
      prisma.shopeeAdsData.findMany({ where, orderBy: [{ date: 'desc' }, { dataAsOf: 'desc' }], take: 1 }),
      prisma.shopeeAdsData.findMany({ where, orderBy: { date: 'desc' }, take: 30 }),
    ]);
    const latestSnapshot = latest[0] || null;
    const campaignWhere = latestSnapshot && session?.storeId ? { storeId: session.storeId, date: latestSnapshot.date } : { id: '__missing__' };
    const campaignRows = latestSnapshot ? await prisma.shopeeAdsCampaignSnapshot.findMany({ where: campaignWhere }) : [];
    const sortFields = {
      name: 'name',
      state: 'state',
      dailyBudget: 'dailyBudget',
      spend: 'spend',
      sales: 'sales',
      ctr: 'ctr',
      roas: 'roas',
    };
    const sortField = sortFields[sortBy] || 'spend';
    const ascending = direction === 'asc';
    const campaigns = campaignRows.sort((left, right) => {
      const leftValue = typeof left[sortField] === 'string' ? left[sortField].toLowerCase() : number(left[sortField]);
      const rightValue = typeof right[sortField] === 'string' ? right[sortField].toLowerCase() : number(right[sortField]);
      if (leftValue === rightValue) return String(left.name).localeCompare(String(right.name));
      return (leftValue > rightValue ? 1 : -1) * (ascending ? 1 : -1);
    });
    const divisor = latestSnapshot?.amountDivisor || 100000;
    const meta = freshnessMeta({
      source: SOURCE.ADS,
      dataAsOf: latestSnapshot?.dataAsOf || latestSnapshot?.createdAt,
      connectionReady: Boolean(session),
      hasData: Boolean(latestSnapshot),
      failedAt: latestAdsLog?.status === 'FAILED' ? latestAdsLog.timestamp : null,
      freshnessMinutes: 24 * 60,
      message: latestSnapshot
        ? null
        : 'Belum ada snapshot iklan. Jalankan Sync untuk mengambil kampanye aktif dari Seller Center.',
    });
    return {
      totalSpend: latestSnapshot ? number(latestSnapshot.spend) : null,
      totalSalesGenerated: latestSnapshot ? number(latestSnapshot.sales) : null,
      roas: latestSnapshot ? number(latestSnapshot.roas) : null,
      impressions: latestSnapshot ? number(latestSnapshot.impressions) : null,
      clicks: latestSnapshot ? number(latestSnapshot.clicks) : null,
      ctr: latestSnapshot ? normalizeRate(latestSnapshot.ctr) : null,
      voucherSpend: latestSnapshot ? number(latestSnapshot.voucherSpend) : null,
      voucherSales: latestSnapshot ? number(latestSnapshot.voucherSales) : null,
      amountAudit: latestSnapshot ? {
        rawSpend: number(latestSnapshot.rawSpend),
        rawSales: number(latestSnapshot.rawSales),
        rawVoucherSpend: number(latestSnapshot.rawVoucherSpend),
        rawVoucherSales: number(latestSnapshot.rawVoucherSales),
        divisor,
      } : null,
      topCampaigns: campaigns.map((campaign) => ({ ...campaign, ctr: normalizeRate(campaign.ctr) })),
      sort: { sortBy: sortField, direction: ascending ? 'asc' : 'desc' },
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

  async getWarehouseSnapshot({ page = 1, limit = 24, search = '', type = 'all', warehouseId = 'all', teamId = 'all', sort = 'lastUpdated', sortBy = '', direction = 'desc' } = {}) {
    const { latestWarehouseLog, warehouseConfigured } = await this.getContext();
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 24));

    const activeWarehouseWhere = { warehouseId: { in: ACTIVE_WAREHOUSE_ID_LIST } };
    const where = { ...activeWarehouseWhere };
    if (search) {
      where.OR = [
        { name: { contains: String(search) } },
        { sku: { contains: String(search) } },
        { refId: { contains: String(search) } },
      ];
    }
    if (warehouseId && warehouseId !== 'all') {
      where.warehouseId = isActiveWarehouseId(warehouseId) ? Number(warehouseId) : -1;
    }
    if (teamId && teamId !== 'all') {
      where.teamId = Number(teamId);
    }

    const allMatchingRows = await prisma.warehouseItem.findMany({ where });
    const viewRows = type && type !== 'all'
      ? allMatchingRows.filter((row) => row.productType === String(type).toLowerCase())
      : allMatchingRows;

    const aggregateRows = (rows) => {
      if (warehouseId && warehouseId !== 'all') {
        return rows.map((row) => ({
          ...row,
          warehouseId: Number(row.warehouseId),
          warehouseName: ACTIVE_WAREHOUSES.find((warehouse) => warehouse.id === Number(row.warehouseId))?.name || row.warehouseName,
          stockValue: number(row.priceMin) * number(row.totalStock),
        }));
      }

      const grouped = new Map();
      for (const row of rows) {
        const existing = grouped.get(row.sku);
        if (!existing) {
          grouped.set(row.sku, {
            ...row,
            warehouseId: null,
            warehouseName: 'Multi-gudang',
            warehouseLocation: null,
            location: 'Multi-gudang',
            availableStock: number(row.availableStock),
            reservedStock: number(row.reservedStock),
            totalStock: number(row.totalStock),
            stockValue: number(row.priceMin) * number(row.totalStock),
            warehouseCount: 1,
          });
          continue;
        }
        existing.availableStock += number(row.availableStock);
        existing.reservedStock += number(row.reservedStock);
        existing.totalStock += number(row.totalStock);
        existing.stockValue += number(row.priceMin) * number(row.totalStock);
        existing.warehouseCount += 1;
        if (new Date(row.lastUpdated) > new Date(existing.lastUpdated)) existing.lastUpdated = row.lastUpdated;
      }
      return Array.from(grouped.values());
    };

    const items = aggregateRows(viewRows);
    const countRows = aggregateRows(allMatchingRows);
    const total = items.length;
    const sortAliases = {
      updated: 'lastUpdated',
      available: 'availableStock',
      total: 'totalStock',
      price: 'priceMin',
      valuation: 'stockValue',
      team: 'teamName',
      stock: 'totalStock',
      warehouse: 'warehouseName',
      name: 'name',
    };
    const sortParts = String(sortBy || sort || 'updated_desc').split('_');
    const requestedSort = sortParts[0];
    const sortField = sortAliases[requestedSort] || (['lastUpdated', 'name', 'availableStock', 'totalStock', 'priceMin', 'stockValue', 'teamName', 'warehouseName'].includes(sort) ? sort : 'lastUpdated');
    const sortDirection = sortParts[1] || direction;
    const ascending = sortDirection === 'asc';
    items.sort((left, right) => {
      const a = left[sortField];
      const b = right[sortField];
      const leftValue = a instanceof Date ? a.valueOf() : typeof a === 'string' ? a.toLowerCase() : number(a);
      const rightValue = b instanceof Date ? b.valueOf() : typeof b === 'string' ? b.toLowerCase() : number(b);
      if (leftValue === rightValue) return String(left.sku).localeCompare(String(right.sku));
      return (leftValue > rightValue ? 1 : -1) * (ascending ? 1 : -1);
    });

    const pagedItems = items.slice((safePage - 1) * safeLimit, safePage * safeLimit);
    const totalPhysicalUnits = items.reduce((sum, item) => sum + number(item.totalStock), 0);
    const totalAvailableUnits = items.reduce((sum, item) => sum + number(item.availableStock), 0);
    const totalValuation = items.reduce((sum, item) => sum + number(item.stockValue), 0);
    const countByType = (productType) => countRows.filter((item) => item.productType === productType).length;
    const whCountMap = new Map(ACTIVE_WAREHOUSES.map((warehouse) => [warehouse.id, new Set()]));
    for (const row of allMatchingRows) {
      const warehouseSet = whCountMap.get(Number(row.warehouseId));
      if (warehouseSet) warehouseSet.add(row.sku);
    }
    const enrichedWarehouses = ACTIVE_WAREHOUSES.map((warehouse) => ({
      id: warehouse.id,
      name: warehouse.name,
      count: whCountMap.get(warehouse.id)?.size || 0,
    }));

    const teamMap = new Map();
    for (const item of countRows) {
      if (!item.teamId) continue;
      const current = teamMap.get(item.teamId) || { id: item.teamId, name: item.teamName || `Team ${item.teamId}`, code: item.teamCode, count: 0 };
      current.count += 1;
      teamMap.set(item.teamId, current);
    }
    const teamsList = Array.from(teamMap.values()).sort((a, b) => Number(a.id) - Number(b.id));

    const reconciliationRows = await prisma.$queryRaw`
      SELECT sr.*
      FROM "StockReconciliation" sr
      INNER JOIN (
        SELECT "sku", "warehouseId", MAX("checkedAt") AS "latestCheckedAt"
        FROM "StockReconciliation"
        WHERE "warehouseId" IN (38, 94, 67, 96)
        GROUP BY "sku", "warehouseId"
      ) latest
        ON latest."sku" = sr."sku"
        AND latest."warehouseId" = sr."warehouseId"
        AND latest."latestCheckedAt" = sr."checkedAt"
      WHERE sr."warehouseId" IN (38, 94, 67, 96)
      ORDER BY sr."checkedAt" DESC
    `;
    const latestReconByKey = new Map();
    for (const row of reconciliationRows) {
      const key = `${row.sku}:${row.warehouseId || 'none'}`;
      if (!latestReconByKey.has(key)) latestReconByKey.set(key, row);
    }
    const reconciliationForItem = (item) => {
      if (item.warehouseId) return latestReconByKey.get(`${item.sku}:${item.warehouseId}`) || null;
      return ACTIVE_WAREHOUSE_ID_LIST.map((id) => latestReconByKey.get(`${item.sku}:${id}`)).find(Boolean) || null;
    };
    const reconciliations = items.map(reconciliationForItem).filter(Boolean);
    const dataAsOf = maxDate([
      ...allMatchingRows.map((row) => row.lastUpdated),
      ...reconciliationRows.map((row) => row.checkedAt),
    ]);
    const meta = freshnessMeta({
      source: SOURCE.WAREHOUSE,
      dataAsOf,
      connectionReady: warehouseConfigured,
      hasData: total > 0,
      failedAt: latestWarehouseLog?.status === 'FAILED' ? latestWarehouseLog.timestamp : null,
      freshnessMinutes: 45,
    });

    return {
      items: pagedItems.map((item) => ({ ...item, reconciliation: reconciliationForItem(item) })),
      totals: {
        skus: total,
        totalPhysicalUnits,
        totalAvailableUnits,
        totalValuation,
        discrepanciesCount: reconciliations.filter((row) => row.status !== 'MATCHED').length,
      },
      counts: {
        all: countRows.length,
        priority: countByType('priority'),
        research: countByType('research'),
        general: countByType('general'),
      },
      filters: {
        warehouses: enrichedWarehouses,
        teams: teamsList,
        activeType: type,
        activeWarehouseId: warehouseId,
        activeTeamId: teamId,
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
      }))
      .sort((left, right) => (left.priority === 'HIGH' ? -1 : 1) - (right.priority === 'HIGH' ? -1 : 1) || left.title.localeCompare(right.title));
    const allRecommendations = [
      ...this.buildProductRecommendations(catalog.products),
      ...this.buildAdsRecommendations(ads.topCampaigns),
      ...warehouseRecommendations,
    ];
    return {
      recommendations: allRecommendations.slice(0, 100),
      recommendationTotal: allRecommendations.length,
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
