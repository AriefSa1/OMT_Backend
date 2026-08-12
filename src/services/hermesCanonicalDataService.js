const shopeeService = require('./shopeeService');

const NATIVE_PERIODS = Object.freeze({
  SEVEN_DAYS: 'past7days',
  THIRTY_DAYS: 'past30days',
});

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function metricValue(metrics, field) {
  const candidate = metrics?.[field];
  if (candidate && typeof candidate === 'object' && 'value' in candidate) return finiteNumber(candidate.value);
  return finiteNumber(candidate);
}

function dateKeyFromEpoch(epochSeconds) {
  const epoch = finiteNumber(epochSeconds);
  if (epoch === null) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(epoch * 1000));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function nativePeriodForRange(range) {
  return range.days <= 7 ? NATIVE_PERIODS.SEVEN_DAYS : NATIVE_PERIODS.THIRTY_DAYS;
}

function effectivePeriod(range, nativePeriod, startTime = null, endTime = null) {
  return {
    requested: {
      startDate: range.startDate,
      endDate: range.endDate,
      days: range.days,
    },
    native: nativePeriod,
    measured: {
      startDate: dateKeyFromEpoch(startTime),
      endDate: dateKeyFromEpoch(endTime),
      startTime: finiteNumber(startTime),
      endTime: finiteNumber(endTime),
    },
  };
}

function sourceRecord(name, range, nativePeriod, options = {}) {
  const measuredStart = options.startTime || null;
  const measuredEnd = options.endTime || null;
  const asOf = options.dataAsOf || null;
  return {
    name,
    source: options.source || 'SHOPEE_API',
    status: options.status || 'VALID',
    rows: options.rows ?? 1,
    dataAsOf: asOf,
    retrievedAt: new Date().toISOString(),
    freshnessStatus: asOf ? 'MEASURED' : 'UNKNOWN',
    invalidRows: options.invalidRows || 0,
    coverage: {
      requestedDays: range.days,
      measuredDays: options.measuredDays ?? range.days,
      coverageRatio: options.coverageRatio ?? 1,
      dates: [],
      from: dateKeyFromEpoch(measuredStart) || range.startDate,
      to: dateKeyFromEpoch(measuredEnd) || range.endDate,
    },
    effectivePeriod: effectivePeriod(range, nativePeriod, measuredStart, measuredEnd),
    message: options.message || null,
  };
}

function unavailable(name, range, nativePeriod, message) {
  return sourceRecord(name, range, nativePeriod, {
    status: 'UNAVAILABLE',
    rows: 0,
    measuredDays: 0,
    coverageRatio: 0,
    dataAsOf: null,
    message,
  });
}

function liveFailure(intent, range, sources, message, errorCode = 'LIVE_SOURCE_UNAVAILABLE') {
  return {
    success: false,
    intent,
    sourceMode: 'LIVE_CANONICAL',
    period: range,
    quality: {
      status: 'BLOCKED',
      analysisMode: 'BLOCKED',
      canCallHermes: false,
      reason: message,
      sources,
      dataGaps: [message],
      reconciliation: { status: 'NOT_EVALUATED', fields: {} },
      errorCode,
    },
    trustedMetrics: {},
    comparisons: {},
    details: {},
    evidence: [],
    allowedClaims: [],
    blockedClaims: [message],
    dataGaps: [message],
  };
}

function evidence(id, metric, value, unit, source, sourceField, period, grain, extra = {}) {
  return {
    id,
    metric,
    value: value === null || value === undefined ? null : finiteNumber(value),
    unit,
    source,
    sourceField,
    period,
    grain,
    dataAsOf: extra.dataAsOf || null,
    freshnessStatus: extra.dataAsOf ? 'MEASURED' : 'UNKNOWN',
    trusted: value !== null && value !== undefined && Number.isFinite(Number(value)),
  };
}

