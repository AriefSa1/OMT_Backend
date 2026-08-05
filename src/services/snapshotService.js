const prisma = require('../utils/prisma');
const { queryRaw } = require('../utils/sqlHelper');
const { sortTasksByPriority } = require('../utils/taskOrdering');
const {
  ACTIVE_WAREHOUSES,
  ACTIVE_WAREHOUSE_ID_LIST,
  isActiveWarehouseId,
} = require('../constants/warehouseConstants');
const { isGiftItem } = require('../constants/catalogConstants');

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

/**
 * Raw queries bypass Prisma's type mapping, so a SQLite DateTime column arrives as the
 * stored epoch-milliseconds integer (a BigInt), not a Date. Typed queries on the same
 * column return a Date, so anything read raw has to be converted back or the two paths
 * disagree about what a timestamp is.
 */
function rawDate(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(typeof value === 'bigint' ? Number(value) : value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
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

  async getCatalogSnapshot({ page = 1, limit = 24, search = '', category = '', sort = 'updatedAt', direction = 'desc' } = {}) {
    const { session, latestShopeeLog } = await this.getContext();
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 24));
    const storeWhere = session?.storeId ? { storeId: session.storeId } : {};
    const searchTerm = String(search || '').trim();
    const selectedCategory = String(category || '').trim();
    const where = {
      ...storeWhere,
      ...(searchTerm ? {
        OR: [
          { name: { contains: searchTerm } },
          { sku: { contains: searchTerm } },
          { shopeeItemId: { contains: searchTerm } },
        ],
      } : {}),
      ...(selectedCategory ? { category: selectedCategory } : {}),
    };
    const allowedSort = new Set(['updatedAt', 'name', 'price', 'stock', 'salesCount', 'views']);
    const orderBy = { [allowedSort.has(sort) ? sort : 'updatedAt']: direction === 'asc' ? 'asc' : 'desc' };
    const [total, products, categoryRows] = await Promise.all([
      prisma.shopeeProduct.count({ where }),
      prisma.shopeeProduct.findMany({ where, orderBy, skip: (safePage - 1) * safeLimit, take: safeLimit }),
      prisma.shopeeProduct.findMany({
        where: storeWhere,
        select: { category: true },
        distinct: ['category'],
        orderBy: { category: 'asc' },
      }),
    ]);
    const productIds = products.map((product) => product.shopeeItemId);
    const metrics = productIds.length
      ? await prisma.productMetricSnapshot.findMany({
        where: {
          ...(session?.storeId ? { storeId: session.storeId } : {}),
          shopeeItemId: { in: productIds },
        },
        orderBy: { dataAsOf: 'desc' },
      })
      : [];
    const latestMetrics = new Map(getLatestBy(metrics, 'shopeeItemId').map((metric) => [metric.shopeeItemId, metric]));

    // Varian hanya untuk produk di halaman ini, bukan seluruh katalog. Diurutkan menurun
    // agar varian terlaris berada di depan tanpa pengurutan ulang di sisi klien.
    const variationRows = productIds.length
      ? await prisma.shopeeListingVariation.findMany({
        where: { shopeeItemId: { in: productIds } },
        orderBy: [{ soldCount: 'desc' }, { name: 'asc' }],
      })
      : [];
    const variationsByItem = new Map();
    for (const row of variationRows) {
      const list = variationsByItem.get(row.shopeeItemId) || [];
      list.push(row);
      variationsByItem.set(row.shopeeItemId, list);
    }

    const dataAsOf = maxDate([metrics[0]?.dataAsOf, session?.lastSyncedAt]);
    const meta = freshnessMeta({
      source: SOURCE.SHOPEE,
      dataAsOf,
      connectionReady: Boolean(session),
      hasData: categoryRows.length > 0,
      failedAt: latestShopeeLog?.status === 'FAILED' ? latestShopeeLog.timestamp : null,
      freshnessMinutes: 45,
    });

    return {
      products: products.map((product) => {
        const rawVariations = variationsByItem.get(product.shopeeItemId) || [];
        const soldTotal = rawVariations.reduce((sum, row) => sum + number(row.soldCount), 0);
        // Peringkat dan pangsa dihitung di sini juga, bukan hanya di getProductSnapshot,
        // supaya daftar varian di katalog dan di halaman detail menampilkan angka yang sama.
        const variations = rawVariations.map((row, index) => ({
          ...row,
          rank: index + 1,
          soldShare: soldTotal > 0 ? (number(row.soldCount) / soldTotal) * 100 : null,
        }));
        return {
          ...product,
          metric: latestMetrics.get(product.shopeeItemId) || null,
          variations,
          variationSummary: {
            count: variations.length,
            // Total penjualan per varian tidak harus sama dengan salesCount produk:
            // salesCount adalah angka kumulatif toko dari Seller Center, sedangkan ini
            // penjumlahan per varian pada snapshot yang sama. Keduanya dilaporkan
            // apa adanya, tidak ada yang disesuaikan agar cocok.
            soldTotal,
            stockTotal: variations.reduce((sum, row) => sum + number(row.stock), 0),
            bestSeller: variations.length && number(variations[0].soldCount) > 0
              ? { name: variations[0].name, soldCount: number(variations[0].soldCount), stock: number(variations[0].stock) }
              : null,
            // Penjualan per varian belum tentu terisi: Shopee mengirim 0 untuk varian yang
            // memang belum pernah terjual, dan panel harus membedakannya dari "belum diukur".
            hasSoldData: soldTotal > 0,
          },
          economics: {
            unitCost: product.unitCost,
            unitAdCost: product.unitAdCost,
            shippingCost: product.shippingCost,
            platformFeePercent: product.platformFeePercent,
          },
        };
      }),
      filters: {
        categories: categoryRows.map((row) => row.category).filter(Boolean),
        activeCategory: selectedCategory,
      },
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
    const product = await prisma.shopeeProduct.findUnique({ where: { shopeeItemId: String(itemId) } });
    if (!product) return null;
    const [metrics, session, warehouseRows, variations] = await Promise.all([
      prisma.productMetricSnapshot.findMany({
        where: { shopeeItemId: String(itemId) },
        orderBy: { date: 'desc' },
        take: 30,
      }),
      prisma.storeSession.findUnique({ where: { storeId: product.storeId } }),
      product.sku
        ? prisma.warehouseItem.findMany({
          where: { sku: product.sku, warehouseId: { in: ACTIVE_WAREHOUSE_ID_LIST } },
          select: { availableStock: true },
        })
        : Promise.resolve([]),
      prisma.shopeeListingVariation.findMany({
        where: { shopeeItemId: String(itemId) },
        orderBy: [{ soldCount: 'desc' }, { name: 'asc' }],
      }),
    ]);
    const latestMetric = metrics[0] || null;
    const meta = freshnessMeta({
      source: SOURCE.SHOPEE,
      dataAsOf: maxDate([session?.lastSyncedAt, latestMetric?.dataAsOf]),
      hasData: true,
      connectionReady: true,
      freshnessMinutes: 45,
    });
    // Margin needs ALL four cost inputs. The previous condition only returned null when
    // every one was missing, so filling in a single field silently treated the other
    // three as zero and reported a margin far higher than reality.
    const economicsInputs = [product.unitCost, product.unitAdCost, product.shippingCost, product.platformFeePercent];
    const economicsComplete = economicsInputs.every((value) => value !== null && value !== undefined);

    const unitCost = number(product.unitCost);
    const unitAdCost = number(product.unitAdCost);
    const shippingCost = number(product.shippingCost);
    const feeAmount = number(product.price) * (number(product.platformFeePercent) / 100);
    const estimatedMargin = economicsComplete
      ? number(product.price) - unitCost - unitAdCost - shippingCost - feeAmount
      : null;
    // Peringkat varian menurut penjualan, plus pangsa tiap varian terhadap total varian.
    // Pangsa memakai penyebut penjumlahan varian (bukan salesCount produk) karena hanya
    // itu yang benar-benar sebanding — keduanya berasal dari hitungan yang berbeda.
    const variationSoldTotal = variations.reduce((sum, row) => sum + number(row.soldCount), 0);
    const rankedVariations = variations.map((row, index) => ({
      ...row,
      rank: index + 1,
      soldShare: variationSoldTotal > 0 ? (number(row.soldCount) / variationSoldTotal) * 100 : null,
    }));

    return {
      product: {
        ...product,
        metric: latestMetric,
        metricHistory: metrics,
        variations: rankedVariations,
        variationSummary: {
          count: rankedVariations.length,
          soldTotal: variationSoldTotal,
          stockTotal: rankedVariations.reduce((sum, row) => sum + number(row.stock), 0),
          hasSoldData: variationSoldTotal > 0,
          bestSeller: variationSoldTotal > 0 ? rankedVariations[0] : null,
          // Varian tanpa penjualan sama sekali: kandidat untuk dihentikan atau diperbaiki,
          // tapi hanya bermakna kalau varian lain memang ada penjualannya.
          zeroSellerCount: variationSoldTotal > 0
            ? rankedVariations.filter((row) => number(row.soldCount) === 0).length
            : null,
          message: rankedVariations.length
            ? (variationSoldTotal > 0 ? null : 'Seller Center belum mencatat penjualan per varian untuk produk ini.')
            : 'Produk ini tidak memiliki varian pada snapshot katalog.',
        },
        economics: {
          unitCost: product.unitCost,
          unitAdCost: product.unitAdCost,
          shippingCost: product.shippingCost,
          platformFeePercent: product.platformFeePercent,
          estimatedMargin,
          estimatedMarginPercent: estimatedMargin === null || !number(product.price) ? null : (estimatedMargin / number(product.price)) * 100,
        },
      },
      warehouseStock: warehouseRows.length
        ? warehouseRows.reduce((sum, row) => sum + number(row.availableStock), 0)
        : null,
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
        // Dibutuhkan dashboard untuk kartu impresi/klik dan pembandingnya terhadap kemarin.
        impressions: number(row.impressions),
        clicks: number(row.clicks),
        dataAsOf: row.dataAsOf,
      })),
      meta,
    };
  }

  async getWarehouseSnapshot({ page = 1, limit = 24, search = '', type = 'all', warehouseId = 'all', teamId = 'all', sort = 'lastUpdated', sortBy = '', direction = 'desc', includeReconciliationList = false } = {}) {
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

    // Grouping, sorting and paging all happen in SQL. Loading the table into memory
    // first cost ~4.7s and 23.7MB per request against 26k rows, to return 24 of them.
    const filters = [];
    const filterParams = [];
    const specificWarehouse = warehouseId && warehouseId !== 'all';

    if (specificWarehouse) {
      filters.push('"warehouseId" = ?');
      filterParams.push(isActiveWarehouseId(warehouseId) ? Number(warehouseId) : -1);
    } else {
      filters.push(`"warehouseId" IN (${ACTIVE_WAREHOUSE_ID_LIST.map(() => '?').join(', ')})`);
      filterParams.push(...ACTIVE_WAREHOUSE_ID_LIST);
    }
    if (search) {
      filters.push('("name" LIKE ? OR "sku" LIKE ? OR "refId" LIKE ?)');
      const pattern = `%${search}%`;
      filterParams.push(pattern, pattern, pattern);
    }
    if (teamId && teamId !== 'all') {
      filters.push('"teamId" = ?');
      filterParams.push(Number(teamId));
    }

    // The type filter narrows the visible list but deliberately not the counts, which
    // the tab bar uses to show how many rows each type would yield.
    const typeFilter = type && type !== 'all' ? ' AND "productType" = ?' : '';
    const typeParams = type && type !== 'all' ? [String(type).toLowerCase()] : [];
    const baseWhere = `WHERE ${filters.join(' AND ')}`;
    const viewWhere = `${baseWhere}${typeFilter}`;
    const viewParams = [...filterParams, ...typeParams];

    const STOCK_VALUE_SQL = 'SUM(COALESCE("priceMin", 0) * "totalStock")';
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
    const ascending = sortDirection === 'asc';    // Whitelisted, so the sort key can be interpolated into SQL.
    const sortExpressions = {
      lastUpdated: 'MAX("lastUpdated")',
      name: 'LOWER(MIN("name"))',
      availableStock: 'SUM("availableStock")',
      totalStock: 'SUM("totalStock")',
      priceMin: 'MIN("priceMin")',
      stockValue: STOCK_VALUE_SQL,
      teamName: 'LOWER(MIN("teamName"))',
      warehouseName: 'LOWER(MIN("warehouseName"))',
    };
    const orderExpression = sortExpressions[sortField] || sortExpressions.lastUpdated;
    const orderDirection = ascending ? 'ASC' : 'DESC';

    // One row per SKU. Grouping by SKU is also correct for a single-warehouse view,
    // since (sku, warehouseId) is unique - so the same statement serves both.
    const pageRows = await queryRaw(
      prisma,
      `SELECT "sku",
              MIN("id") AS "repId",
              SUM("totalStock") AS "totalStock",
              SUM("availableStock") AS "availableStock",
              SUM("reservedStock") AS "reservedStock",
              ${STOCK_VALUE_SQL} AS "stockValue",
              COUNT(*) AS "warehouseCount",
              MAX("lastUpdated") AS "lastUpdated"
       FROM "WarehouseItem"
       ${viewWhere}
       GROUP BY "sku"
       ORDER BY ${orderExpression} ${orderDirection}, "sku" ASC
       LIMIT ? OFFSET ?`,
      ...viewParams,
      safeLimit,
      (safePage - 1) * safeLimit
    );

    // Only the page is materialised - at most `safeLimit` rows.
    const representatives = await prisma.warehouseItem.findMany({
      where: { id: { in: pageRows.map((row) => row.repId) } },
    });
    const representativeById = new Map(representatives.map((row) => [row.id, row]));

    const pagedItems = pageRows.map((row) => {
      const base = representativeById.get(row.repId) || {};
      const shared = {
        ...base,
        availableStock: number(row.availableStock),
        reservedStock: number(row.reservedStock),
        totalStock: number(row.totalStock),
        stockValue: number(row.stockValue),
        lastUpdated: rawDate(row.lastUpdated),
      };
      if (specificWarehouse) {
        return {
          ...shared,
          warehouseId: Number(base.warehouseId),
          warehouseName: ACTIVE_WAREHOUSES.find((warehouse) => warehouse.id === Number(base.warehouseId))?.name || base.warehouseName,
        };
      }
      return {
        ...shared,
        warehouseId: null,
        warehouseName: 'Multi-gudang',
        warehouseLocation: null,
        location: 'Multi-gudang',
        warehouseCount: number(row.warehouseCount),
      };
    });

    const [[viewTotals], typeCountRows, warehouseCountRows, teamCountRows] = await Promise.all([
      queryRaw(
        prisma,
        `SELECT COUNT(*) AS "skus",
                COALESCE(SUM("totalStock"), 0) AS "totalPhysicalUnits",
                COALESCE(SUM("availableStock"), 0) AS "totalAvailableUnits",
                COALESCE(SUM("stockValue"), 0) AS "totalValuation",
                MAX("lastUpdated") AS "lastUpdated"
         FROM (SELECT "sku",
                      SUM("totalStock") AS "totalStock",
                      SUM("availableStock") AS "availableStock",
                      ${STOCK_VALUE_SQL} AS "stockValue",
                      MAX("lastUpdated") AS "lastUpdated"
               FROM "WarehouseItem" ${viewWhere} GROUP BY "sku") AS "sub"`,
        ...viewParams
      ),
      queryRaw(
        prisma,
        `SELECT "productType", COUNT(DISTINCT "sku") AS "count"
         FROM "WarehouseItem" ${baseWhere} GROUP BY "productType"`,
        ...filterParams
      ),
      queryRaw(
        prisma,
        `SELECT "warehouseId", COUNT(DISTINCT "sku") AS "count"
         FROM "WarehouseItem" ${baseWhere} GROUP BY "warehouseId"`,
        ...filterParams
      ),
      queryRaw(
        prisma,
        `SELECT "teamId", MIN("teamName") AS "teamName", MIN("teamCode") AS "teamCode",
                COUNT(DISTINCT "sku") AS "count"
         FROM "WarehouseItem" ${baseWhere} AND "teamId" IS NOT NULL GROUP BY "teamId"`,
        ...filterParams
      ),
    ]);

    const total = number(viewTotals?.skus);
    const totalPhysicalUnits = number(viewTotals?.totalPhysicalUnits);
    const totalAvailableUnits = number(viewTotals?.totalAvailableUnits);
    const totalValuation = number(viewTotals?.totalValuation);

    const typeCounts = new Map(typeCountRows.map((row) => [row.productType, number(row.count)]));
    const countByType = (productType) => typeCounts.get(productType) || 0;
    const countsAll = typeCountRows.reduce((sum, row) => sum + number(row.count), 0);

    const warehouseCounts = new Map(warehouseCountRows.map((row) => [Number(row.warehouseId), number(row.count)]));
    const enrichedWarehouses = ACTIVE_WAREHOUSES.map((warehouse) => ({
      id: warehouse.id,
      name: warehouse.name,
      count: warehouseCounts.get(warehouse.id) || 0,
    }));

    const teamsList = teamCountRows
      .map((row) => ({
        id: row.teamId,
        name: row.teamName || `Team ${row.teamId}`,
        code: row.teamCode,
        count: number(row.count),
      }))
      .sort((a, b) => Number(a.id) - Number(b.id));

    // Latest reconciliation per (sku, warehouse), restricted to the SKUs on this page.
    const activeWarehousePlaceholders = ACTIVE_WAREHOUSE_ID_LIST.map(() => '?').join(', ');
    const latestReconciliationSql = (skuFilter) => `
      SELECT sr.*
      FROM "StockReconciliation" sr
      INNER JOIN (
        SELECT "sku", "warehouseId", MAX("checkedAt") AS "latestCheckedAt"
        FROM "StockReconciliation"
        WHERE "warehouseId" IN (${activeWarehousePlaceholders})
        GROUP BY "sku", "warehouseId"
      ) latest
        ON latest."sku" = sr."sku"
        AND latest."warehouseId" = sr."warehouseId"
        AND latest."latestCheckedAt" = sr."checkedAt"
      WHERE sr."warehouseId" IN (${activeWarehousePlaceholders})${skuFilter}
      ORDER BY sr."checkedAt" DESC
    `;

    const pageSkus = pagedItems.map((item) => item.sku);
    const pageReconciliationRows = pageSkus.length
      ? await queryRaw(
        prisma,
        latestReconciliationSql(` AND sr."sku" IN (${pageSkus.map(() => '?').join(', ')})`),
        ...ACTIVE_WAREHOUSE_ID_LIST,
        ...ACTIVE_WAREHOUSE_ID_LIST,
        ...pageSkus
      )
      : [];

    const latestReconByKey = new Map();
    for (const row of pageReconciliationRows) {
      const key = `${row.sku}:${row.warehouseId || 'none'}`;
      if (!latestReconByKey.has(key)) latestReconByKey.set(key, row);
    }
    const reconciliationForItem = (item) => {
      if (item.warehouseId) return latestReconByKey.get(`${item.sku}:${item.warehouseId}`) || null;
      return ACTIVE_WAREHOUSE_ID_LIST.map((id) => latestReconByKey.get(`${item.sku}:${id}`)).find(Boolean) || null;
    };

    const warehousePrecedenceSql = `CASE sr."warehouseId" ${ACTIVE_WAREHOUSE_ID_LIST
      .map((id, index) => `WHEN ${Number(id)} THEN ${index}`)
      .join(' ')} ELSE ${ACTIVE_WAREHOUSE_ID_LIST.length} END`;

    const reconciliations = includeReconciliationList === true
      ? await queryRaw(
        prisma,
        `SELECT sr."sku", MIN(sr."status") AS "status", MAX(sr."checkedAt") AS "checkedAt",
                MIN(${warehousePrecedenceSql}) AS "warehousePrecedence"
         FROM (${latestReconciliationSql('')}) sr
         INNER JOIN (SELECT DISTINCT "sku" FROM "WarehouseItem" ${viewWhere}) item
           ON item."sku" = sr."sku"
         GROUP BY sr."sku"`,
        ...ACTIVE_WAREHOUSE_ID_LIST,
        ...ACTIVE_WAREHOUSE_ID_LIST,
        ...viewParams
      )
      : [];

    const [[skuOverlap]] = await Promise.all([
      queryRaw(
        prisma,
        `SELECT (SELECT COUNT(DISTINCT "sku") FROM "WarehouseItem") AS "warehouseSkuCount",
                (SELECT COUNT(*) FROM (SELECT DISTINCT "sku" FROM "WarehouseItem") AS w
                  WHERE w."sku" IN (SELECT "sku" FROM "ShopeeProduct")) AS "mappedSkuCount"`
      ),
    ]);
    const mappedSkuCount = number(skuOverlap?.mappedSkuCount);
    const reconciliationTrust = {
      reliable: mappedSkuCount > 0,
      mappedSkuCount,
      warehouseSkuCount: number(skuOverlap?.warehouseSkuCount),
      message: mappedSkuCount > 0
        ? null
        : 'Tidak ada SKU gudang yang cocok dengan katalog Shopee, sehingga selisih stok belum dapat dihitung. Pemetaan SKU diperlukan.',
    };

    const [[reconciliationStats]] = await Promise.all([
      queryRaw(
        prisma,
        `SELECT COUNT(*) AS "auditedCount",
                SUM(CASE WHEN "status" <> 'MATCHED' THEN 1 ELSE 0 END) AS "discrepanciesCount",
                MAX("checkedAt") AS "latestCheckedAt"
         FROM (
           SELECT sr."sku", MIN(sr."status") AS "status", MAX(sr."checkedAt") AS "checkedAt",
                  MIN(${warehousePrecedenceSql}) AS "warehousePrecedence"
           FROM (${latestReconciliationSql('')}) sr
           INNER JOIN (SELECT DISTINCT "sku" FROM "WarehouseItem" ${viewWhere}) item
             ON item."sku" = sr."sku"
           GROUP BY sr."sku"
         ) AS "sub"`,
        ...ACTIVE_WAREHOUSE_ID_LIST,
        ...ACTIVE_WAREHOUSE_ID_LIST,
        ...viewParams
      ),
    ]);

    const dataAsOf = maxDate([rawDate(viewTotals?.lastUpdated), rawDate(reconciliationStats?.latestCheckedAt)]);
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
        // null, not 0, when the figure cannot be trusted — 0 would read as "no problems".
        discrepanciesCount: reconciliationTrust.reliable
          ? number(reconciliationStats?.discrepanciesCount)
          : null,
      },
      reconciliationTrust,
      counts: {
        all: countsAll,
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
        orderBy: { updatedAt: 'desc' },
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
      tasks: sortTasksByPriority(tasks),
      sources: { catalog: catalog.meta, ads: ads.meta, warehouse: warehouse.meta },
      // Without this, an empty warehouse recommendation list is indistinguishable from
      // "every SKU matched" — and reconciliation is currently not computable at all.
      reconciliationTrust: warehouse.reconciliationTrust,
    };
  }

  async getDashboardOverview() {
    const shopeeService = require('./shopeeService');
    const syncService = require('./syncService');
    const session = await shopeeService.getActiveSession();

    if (session?.isActive && session?.storeId) {
      try {
        await Promise.allSettled([
          shopeeService.fetchShopeeAdsMetrics({ period: 'real_time' }).then((liveAds) => {
            if (liveAds?.success) syncService.persistAdsSnapshot(liveAds).catch(() => {});
          }),
          shopeeService.fetchOrderSummaryRealtime().then(async (realtimeOrders) => {
            if (realtimeOrders?.row) {
              await shopeeService.persistOrderSummaryHistory(session.storeId, [realtimeOrders.row]);
            }
          }),
        ]);
      } catch (err) {
        console.warn('[snapshotService] Live overview background fetch error:', err.message);
      }
    }

    const [context, catalog, ads, warehouse, orders] = await Promise.all([
      this.getContext(),
      this.getCatalogSnapshot({ page: 1, limit: 8, sort: 'salesCount' }),
      this.getAdsSnapshot(),
      this.getWarehouseSnapshot({ page: 1, limit: 8 }),
      prisma.shopeeOrderSummary.findMany({
        where: session?.storeId ? { storeId: session.storeId } : {},
        orderBy: { date: 'desc' },
        take: 30,
      }),
    ]);
    const latestOrder = orders[0] || null;
    // Computed before salesTrend, which reverses `orders` in place.
    const cancellationRows = orders.filter((row) => row.cancelledOrders !== null && row.cancelledOrders !== undefined);
    const sumField = (rows, field) => rows.reduce((total, row) => total + number(row[field]), 0);
    const orderQuality = {
      days: cancellationRows.length,
      from: cancellationRows.length ? cancellationRows[cancellationRows.length - 1].date : null,
      to: cancellationRows.length ? cancellationRows[0].date : null,
      // Absolute figures only. Shopee does not publish the denominator behind its
      // cancellation rate, so no rate is derived here.
      cancelledOrders: cancellationRows.length ? sumField(cancellationRows, 'cancelledOrders') : null,
      cancelledSales: cancellationRows.length ? sumField(cancellationRows, 'cancelledSales') : null,
      returnRefundOrders: cancellationRows.length ? sumField(cancellationRows, 'returnRefundOrders') : null,
      returnRefundSales: cancellationRows.length ? sumField(cancellationRows, 'returnRefundSales') : null,
      // Asal angka, supaya pembaca tidak perlu menebak apa yang sedang dihitung.
      provenance: {
        source: 'Shopee Seller Center — Data Center',
        endpoint: '/api/mydata/dashboard/order-performance/',
        orderType: 'confirmed',
        cancelled: 'Pesanan yang dibatalkan (oleh pembeli, penjual, atau sistem Shopee) beserta nilainya, dihitung Shopee per hari.',
        returnRefund: 'Pesanan yang dikembalikan atau dana dikembalikan (return/refund) beserta nilainya, dihitung Shopee per hari.',
      },
      message: cancellationRows.length
        ? null
        : 'Data pembatalan dan retur belum tersimpan. Jalankan Sync untuk mengambilnya dari Seller Center.',
    };
    // Pembanding hari-ke-hari untuk kartu statistik harian.
    //
    // `orders` masih terurut menurun (terbaru dulu) pada titik ini; `ads.history` sudah
    // menaik (terlama dulu). Baris "kemarin" diambil sebagai baris kedua dari masing-masing,
    // bukan dengan mengurangi tanggal — kalau satu hari tidak tersimpan, pembandingnya
    // adalah hari tersimpan sebelumnya, dan tanggalnya ikut dilaporkan supaya jelas.
    const previousOrder = orders[1] || null;
    const adsToday = ads.history[ads.history.length - 1] || null;
    const adsYesterday = ads.history[ads.history.length - 2] || null;
    const compare = (current, previous) => {
      if (current === null || current === undefined || previous === null || previous === undefined) {
        return { current: current ?? null, previous: previous ?? null, direction: null, changePercent: null };
      }
      const delta = number(current) - number(previous);
      return {
        current: number(current),
        previous: number(previous),
        direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
        changePercent: number(previous) === 0 ? null : (delta / Math.abs(number(previous))) * 100,
      };
    };
    // Hari berjalan belum selesai. Membandingkannya dengan kemarin yang penuh akan
    // SELALU terlihat turun — itu artefak jam, bukan penurunan performa. Ditandai supaya
    // UI dapat mengatakannya, bukan menampilkan panah merah tanpa konteks.
    const currentDate = latestOrder?.date || adsToday?.date || null;
    const kpiTrend = {
      currentDate,
      currentIsPartial: currentDate === dateKey(),
      previousDate: previousOrder?.date || adsYesterday?.date || null,
      gmv: compare(latestOrder ? number(latestOrder.gmv) : null, previousOrder ? number(previousOrder.gmv) : null),
      orders: compare(latestOrder ? number(latestOrder.orderCount) : null, previousOrder ? number(previousOrder.orderCount) : null),
      roas: compare(adsToday ? number(adsToday.roas) : null, adsYesterday ? number(adsYesterday.roas) : null),
      adSpend: compare(adsToday ? number(adsToday.spend) : null, adsYesterday ? number(adsYesterday.spend) : null),
      impressions: compare(adsToday ? number(adsToday.impressions) : null, adsYesterday ? number(adsYesterday.impressions) : null),
      clicks: compare(adsToday ? number(adsToday.clicks) : null, adsYesterday ? number(adsYesterday.clicks) : null),
    };

    const adByDate = new Map(ads.history.map((row) => [row.date, row]));
    const salesTrend = orders.reverse().map((row) => {
      const adRow = adByDate.get(row.date);
      return {
        day: row.date,
        gmv: number(row.gmv),
        orders: number(row.orderCount),
        // null leaves a gap in the chart. number(undefined) returned 0, which drew a day
        // with no ads snapshot as a day of zero ad spend.
        adSpend: adRow ? number(adRow.spend) : null,
      };
    });
    // Item hadiah gratis bukan produk jualan: satu di antaranya mencatat ~6.954 "penjualan"
    // dan mendominasi daftar terlaris maupun pangsa kategori. Dikecualikan dari keduanya,
    // tapi tidak dihapus dari katalog itu sendiri (/shopee tetap menampilkannya).
    const sellableProducts = catalog.products.filter((product) => !isGiftItem(product));
    const excludedGiftCount = catalog.products.length - sellableProducts.length;

    const categoryTotals = sellableProducts.reduce((acc, product) => {
      const category = product.category || 'Tanpa kategori';
      acc[category] = (acc[category] || 0) + number(product.salesCount);
      return acc;
    }, {});
    // Only STATUS.FRESH and STATUS.PENDING mean the snapshot actually holds measurements.
    const warehouseMeasured = warehouse.meta.status === STATUS.FRESH || warehouse.meta.status === STATUS.PENDING;
    const categoryDenominator = Object.values(categoryTotals).reduce((sum, value) => sum + number(value), 0);
    const categorySales = categoryDenominator ? Object.entries(categoryTotals).map(([name, value]) => ({ name, value: Math.round((number(value) / categoryDenominator) * 100) })) : [];
    // The share is computed over the top-selling page of the catalog, not the whole
    // catalog. The UI has to say so, so the coverage travels with the numbers.
    const uncategorisedShare = categorySales.find((row) => row.name === 'Uncategorized')?.value ?? 0;
    const categorySalesMeta = {
      basis: 'TOP_PRODUCTS_BY_SALES',
      productCount: sellableProducts.length,
      categoryCount: categorySales.length,
      excludedGiftCount,
      // Asal angka, sesuai keluhan bahwa panel ini tidak jelas sumbernya.
      provenance: {
        source: 'Snapshot katalog Shopee (tabel ShopeeProduct)',
        metric: 'salesCount — total penjualan kumulatif per produk menurut Seller Center',
        scope: `${sellableProducts.length} produk dengan penjualan tertinggi${excludedGiftCount ? `, setelah mengecualikan ${excludedGiftCount} item hadiah gratis` : ''}`,
        categoryField: 'Kategori diambil dari Seller Center (category_path_name_list) saat Sync katalog',
      },
      // Kategori produk hanya terisi setelah Sync menjalankan pelengkapan kategori. Selama
      // masih "Uncategorized", panel ini benar tapi belum informatif — katakan apa adanya.
      needsCategorySync: uncategorisedShare >= 50,
      message: categoryDenominator
        ? `Pangsa dihitung dari ${sellableProducts.length} produk dengan penjualan tertinggi pada snapshot katalog${excludedGiftCount ? ` (${excludedGiftCount} item hadiah gratis dikecualikan)` : ''}.`
        : 'Belum ada penjualan tercatat pada snapshot katalog, sehingga pangsa kategori tidak dapat dihitung.',
    };
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
        impressions: ads.impressions,
        clicks: ads.clicks,
        // A disconnected or never-synced warehouse has no measurement, so these are
        // null rather than 0 — matching how the order KPIs above already behave.
        warehouseUnits: warehouseMeasured ? warehouse.totals.totalAvailableUnits : null,
        discrepanciesAlerts: warehouseMeasured ? warehouse.totals.discrepanciesCount : null,
      },
      kpiTrend,
      reconciliationTrust: warehouse.reconciliationTrust,
      history: {
        orderAvailable: Boolean(latestOrder),
        message: latestOrder ? null : 'Belum ada ringkasan pesanan harian tersimpan. Jalankan Sync untuk mengambil ringkasan dari Seller Center.',
      },
      salesTrend,
      orderQuality,
      categorySales,
      categorySalesMeta,
      adsMetrics: ads,
      topProducts: sellableProducts,
      topProductsMeta: {
        excludedGiftCount,
        message: excludedGiftCount
          ? `${excludedGiftCount} item hadiah gratis dikecualikan dari daftar ini karena bukan produk jualan.`
          : null,
      },
      reconciliationSummary: warehouse.totals,
    };
  }
}

module.exports = new SnapshotService();
module.exports.STATUS = STATUS;
module.exports.dateKey = dateKey;
module.exports.normalizeRate = normalizeRate;
