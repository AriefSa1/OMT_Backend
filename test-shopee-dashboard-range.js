/**
 * Live, read-only comparison report for the same date ranges a user selects in Shopee
 * Seller Center. It calls Seller Center dashboard endpoints directly and compares their
 * result with the persisted application snapshot used by Hermes validation.
 *
 * This script does not run Sync, does not persist rows, and does not call Hermes.
 */
require('dotenv').config();

const prisma = require('./src/utils/prisma');
const shopeeService = require('./src/services/shopeeService');
const hermesAnalysisService = require('./src/services/hermesAnalysisService');

const RANGES = [
  { label: '30_HARI', days: 30 },
  { label: '7_HARI', days: 7 },
];

function jakartaDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDateKey(value, days) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function toUnixStart(dateKey) {
  return Math.floor(Date.parse(`${dateKey}T00:00:00+07:00`) / 1000);
}

function toUnixEnd(dateKey) {
  return Math.floor(Date.parse(`${dateKey}T23:59:59+07:00`) / 1000);
}

function metricValues(metrics, fields) {
  if (!metrics) return null;
  return Object.fromEntries(fields.map((field) => [field, metrics[field] ?? null]));
}

function sourceStatus(result) {
  return {
    source: result?.source || result?.dataSource || (result?.success ? 'SHOPEE_API' : 'EMPTY'),
    message: result?.message || null,
  };
}

async function fetchLiveRange(range, storeId) {
  const endDate = jakartaDateKey();
  const startDate = shiftDateKey(endDate, -(range.days - 1));
  const startTime = toUnixStart(startDate);
  const endTime = toUnixEnd(endDate);

  const [ads, orderSummary, orderPerformance, products] = await Promise.all([
    shopeeService.fetchShopeeAdsMetrics({ period: range.days <= 7 ? 'past7days' : 'past30days', storeId }),
    shopeeService.fetchOrderSummaryHistory({ startTime, endTime, includeToday: true, storeId }),
    shopeeService.fetchOrderPerformanceHistory({ startTime, endTime, storeId }),
    // Product Performance follows Seller Center's native period semantics. Its endpoint
    // accepts past7days/past30days and excludes the running day; custom is rejected or
    // ignored by Seller Center even when start/end timestamps are supplied.
    shopeeService.fetchProductPerformance({
      period: range.days <= 7 ? 'past7days' : 'past30days',
      pageSize: 50, pageNum: 1, orderBy: 'confirmed_sales.desc', storeId,
    }),
  ]);

  const inPeriod = (row) => row?.date >= startDate && row?.date <= endDate;
  const summaryRows = (orderSummary.rows || []).filter(inPeriod);
  const performanceRows = (orderPerformance.rows || []).filter(inPeriod);
  const performanceByDate = new Map(performanceRows.map((row) => [row.date, row]));
  const mergedOrders = summaryRows.map((row) => ({ ...row, ...(performanceByDate.get(row.date) || {}) }));
  const orderMetrics = hermesAnalysisService.aggregateOrders(mergedOrders);
  const overview = await shopeeService.fetchProductOverview({
    period: range.days <= 7 ? 'past7days' : 'past30days',
    storeId,
  });
  const keyMetricValues = metricValues(orderMetrics, ['gmv', 'orders', 'averageOrderValue', 'conversionRate', 'cancelledOrders', 'returnRefundOrders']);
  const overviewValues = {
    placedGmv: overview.metrics?.placed_gmv?.value ?? null,
    placedBuyers: overview.metrics?.placed_buyers?.value ?? null,
    confirmedGmv: overview.metrics?.confirmed_gmv?.value ?? null,
    confirmedBuyers: overview.metrics?.confirmed_buyers?.value ?? null,
    confirmedUnits: overview.metrics?.confirmed_unit_num?.value ?? null,
    visitors: overview.metrics?.uv?.value ?? null,
  };
  const productMetricValues = metricValues(products?.summary, ['totalSales', 'totalOrders', 'totalUnits', 'totalViews', 'totalVisitors', 'totalBuyers', 'averageConversionRate']);
  const productOverviewAgreement = {
    confirmedSales: productMetricValues.totalSales !== null && productMetricValues.totalSales === overviewValues.confirmedGmv,
    confirmedUnits: productMetricValues.totalUnits !== null && productMetricValues.totalUnits === overviewValues.confirmedUnits,
  };
  const endpointsAgree = keyMetricValues.gmv === overviewValues.confirmedGmv
    && keyMetricValues.orders === overviewValues.confirmedBuyers;

  return {
    label: range.label,
    period: { startDate, endDate, days: range.days, startTime, endTime },
    ads: {
      ...sourceStatus(ads),
      period: ads?.period || null,
      metrics: metricValues(ads, ['totalSpend', 'totalSalesGenerated', 'roas', 'impressions', 'clicks', 'ctr', 'orders', 'itemSold']),
      campaignCount: Array.isArray(ads?.topCampaigns) ? ads.topCampaigns.length : null,
    },
    store: {
      summary: sourceStatus(orderSummary),
      cancellation: sourceStatus(orderPerformance),
      measuredDates: [...new Set(mergedOrders.map((row) => row.date).filter(Boolean))].sort(),
      keyMetrics: keyMetricValues,
      productOverview: {
        ...sourceStatus(overview),
        period: overview.period || null,
        metrics: overviewValues,
      },
      reconciliation: {
        status: endpointsAgree ? 'MATCH' : 'ENDPOINTS_DISAGREE',
        message: endpointsAgree
          ? 'Key metrics dan product overview memiliki angka GMV/order yang sama.'
          : 'Key metrics dan product overview menggunakan definisi funnel/status order yang berbeda; jangan satukan angkanya tanpa memilih sumber dashboard.',
      },
    },
    products: {
      ...sourceStatus(products),
      live: products?.live ?? null,
      period: {
        period: products?.period || null,
        startTime: products?.startTime || null,
        endTime: products?.endTime || null,
      },
      total: products?.total ?? null,
      metrics: metricValues(products?.summary, ['totalSales', 'totalOrders', 'totalUnits', 'totalViews', 'totalVisitors', 'totalBuyers', 'averageConversionRate']),
      reconciliation: {
        status: productOverviewAgreement.confirmedSales && productOverviewAgreement.confirmedUnits ? 'MATCH_CORE_TOTALS' : 'MISMATCH',
        against: 'Product Overview confirmed',
        fields: productOverviewAgreement,
        note: 'GMV dan unit memakai grain produk. Orders/buyers serta visitor/view ditampilkan sebagai metrik produk dan tidak dibandingkan dengan buyer/UV unik toko.',
      },
      returnedProducts: Array.isArray(products?.products) ? products.products.slice(0, 10).map((product) => ({
        rank: product.rank,
        itemId: product.itemId,
        name: product.name,
        confirmedSales: product.confirmedSales,
        confirmedOrders: product.confirmedOrders,
        confirmedUnits: product.confirmedUnits,
        views: product.views,
        visitors: product.visitors,
        conversionRate: product.conversionRate,
      })) : [],
    },
  };
}