function buildLiveQuality(intent, range, sources, gaps = [], reconciliation = { status: 'NOT_REQUIRED', fields: {} }) {
  const unavailableSource = sources.find((source) => source.status !== 'VALID');
  const hasMismatch = reconciliation.status === 'MISMATCH';
  const freshnessUnknown = sources.some((source) => source.status === 'VALID' && source.freshnessStatus === 'UNKNOWN');
  const status = unavailableSource || hasMismatch ? 'BLOCKED' : 'SAFE';
  const reason = unavailableSource
    ? unavailableSource.message || 'Sumber live kanonik tidak tersedia.'
    : hasMismatch
      ? 'Sumber live kanonik tidak memiliki angka core yang konsisten.'
      : 'Sumber live kanonik tersedia dan rekonsiliasi core berhasil.';
  const dataGaps = [...new Set([
    ...gaps,
    ...(hasMismatch ? ['GMV atau unit antar-sumber tidak cocok.'] : []),
    ...(freshnessUnknown ? ['Timestamp dataAsOf tidak diberikan oleh sumber live; freshness historis tidak dapat dipastikan.'] : []),
  ])];
  return {
    status,
    analysisMode: status === 'SAFE' ? 'FULL' : 'BLOCKED',
    canCallHermes: status === 'SAFE',
    reason,
    intent,
    period: range,
    sourceMode: 'LIVE_CANONICAL',
    sources,
    freshnessStatus: freshnessUnknown ? 'UNKNOWN' : 'MEASURED',
    reconciliation,
    dataGaps,
    thresholds: {
      sourceMode: 'LIVE_CANONICAL',
      requiresCoreReconciliation: intent === 'PERFORMA_PRODUK',
    },
  };
}

class HermesCanonicalDataService {
  async load({ intent, range, storeId } = {}) {
    const nativePeriod = nativePeriodForRange(range);
    if (intent === 'IKLAN') return this.loadAds({ intent, range, nativePeriod, storeId });
    if (intent === 'PERFORMA_TOKO') return this.loadStore({ intent, range, nativePeriod, storeId });
    if (intent === 'PERFORMA_PRODUK') return this.loadProducts({ intent, range, nativePeriod, storeId });
    return liveFailure(intent, range, [], 'Intent tidak memiliki adapter sumber kanonik.', 'UNKNOWN_INTENT');
  }

  async loadAds({ intent, range, nativePeriod, storeId }) {
    const result = await shopeeService.fetchShopeeAdsMetrics({ period: nativePeriod, storeId });
    const period = result?.period || {};
    const source = result?.success && result?.dataSource === 'SHOPEE_API'
      ? sourceRecord('shopee_ads_live', range, nativePeriod, {
        startTime: period.startTime,
        endTime: period.endTime,
      })
      : unavailable('shopee_ads_live', range, nativePeriod, result?.message || 'Data iklan live tidak tersedia.');
    if (source.status !== 'VALID') return liveFailure(intent, range, [source], source.message);

    const sourcePeriod = effectivePeriod(range, nativePeriod, period.startTime, period.endTime);
    const metrics = {
      spend: result.totalSpend,
      sales: result.totalSalesGenerated,
      roas: result.roas,
      impressions: result.impressions,
      clicks: result.clicks,
      ctr: result.ctr,
      orders: result.orders,
      itemSold: result.itemSold,
    };
    const evidenceRows = [
      evidence('ads_spend', 'spend', metrics.spend, 'IDR', 'Shopee Ads live', 'totalSpend', sourcePeriod, 'store'),
      evidence('ads_sales', 'sales', metrics.sales, 'IDR', 'Shopee Ads live', 'totalSalesGenerated', sourcePeriod, 'store'),
      evidence('ads_roas', 'roas', metrics.roas, 'x', 'Shopee Ads live', 'roas', sourcePeriod, 'store'),
      evidence('ads_impressions', 'impressions', metrics.impressions, 'count', 'Shopee Ads live', 'impressions', sourcePeriod, 'store'),
      evidence('ads_clicks', 'clicks', metrics.clicks, 'count', 'Shopee Ads live', 'clicks', sourcePeriod, 'store'),
      evidence('ads_ctr', 'ctr', metrics.ctr, '%', 'Shopee Ads live', 'ctr', sourcePeriod, 'store'),
    ];
    return {
      success: true,
      intent,
      sourceMode: 'LIVE_CANONICAL',
      period: range,
      effectivePeriod: sourcePeriod,
      quality: buildLiveQuality(intent, range, [source], [
        'HPP dan biaya admin marketplace belum tersedia; profit tidak boleh disimpulkan.',
        'Perbandingan periode sebelumnya belum diambil oleh adapter live ini.',
      ]),
      trustedMetrics: metrics,
      comparisons: {},
      details: {
        campaigns: (result.topCampaigns || []).slice(0, 20),
        campaignCountMeasured: Array.isArray(result.topCampaigns) ? result.topCampaigns.length : 0,
      },
      evidence: evidenceRows,
      allowedClaims: ['Gunakan hanya metrik iklan live yang tercantum pada evidence dan details.'],
      blockedClaims: ['Jangan menyimpulkan profit, rugi, atau kenaikan budget tanpa HPP, biaya marketplace, dan eksperimen terukur.'],
      dataGaps: [],
    };
  }

  async loadStore({ intent, range, nativePeriod, storeId }) {
    const result = await shopeeService.fetchProductOverview({ period: nativePeriod, storeId });
    const metrics = result?.metrics || null;
    const source = result?.source === 'SHOPEE_API' && metrics
      ? sourceRecord('shopee_product_overview_confirmed', range, nativePeriod)
      : unavailable('shopee_product_overview_confirmed', range, nativePeriod, result?.message || 'Product Overview confirmed tidak tersedia.');
    if (source.status !== 'VALID') return liveFailure(intent, range, [source], source.message);

    const values = {
      confirmedGmv: metricValue(metrics, 'confirmed_gmv'),
      confirmedBuyers: metricValue(metrics, 'confirmed_buyers'),
      confirmedUnits: metricValue(metrics, 'confirmed_unit_num'),
      visitors: metricValue(metrics, 'uv'),
      placedGmv: metricValue(metrics, 'placed_gmv'),
      placedBuyers: metricValue(metrics, 'placed_buyers'),
    };
    const sourcePeriod = effectivePeriod(range, nativePeriod);
    const evidenceRows = [
      evidence('store_confirmed_gmv', 'confirmedGmv', values.confirmedGmv, 'IDR', 'Product Overview', 'confirmed_gmv', sourcePeriod, 'store'),
      evidence('store_confirmed_buyers', 'confirmedBuyers', values.confirmedBuyers, 'count', 'Product Overview', 'confirmed_buyers', sourcePeriod, 'store'),
      evidence('store_confirmed_units', 'confirmedUnits', values.confirmedUnits, 'count', 'Product Overview', 'confirmed_unit_num', sourcePeriod, 'store'),
      evidence('store_visitors', 'visitors', values.visitors, 'count', 'Product Overview', 'uv', sourcePeriod, 'store'),
    ];
    return {
      success: true,
      intent,
      sourceMode: 'LIVE_CANONICAL',
      period: range,
      effectivePeriod: sourcePeriod,
      quality: buildLiveQuality(intent, range, [source], [
        'Cancellation rate tidak disimpulkan karena denominator yang sesuai tidak tersedia.',
        'Perbandingan periode sebelumnya belum diambil oleh adapter live ini.',
      ]),
      trustedMetrics: values,
      comparisons: {},
      details: { funnel: metrics },
      evidence: evidenceRows,
      allowedClaims: ['Gunakan confirmed GMV, confirmed buyers, confirmed units, dan visitors sesuai Product Overview.'],
      blockedClaims: ['Jangan menyamakan metrik level toko dengan agregat metrik level produk.'],
      dataGaps: [],
    };
  }