async function fetchStoredRange(range, session) {
  const startDate = shiftDateKey(jakartaDateKey(), -(range.days - 1));
  const endDate = jakartaDateKey();
  const result = {};
  for (const intent of ['IKLAN', 'PERFORMA_TOKO', 'PERFORMA_PRODUK']) {
    const validation = await hermesAnalysisService.validate({
      intent, user: { id: session.userId, role: 'USER' }, sourceMode: 'SNAPSHOT', storeId: session.storeId,
      startDate, endDate,
    });
    result[intent] = {
      quality: validation.quality ? {
        status: validation.quality.status,
        reason: validation.quality.reason,
        sources: validation.quality.sources,
      } : null,
      trustedMetrics: Object.fromEntries(Object.entries(validation.trustedContextPreview?.trustedMetrics || {}).map(([key, metric]) => [key, metric.value])),
      dataGaps: validation.dataGaps || [],
    };
  }
  return result;
}

async function main() {
  const session = await prisma.storeSession.findFirst({
    where: { isActive: true, userId: { not: null } },
    select: { storeId: true, storeName: true, userId: true },
    orderBy: { updatedAt: 'desc' },
  });
  if (!session) throw new Error('Tidak ada session toko aktif dengan userId.');

  const report = {
    generatedAt: new Date().toISOString(),
    mode: 'LIVE_SHOPEE_READ_ONLY',
    note: 'Live endpoint Seller Center dibandingkan dengan snapshot aplikasi. Tidak ada write, Sync, atau request Hermes.',
    store: { storeId: session.storeId, storeName: session.storeName },
    ranges: [],
  };

  for (const range of RANGES) {
    const [live, stored] = await Promise.all([
      fetchLiveRange(range, session.storeId),
      fetchStoredRange(range, session),
    ]);
    report.ranges.push({ ...live, storedSnapshot: stored });
  }

  if (process.argv.includes('--summary')) {
    const summary = {
      generatedAt: report.generatedAt,
      mode: report.mode,
      note: report.note,
      store: report.store,
      ranges: report.ranges.map((range) => ({
        label: range.label,
        period: range.period,
        ads: range.ads,
        store: range.store,
        products: {
          source: range.products.source,
          message: range.products.message,
          live: range.products.live,
          period: range.products.period,
          total: range.products.total,
          metrics: range.products.metrics,
          reconciliation: range.products.reconciliation,
          returnedProducts: range.products.returnedProducts.slice(0, 5),
        },
        storedSnapshot: Object.fromEntries(Object.entries(range.storedSnapshot).map(([intent, stored]) => [intent, {
          quality: stored.quality,
          trustedMetrics: stored.trustedMetrics,
          dataGaps: stored.dataGaps,
        }])),
      })),
    };
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

main()
  .catch((error) => {
    console.error('Live Shopee range report gagal:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