  async loadProducts({ intent, range, nativePeriod, storeId }) {
    const [performance, overview] = await Promise.all([
      shopeeService.fetchProductPerformance({ period: nativePeriod, pageSize: 10, pageNum: 1, orderBy: 'confirmed_sales.desc', storeId }),
      shopeeService.fetchProductOverview({ period: nativePeriod, storeId }),
    ]);
    const performanceSource = performance?.dataSource === 'SHOPEE_API' && performance?.live
      ? sourceRecord('shopee_product_performance_all_pages', range, nativePeriod, {
        startTime: performance.startTime,
        endTime: performance.endTime,
      })
      : unavailable('shopee_product_performance_all_pages', range, nativePeriod, performance?.message || 'Product Performance live tidak tersedia.');
    const overviewSource = overview?.source === 'SHOPEE_API' && overview?.metrics
      ? sourceRecord('shopee_product_overview_confirmed', range, nativePeriod)
      : unavailable('shopee_product_overview_confirmed', range, nativePeriod, overview?.message || 'Product Overview confirmed tidak tersedia.');
    const sources = [performanceSource, overviewSource];
    if (sources.some((source) => source.status !== 'VALID')) {
      return liveFailure(intent, range, sources, sources.find((source) => source.status !== 'VALID')?.message || 'Sumber produk live tidak lengkap.');
    }

    const productSummary = performance.summary || {};
    const overviewMetrics = overview.metrics || {};
    const confirmedGmv = metricValue(overviewMetrics, 'confirmed_gmv');
    const confirmedUnits = metricValue(overviewMetrics, 'confirmed_unit_num');
    const fields = {
      confirmedSales: productSummary.totalSales === confirmedGmv,
      confirmedUnits: productSummary.totalUnits === confirmedUnits,
    };
    const reconciliation = {
      status: fields.confirmedSales && fields.confirmedUnits ? 'MATCH' : 'MISMATCH',
      fields,
      against: 'Product Overview confirmed',
    };
    const sourcePeriod = effectivePeriod(range, nativePeriod, performance.startTime, performance.endTime);
    const evidenceRows = [
      evidence('product_total_sales', 'confirmedSales', productSummary.totalSales, 'IDR', 'Product Performance', 'summary.totalSales', sourcePeriod, 'product'),
      evidence('product_total_orders', 'confirmedOrders', productSummary.totalOrders, 'count', 'Product Performance', 'summary.totalOrders', sourcePeriod, 'product'),
      evidence('product_total_units', 'confirmedUnits', productSummary.totalUnits, 'count', 'Product Performance', 'summary.totalUnits', sourcePeriod, 'product'),
      evidence('product_total_views', 'views', productSummary.totalViews, 'count', 'Product Performance', 'summary.totalViews', sourcePeriod, 'product'),
      evidence('product_total_visitors', 'visitors', productSummary.totalVisitors, 'count', 'Product Performance', 'summary.totalVisitors', sourcePeriod, 'product'),
      evidence('product_total_buyers', 'confirmedBuyers', productSummary.totalBuyers, 'count', 'Product Performance', 'summary.totalBuyers', sourcePeriod, 'product'),
      evidence('overview_confirmed_gmv', 'confirmedGmv', confirmedGmv, 'IDR', 'Product Overview', 'confirmed_gmv', sourcePeriod, 'store'),
      evidence('overview_confirmed_units', 'confirmedUnits', confirmedUnits, 'count', 'Product Overview', 'confirmed_unit_num', sourcePeriod, 'store'),
    ];
    return {
      success: true,
      intent,
      sourceMode: 'LIVE_CANONICAL',
      period: range,
      effectivePeriod: sourcePeriod,
      quality: buildLiveQuality(intent, range, sources, [
        'Buyer, order, views, dan visitors pada Product Performance adalah agregat grain produk; jangan disamakan dengan buyer/UV unik tingkat toko.',
        'Profit, stok gudang, dan kategori resmi tidak disimpulkan tanpa data pendukung.',
      ], reconciliation),
      trustedMetrics: {
        measuredProducts: performance.total,
        confirmedSales: productSummary.totalSales,
        confirmedOrders: productSummary.totalOrders,
        confirmedUnits: productSummary.totalUnits,
        confirmedBuyers: productSummary.totalBuyers,
        views: productSummary.totalViews,
        visitors: productSummary.totalVisitors,
        averageConversionRate: productSummary.averageConversionRate,
      },
      comparisons: {},
      details: {
        products: (performance.products || []).slice(0, 20),
        catalogCount: performance.total,
        reconciliation,
      },
      evidence: evidenceRows,
      allowedClaims: ['Gunakan GMV/unit sebagai core total yang sudah direkonsiliasi; beri label grain produk untuk metrik lainnya.'],
      blockedClaims: ['Jangan menyatakan seluruh portfolio memiliki tren tanpa dua periode lengkap; jangan mencampur buyer/UV produk dengan buyer/UV toko.'],
      dataGaps: [],
    };
  }
}

const service = new HermesCanonicalDataService();
service.HermesCanonicalDataService = HermesCanonicalDataService;
service.nativePeriodForRange = nativePeriodForRange;
service.metricValue = metricValue;

module.exports = service;
