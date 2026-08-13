const prisma = require('../utils/prisma');
const shopeeService = require('./shopeeService');
const hermesAgentService = require('./hermesAgentService');
const hermesCanonicalDataService = require('./hermesCanonicalDataService');
const hermesOutputValidator = require('./hermesOutputValidator');
const hermesMemoryService = require('./hermesMemoryService');
const { sanitizeForHermes } = require('./hermesPayloadSanitizer');
const { getSkill } = require('./hermesSkillRegistry');
const { listMetrics } = require('./hermesMetricRegistry');
const { reviewContext } = require('./hermesDecisionReviewer');

const HERMES_PROMPT_VERSION = '1.2.0';
const HERMES_OUTPUT_SCHEMA_VERSION = '1.0';

function addRecommendationMetadata(analysis) {
  return {
    ...analysis,
    schemaVersion: analysis.schemaVersion || HERMES_OUTPUT_SCHEMA_VERSION,
    prioritizedActions: (analysis.prioritizedActions || []).map((action, index) => ({
      ...action,
      recommendationId: action.recommendationId || `rec-${index + 1}`,
    })),
  };
}

const DEFAULT_ANALYSIS_DAYS = 30;
const MAX_ANALYSIS_DAYS = 90;
const MINIMUM_COVERAGE_RATIO = 0.5;
const SAFE_COVERAGE_RATIO = 0.8;
const MINIMUM_CAMPAIGN_ROWS = 2;
const MINIMUM_PRODUCT_ROWS = 5;

const INTENTS = Object.freeze({
  ADS: 'IKLAN',
  STORE: 'PERFORMA_TOKO',
  PRODUCT: 'PERFORMA_PRODUK',
});

const THRESHOLDS = Object.freeze({
  defaultDays: DEFAULT_ANALYSIS_DAYS,
  maxDays: MAX_ANALYSIS_DAYS,
  minimumMeasuredRows: 1,
  minimumCoverageRatio: MINIMUM_COVERAGE_RATIO,
  safeCoverageRatio: SAFE_COVERAGE_RATIO,
  minimumCampaignRows: MINIMUM_CAMPAIGN_ROWS,
  minimumProductRows: MINIMUM_PRODUCT_ROWS,
  maximumAgeHours: {
    IKLAN: 48,
    PERFORMA_TOKO: 48,
    PERFORMA_PRODUK: 72,
  },
});

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegative(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function normalizeRatePercent(value) {
  const parsed = nonNegative(value);
  if (parsed === null) return null;
  return parsed > 0 && parsed <= 1 ? parsed * 100 : parsed;
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

function shiftDateKey(value, days) {
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

function dayDistance(startDate, endDate) {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  return Math.round((end - start) / 86400000) + 1;
}

function resolveAnalysisRange({ startDate, endDate, days } = {}) {
  let start = isIsoDate(startDate) ? startDate : null;
  let end = isIsoDate(endDate) ? endDate : null;
  const hasExplicitDays = days !== undefined && days !== null && Number.isFinite(Number(days));
  const desiredDays = Math.max(1, Number(days) || DEFAULT_ANALYSIS_DAYS);

  if (start && end && start > end) [start, end] = [end, start];
  if (!start || !end) {
    // Shopee native past7days/past30days memakai hari selesai terakhir dan tidak
    // memasukkan hari berjalan. Selaraskan default range agar angka yang dikirim
    // tidak diberi label seolah-olah mencakup hari ini.
    end = shiftDateKey(dateKey(), -1);
    start = shiftDateKey(end, -(desiredDays - 1));
  }

  const requestedDays = dayDistance(start, end);
  if (requestedDays > MAX_ANALYSIS_DAYS) {
    start = shiftDateKey(end, -(MAX_ANALYSIS_DAYS - 1));
  }

  return {
    startDate: start,
    endDate: end,
    days: dayDistance(start, end),
    defaulted: !isIsoDate(startDate) || !isIsoDate(endDate),
    defaultRange: (!isIsoDate(startDate) || !isIsoDate(endDate)) && !hasExplicitDays,
  };
}

function normalizeIntent(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized === 'iklan' || normalized === 'ads') return INTENTS.ADS;
  if (normalized === 'performa toko' || normalized === 'performa_toko') return INTENTS.STORE;
  if (normalized === 'performa produk' || normalized === 'performa_produk' || normalized === 'produk') return INTENTS.PRODUCT;
  return null;
}

function asSourceMetric(value, unit, source, sourceField, reason = null) {
  const parsed = value === null || value === undefined ? null : finiteNumber(value);
  return {
    value: parsed,
    unit,
    source,
    sourceField,
    trusted: parsed !== null,
    reason: parsed === null ? (reason || 'Nilai sumber tidak tersedia atau tidak valid.') : null,
  };
}

function sumRows(rows, field) {
  const values = rows.map((row) => nonNegative(row[field])).filter((value) => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function maxDateTime(rows, field = 'dataAsOf') {
  const dates = rows.map((row) => row[field]).filter(Boolean).map((value) => new Date(value)).filter((value) => !Number.isNaN(value.valueOf()));
  if (!dates.length) return null;
  return new Date(Math.max(...dates.map((value) => value.valueOf()))).toISOString();
}

function coverage(rows, range) {
  const dates = [...new Set(rows.map((row) => row.date).filter((value) => isIsoDate(value)))];
  const measuredDays = dates.filter((value) => value >= range.startDate && value <= range.endDate).length;
  const coverageRatio = range.days > 0 ? measuredDays / range.days : 0;
  return {
    requestedDays: range.days,
    measuredDays,
    coverageRatio,
    dates: dates.sort(),
    from: dates.length ? dates[0] : null,
    to: dates.length ? dates[dates.length - 1] : null,
  };
}

function splitPeriods(rows, range) {
  const midpoint = shiftDateKey(range.startDate, Math.floor((range.days - 1) / 2));
  const previous = rows.filter((row) => row.date >= range.startDate && row.date <= midpoint);
  const current = rows.filter((row) => row.date > midpoint && row.date <= range.endDate);
  return {
    previous: { startDate: range.startDate, endDate: midpoint, rows: previous },
    current: { startDate: shiftDateKey(midpoint, 1), endDate: range.endDate, rows: current },
  };
}

function aggregateAds(rows) {
  const spend = sumRows(rows, 'spend');
  const sales = sumRows(rows, 'sales');
  const impressions = sumRows(rows, 'impressions');
  const clicks = sumRows(rows, 'clicks');
  return {
    spend,
    sales,
    impressions,
    clicks,
    orders: sumRows(rows, 'orders'),
    itemSold: sumRows(rows, 'itemSold'),
    roas: spend !== null && spend > 0 && sales !== null ? sales / spend : null,
    ctr: impressions !== null && impressions > 0 && clicks !== null ? (clicks / impressions) * 100 : null,
    rows: rows.length,
  };
}

function aggregateOrders(rows) {
  const gmv = sumRows(rows, 'gmv');
  const orders = sumRows(rows, 'orderCount');
  const conversionValues = rows.map((row) => normalizeRatePercent(row.conversionRate)).filter((value) => value !== null);
  return {
    gmv,
    orders,
    averageOrderValue: gmv !== null && orders !== null && orders > 0 ? gmv / orders : null,
    conversionRate: conversionValues.length ? conversionValues.reduce((sum, value) => sum + value, 0) / conversionValues.length : null,
    cancelledOrders: sumRows(rows, 'cancelledOrders'),
    cancelledSales: sumRows(rows, 'cancelledSales'),
    returnRefundOrders: sumRows(rows, 'returnRefundOrders'),
    returnRefundSales: sumRows(rows, 'returnRefundSales'),
    rows: rows.length,
  };
}

function aggregateProducts(rows, catalogById) {
  const grouped = new Map();
  for (const row of rows) {
    const itemId = String(row.shopeeItemId || '');
    if (!itemId) continue;
    const current = grouped.get(itemId) || {
      itemId,
      name: row.productName || itemId,
      category: row.category || 'Uncategorized',
      impressions: 0,
      clicks: 0,
      visitors: 0,
      confirmedOrders: 0,
      confirmedUnits: 0,
      confirmedSales: 0,
      addToCartUnits: 0,
      snapshots: 0,
    };
    current.impressions += nonNegative(row.impressions) ?? 0;
    current.clicks += nonNegative(row.clicks) ?? 0;
    current.visitors += nonNegative(row.visitors) ?? 0;
    current.confirmedOrders += nonNegative(row.confirmedOrders) ?? 0;
    current.confirmedUnits += nonNegative(row.confirmedUnits) ?? 0;
    current.confirmedSales += nonNegative(row.confirmedSales) ?? 0;
    const addToCart = nonNegative(row.addToCartUnits) ?? nonNegative(row.addToCartBuyers);
    if (addToCart !== null) current.addToCartUnits += addToCart;
    current.snapshots += 1;
    grouped.set(itemId, current);
  }

  const products = [...grouped.values()].map((item) => {
    const catalog = catalogById.get(item.itemId);
    return {
      ...item,
      name: catalog?.name || item.name,
      sku: catalog?.sku || null,
      category: catalog?.category || item.category || 'Uncategorized',
      marketplaceStock: catalog ? finiteNumber(catalog.stock) : null,
      ctr: item.impressions > 0 ? (item.clicks / item.impressions) * 100 : null,
      conversionRate: item.visitors > 0 ? (item.confirmedOrders / item.visitors) * 100 : null,
      addToCartRate: item.visitors > 0 ? (item.addToCartUnits / item.visitors) * 100 : null,
      unitCost: catalog?.unitCost ?? null,
      unitAdCost: catalog?.unitAdCost ?? null,
      shippingCost: catalog?.shippingCost ?? null,
      platformFeePercent: catalog?.platformFeePercent ?? null,
    };
  });
  products.sort((left, right) => right.confirmedSales - left.confirmedSales || right.confirmedOrders - left.confirmedOrders || left.name.localeCompare(right.name));
  return {
    totalProducts: products.length,
    totalSales: products.reduce((sum, item) => sum + item.confirmedSales, 0),
    totalOrders: products.reduce((sum, item) => sum + item.confirmedOrders, 0),
    totalUnits: products.reduce((sum, item) => sum + item.confirmedUnits, 0),
    totalImpressions: products.reduce((sum, item) => sum + item.impressions, 0),
    totalClicks: products.reduce((sum, item) => sum + item.clicks, 0),
    products: products.slice(0, 20),
  };
}

function makeSource(name, rows, range, options = {}) {
  const validRows = rows.filter((row) => isIsoDate(row.date)
    && row.date >= range.startDate
    && row.date <= range.endDate
    && (!options.validateRow || options.validateRow(row)));
  const coverageInfo = coverage(validRows, range);
  return {
    name,
    status: validRows.length ? 'VALID' : 'UNAVAILABLE',
    rows: validRows.length,
    dataAsOf: maxDateTime(validRows, options.timestampField || 'dataAsOf'),
    invalidRows: rows.length - validRows.length,
    validRows,
    coverage: coverageInfo,
    message: validRows.length ? null : (options.emptyMessage || 'Tidak ada baris terukur dalam rentang yang diminta.'),
  };
}

function buildQuality({ intent, range, session, sources, primarySource, minimumRows = 1, extraGaps = [], requiredClaims = [] }) {
  const primaryRows = primarySource?.rows || 0;
  const primaryCoverage = primarySource?.coverage?.coverageRatio || 0;
  const ageHours = primarySource?.dataAsOf ? Math.max(0, (Date.now() - new Date(primarySource.dataAsOf).valueOf()) / 3600000) : null;
  const maxAge = THRESHOLDS.maximumAgeHours[intent] || 72;
  const gaps = [...extraGaps];
  let status = 'SAFE';
  let reason = 'Data memenuhi kriteria minimum untuk analisa.';

  if (!session) {
    status = 'BLOCKED';
    reason = 'Tidak ada toko yang terikat pada akun aktif.';
    gaps.push('Hubungkan toko ke akun ini sebelum menjalankan analisa.');
  } else if (primaryRows < minimumRows) {
    status = 'BLOCKED';
    reason = 'Sumber utama tidak memiliki baris pengukuran yang valid dalam rentang ini.';
  } else if (primaryCoverage < MINIMUM_COVERAGE_RATIO) {
    status = 'LIMITED';
    reason = `Coverage sumber utama hanya ${(primaryCoverage * 100).toFixed(1)}%, di bawah minimum ${(MINIMUM_COVERAGE_RATIO * 100).toFixed(0)}%.`;
    gaps.push('Tidak semua hari dalam rentang memiliki pengukuran.');
  } else if (ageHours === null || ageHours > maxAge) {
    status = 'LIMITED';
    reason = ageHours === null ? 'Waktu pengukuran terakhir tidak tersedia.' : `Snapshot terakhir berusia ${ageHours.toFixed(1)} jam, melewati batas ${maxAge} jam.`;
    gaps.push('Snapshot perlu diperbarui melalui Sync.');
  } else if (primaryCoverage < SAFE_COVERAGE_RATIO) {
    status = 'LIMITED';
    reason = `Coverage sumber utama ${(primaryCoverage * 100).toFixed(1)}% cukup untuk deskripsi, tetapi belum ideal untuk kesimpulan mendalam.`;
  }

  return {
    status,
    // A limited or unreconciled source is useful for diagnostics, but it is not safe
    // enough for an agent whose output can influence business decisions. Hermes may run
    // only after the source is fully covered, fresh, and internally reconciled.
    canCallHermes: status === 'SAFE',
    analysisMode: status === 'SAFE' ? 'FULL' : 'LIMITED',
    reason,
    intent,
    period: range,
    sessionStoreId: session?.storeId || null,
    sources: sources.map(({ validRows, ...source }) => source),
    requiredClaims,
    dataGaps: [...new Set(gaps.filter(Boolean))],
    thresholds: {
      minimumMeasuredRows: minimumRows,
      minimumCoverageRatio: MINIMUM_COVERAGE_RATIO,
      safeCoverageRatio: SAFE_COVERAGE_RATIO,
      maximumAgeHours: maxAge,
    },
  };
}

function buildBlockedContext(intent, period) {
  const unavailableSource = {
    name: 'store_session',
    status: 'UNAVAILABLE',
    rows: 0,
    dataAsOf: null,
    invalidRows: 0,
    coverage: {
      requestedDays: period.days,
      measuredDays: 0,
      coverageRatio: 0,
      dates: [],
      from: null,
      to: null,
    },
    message: 'Tidak ada toko yang terikat pada akun aktif.',
  };
  const quality = buildQuality({
    intent,
    skill: getSkill(intent),
    range: period,
    session: null,
    sources: [unavailableSource],
    primarySource: unavailableSource,
    extraGaps: ['Hubungkan toko ke akun ini sebelum menjalankan analisa.'],
    requiredClaims: [],
  });
  return {
    success: true,
    intent,
    period,
    quality,
    trustedMetrics: {},
    comparisons: {},
    details: {},
    allowedClaims: [],
    blockedClaims: quality.dataGaps,
    dataGaps: quality.dataGaps,
  };
}

function addComparison(context, rows, aggregate) {
  const periods = splitPeriods(rows, context.period);
  const previous = aggregate(periods.previous.rows);
  const current = aggregate(periods.current.rows);
  return {
    previous: { startDate: periods.previous.startDate, endDate: periods.previous.endDate, ...previous },
    current: { startDate: periods.current.startDate, endDate: periods.current.endDate, ...current },
    comparable: periods.previous.rows.length > 0 && periods.current.rows.length > 0,
  };
}

class HermesAnalysisService {
  async resolveSession(user, requestedStoreId = null) {
    const session = requestedStoreId
      ? await prisma.storeSession.findUnique({ where: { storeId: String(requestedStoreId) } })
      : await shopeeService.getActiveSession(null, user);
    if (!session) return null;
    if (user?.role !== 'ADMIN' && session.userId !== user?.id) return null;
    return session;
  }

  async buildContext({ intent, prompt, user, storeId, startDate, endDate, days, sourceMode = 'LIVE_CANONICAL' } = {}) {
    const normalizedIntent = normalizeIntent(intent || prompt);
    if (!normalizedIntent) {
      return {
        success: false,
        errorCode: 'UNKNOWN_INTENT',
        message: 'Intent tidak dikenali. Gunakan Iklan, Performa Toko, atau Performa Produk.',
        statusCode: 400,
      };
    }

    const period = resolveAnalysisRange({ startDate, endDate, days });
    const session = await this.resolveSession(user, storeId);
    if (!session) return buildBlockedContext(normalizedIntent, period);
    const targetStoreId = session?.storeId || null;
    const learning = await hermesMemoryService.getLearningContext({
      userId: user?.id,
      storeId: targetStoreId,
      intent: normalizedIntent,
    }).catch(() => ({
      memoryCount: 0,
      feedback: [],
      outcomes: [],
      note: 'Memori analisa belum dapat dibaca; jangan menyimpulkan pembelajaran historis.',
    }));

    if (sourceMode === 'LIVE_CANONICAL') {
      const canonical = await hermesCanonicalDataService.load({
        intent: normalizedIntent,
        range: period,
        storeId: targetStoreId,
      });
      if (!canonical.success) {
        return {
          ...canonical,
          intent: normalizedIntent,
          period,
          quality: {
            ...canonical.quality,
            sessionStoreId: targetStoreId,
          },
        };
      }
      return {
        ...canonical,
        intent: normalizedIntent,
        period,
        skill: getSkill(normalizedIntent),
        metricCatalog: listMetrics(normalizedIntent),
        promptVersion: HERMES_PROMPT_VERSION,
        learning,
        dataGaps: canonical.quality.dataGaps,
        blockedClaims: [...new Set([...(canonical.blockedClaims || []), ...canonical.quality.dataGaps])],
        quality: {
          ...canonical.quality,
          sessionStoreId: targetStoreId,
        },
      };
    }

    const where = targetStoreId ? { storeId: targetStoreId, date: { gte: period.startDate, lte: period.endDate } } : { id: '__missing__' };

    if (normalizedIntent === INTENTS.ADS) {
      const [dailyRows, campaignRows] = await Promise.all([
        prisma.shopeeAdsData.findMany({ where, orderBy: { date: 'asc' } }),
        prisma.shopeeAdsCampaignSnapshot.findMany({ where, orderBy: { date: 'asc' } }),
      ]);
      const source = makeSource('ads_daily', dailyRows, period, {
        emptyMessage: 'Belum ada snapshot iklan harian.',
        validateRow: (row) => ['spend', 'sales', 'impressions', 'clicks', 'orders', 'itemSold'].every((field) => nonNegative(row[field]) !== null),
      });
      const campaignSource = makeSource('ads_campaigns', campaignRows, period, {
        emptyMessage: 'Belum ada snapshot kampanye iklan.',
        validateRow: (row) => Boolean(String(row.campaignId || '').trim())
          && ['spend', 'sales', 'impressions', 'clicks'].every((field) => nonNegative(row[field]) !== null),
      });
      const daily = aggregateAds(source.validRows);
      const comparison = addComparison({ period }, source.validRows, aggregateAds);
      const campaignMap = new Map();
      for (const row of campaignSource.validRows) {
        const key = String(row.campaignId);
        const current = campaignMap.get(key) || { campaignId: key, name: row.name, state: row.state, spend: 0, sales: 0, impressions: 0, clicks: 0, rows: 0 };
        current.spend += nonNegative(row.spend) ?? 0;
        current.sales += nonNegative(row.sales) ?? 0;
        current.impressions += nonNegative(row.impressions) ?? 0;
        current.clicks += nonNegative(row.clicks) ?? 0;
        current.rows += 1;
        campaignMap.set(key, current);
      }
      const campaigns = [...campaignMap.values()].map((row) => ({
        ...row,
        roas: row.spend > 0 ? row.sales / row.spend : null,
        ctr: row.impressions > 0 ? (row.clicks / row.impressions) * 100 : null,
      })).sort((a, b) => b.spend - a.spend).slice(0, 20);
      const gaps = [];
      if (daily.spend === null || daily.sales === null) gaps.push('Spend dan sales harus sama-sama tersedia untuk menghitung ROAS.');
      if (daily.impressions === null || daily.clicks === null) gaps.push('Impressions dan clicks belum lengkap untuk menghitung CTR.');
      gaps.push('HPP dan biaya admin marketplace belum menjadi bagian dari snapshot iklan; profit tidak boleh disimpulkan.');
      if (!comparison.comparable) gaps.push('Perbandingan paruh pertama dan paruh kedua periode belum tersedia.');
      if (campaignSource.rows < MINIMUM_CAMPAIGN_ROWS) gaps.push(`Perbandingan kampanye membutuhkan minimal ${MINIMUM_CAMPAIGN_ROWS} campaign terukur.`);
      const quality = buildQuality({
        intent: normalizedIntent,
        range: period,
        session,
        sources: [source, campaignSource],
        primarySource: source,
        extraGaps: gaps,
        requiredClaims: ['Spend, sales, ROAS, dan CTR hanya boleh disebut jika field sumber/denominator tersedia.'],
      });
      if (campaignSource.rows < MINIMUM_CAMPAIGN_ROWS && quality.status === 'SAFE') {
        quality.status = 'LIMITED';
        quality.analysisMode = 'LIMITED';
      }
      return this.finalizeContext({
        intent: normalizedIntent,
        period,
        quality,
        trustedMetrics: {
          spend: asSourceMetric(daily.spend, 'IDR', 'ShopeeAdsData', 'spend'),
          sales: asSourceMetric(daily.sales, 'IDR', 'ShopeeAdsData', 'sales'),
          roas: asSourceMetric(daily.roas, 'x', 'backend_calculation', 'sales / spend', 'Spend atau sales tidak tersedia.'),
          impressions: asSourceMetric(daily.impressions, 'count', 'ShopeeAdsData', 'impressions'),
          clicks: asSourceMetric(daily.clicks, 'count', 'ShopeeAdsData', 'clicks'),
          ctr: asSourceMetric(daily.ctr, '%', 'backend_calculation', 'clicks / impressions', 'Impressions atau clicks tidak tersedia.'),
        },
        comparisons: { daily: comparison },
        details: { campaigns, campaignCountMeasured: campaignMap.size },
        allowedClaims: ['Jelaskan performa spend, sales, ROAS, CTR, dan campaign hanya berdasarkan trustedMetrics dan details.'],
        blockedClaims: ['Jangan menyimpulkan profit, rugi, forecast, atau tren jika data gap menyatakannya tidak tersedia.'],
      });
    }

    if (normalizedIntent === INTENTS.STORE) {
      const [orderRows, adRows] = await Promise.all([
        prisma.shopeeOrderSummary.findMany({ where, orderBy: { date: 'asc' } }),
        prisma.shopeeAdsData.findMany({ where, orderBy: { date: 'asc' } }),
      ]);
      const source = makeSource('store_orders', orderRows, period, {
        emptyMessage: 'Belum ada ringkasan order harian.',
        timestampField: 'createdAt',
        validateRow: (row) => ['gmv', 'orderCount', 'conversionRate'].every((field) => nonNegative(row[field]) !== null),
      });
      const adsSource = makeSource('store_ads_context', adRows, period, {
        emptyMessage: 'Snapshot iklan tidak tersedia sebagai konteks tambahan.',
        validateRow: (row) => ['spend', 'sales', 'impressions', 'clicks', 'orders', 'itemSold'].every((field) => nonNegative(row[field]) !== null),
      });
      const orders = aggregateOrders(source.validRows);
      const comparison = addComparison({ period }, source.validRows, aggregateOrders);
      const gaps = [
        'Cancellation rate tidak dihitung karena denominator yang sesuai tidak tersedia dari sumber.',
        'Store rating, chat response rate, dan fulfillment speed tidak tersedia dari sumber yang dipakai.',
        'Conversion rate periode adalah rata-rata rate harian; denominator visitor total tidak tersedia untuk menghitung rasio berbobot.',
      ];
      if (orders.gmv === null || orders.orders === null) gaps.push('GMV dan jumlah order harus tersedia untuk menghitung AOV.');
      if (!comparison.comparable) gaps.push('Perbandingan paruh pertama dan paruh kedua periode belum tersedia.');
      const quality = buildQuality({
        intent: normalizedIntent,
        range: period,
        session,
        sources: [source, adsSource],
        primarySource: source,
        extraGaps: gaps,
        requiredClaims: ['GMV, orders, AOV, dan cancellation/return absolute hanya boleh disebut sesuai field yang tersedia.'],
      });
      return this.finalizeContext({
        intent: normalizedIntent,
        period,
        quality,
        trustedMetrics: {
          gmv: asSourceMetric(orders.gmv, 'IDR', 'ShopeeOrderSummary', 'gmv'),
          orders: asSourceMetric(orders.orders, 'count', 'ShopeeOrderSummary', 'orderCount'),
          averageOrderValue: asSourceMetric(orders.averageOrderValue, 'IDR', 'backend_calculation', 'gmv / orderCount', 'GMV atau jumlah order tidak tersedia.'),
          conversionRate: asSourceMetric(orders.conversionRate, '%', 'backend_calculation', 'average daily conversionRate', 'Denominator visitor total tidak tersedia; nilai adalah rata-rata rate harian.'),
          cancelledOrders: asSourceMetric(orders.cancelledOrders, 'count', 'ShopeeOrderSummary', 'cancelledOrders'),
          returnRefundOrders: asSourceMetric(orders.returnRefundOrders, 'count', 'ShopeeOrderSummary', 'returnRefundOrders'),
        },
        comparisons: { orders: comparison, ads: aggregateAds(adsSource.validRows) },
        details: { measuredOrderRows: source.validRows.length, measuredAdsRows: adsSource.validRows.length },
        allowedClaims: ['Jelaskan GMV, orders, AOV, absolute cancellation/return, dan perubahan antarbagian periode jika tersedia.'],
        blockedClaims: ['Jangan membuat cancellation rate, rating, fulfillment speed, chat response rate, forecast, atau sebab kausal tanpa bukti.'],
      });
    }

    const [metricRows, catalogRows] = await Promise.all([
      prisma.productMetricSnapshot.findMany({ where, orderBy: { date: 'asc' } }),
      targetStoreId ? prisma.shopeeProduct.findMany({ where: { storeId: targetStoreId } }) : [],
    ]);
    const source = makeSource('product_metrics', metricRows, period, {
      emptyMessage: 'Belum ada snapshot metric produk.',
      validateRow: (row) => Boolean(String(row.shopeeItemId || '').trim())
        && ['impressions', 'clicks', 'visitors', 'confirmedOrders', 'confirmedUnits', 'confirmedSales'].every((field) => nonNegative(row[field]) !== null),
    });
    const catalogSource = { name: 'product_catalog', status: catalogRows.length ? 'VALID' : 'UNAVAILABLE', rows: catalogRows.length, dataAsOf: maxDateTime(catalogRows, 'updatedAt'), coverage: null, message: catalogRows.length ? null : 'Belum ada katalog produk.' };
    const catalogById = new Map(catalogRows.map((row) => [String(row.shopeeItemId), row]));
    const products = aggregateProducts(source.validRows, catalogById);
    const measuredProductRows = products.totalProducts;
    const gaps = [
      `Analisa mencakup ${measuredProductRows} produk yang memiliki metric snapshot, bukan seluruh katalog secara otomatis.`,
      'Kategori resmi tidak digunakan sebagai dasar analisa jika data kategori hanya berisi Uncategorized.',
      'Stok gudang dan profit tidak disimpulkan tanpa mapping dan field biaya yang lengkap.',
    ];
    if (measuredProductRows < MINIMUM_PRODUCT_ROWS) gaps.push(`Perbandingan portfolio membutuhkan minimal ${MINIMUM_PRODUCT_ROWS} produk terukur.`);
    if (products.totalImpressions === 0) gaps.push('Impressions tidak tersedia sehingga CTR portfolio tidak dapat dihitung.');
    const quality = buildQuality({
      intent: normalizedIntent,
      range: period,
      session,
      sources: [source, catalogSource],
      primarySource: source,
      extraGaps: gaps,
      requiredClaims: ['Perbandingan produk hanya boleh memakai produk dengan metric snapshot dalam periode yang sama.'],
    });
    if (measuredProductRows < MINIMUM_PRODUCT_ROWS && quality.status === 'SAFE') {
      quality.status = 'LIMITED';
      quality.analysisMode = 'LIMITED';
    }
    const totalCtr = products.totalImpressions > 0 ? (products.totalClicks / products.totalImpressions) * 100 : null;
    const measuredProductsMetric = measuredProductRows > 0 ? measuredProductRows : null;
    const productSalesMetric = measuredProductRows > 0 ? products.totalSales : null;
    const productOrdersMetric = measuredProductRows > 0 ? products.totalOrders : null;
    const productImpressionsMetric = measuredProductRows > 0 ? products.totalImpressions : null;
    const productClicksMetric = measuredProductRows > 0 ? products.totalClicks : null;
    return this.finalizeContext({
      intent: normalizedIntent,
      period,
      quality,
      trustedMetrics: {
        measuredProducts: asSourceMetric(measuredProductsMetric, 'count', 'ProductMetricSnapshot', 'distinct shopeeItemId'),
        confirmedSales: asSourceMetric(productSalesMetric, 'IDR', 'ProductMetricSnapshot', 'confirmedSales'),
        confirmedOrders: asSourceMetric(productOrdersMetric, 'count', 'ProductMetricSnapshot', 'confirmedOrders'),
        impressions: asSourceMetric(productImpressionsMetric, 'count', 'ProductMetricSnapshot', 'impressions'),
        clicks: asSourceMetric(productClicksMetric, 'count', 'ProductMetricSnapshot', 'clicks'),
        ctr: asSourceMetric(totalCtr, '%', 'backend_calculation', 'clicks / impressions', 'Impressions tidak tersedia.'),
      },
      comparisons: {},
      details: { products: products.products, catalogCount: catalogRows.length },
      allowedClaims: ['Jelaskan hanya produk dan metrik yang ada dalam details serta trustedMetrics.'],
      blockedClaims: ['Jangan menyatakan seluruh katalog terukur, jangan membuat kategori, profit, stok gudang, atau forecast tanpa data pendukung.'],
    });
  }

  finalizeContext({ intent, period, quality, trustedMetrics, comparisons, details, allowedClaims, blockedClaims }) {
    quality.canCallHermes = quality.status === 'SAFE';
    const blocked = [...new Set([...(quality.dataGaps || []), ...(blockedClaims || [])])];
    return {
      success: true,
      intent,
      skill: getSkill(intent),
      metricCatalog: listMetrics(intent),
      promptVersion: HERMES_PROMPT_VERSION,
      period,
      quality,
      trustedMetrics,
      comparisons,
      details,
      allowedClaims,
      blockedClaims: blocked,
      dataGaps: quality.dataGaps,
    };
  }

  buildMessages(context) {
    const skillInstructions = context.skill?.instructions?.join(' ') || 'Gunakan hanya data trusted dan evidence ledger.';
    const safeContext = sanitizeForHermes(context);
    return [
      {
        role: 'system',
        content: `Anda adalah partner analis bisnis yang kritis dan berbasis bukti. Skill aktif: ${context.skill?.label || context.intent} (${context.skill?.version || 'unknown'}). Instruksi skill: ${skillInstructions} Analisa intent ${context.intent} menggunakan HANYA TRUSTED_CONTEXT. Bedakan fakta, interpretasi, hipotesis, dan tindakan. Jangan membuat angka, jangan mengubah angka trusted, jangan mengubah null menjadi 0, dan jangan menyimpulkan metrik yang tercantum di blockedClaims. Jika quality.status bukan SAFE, jangan membuat analisa bisnis. Setiap temuan, hipotesis, dan tindakan wajib menunjuk evidenceIds yang ada di evidence ledger. Nilai numerik terstruktur hanya boleh memakai nilai yang ada di evidence atau trustedMetrics. Untuk hipotesis, jelaskan howToTest. Untuk tindakan, berikan baseline/target hanya jika nilainya ada di evidence, serta expectedMeasurement yang dapat diuji. Gunakan schemaVersion=\"1.0\" dan balas JSON valid saja dengan bentuk: {\"schemaVersion\":\"1.0\",\"executiveVerdict\":\"string\",\"criticalFindings\":[{\"severity\":\"HIGH|MEDIUM|LOW\",\"title\":\"string\",\"description\":\"string\",\"evidenceIds\":[\"ev_id\"],\"impact\":{\"metric\":\"string\",\"value\":null,\"unit\":\"string\"},\"confidence\":\"HIGH|MEDIUM|LOW\"}],\"rootCauseAnalysis\":[{\"hypothesis\":\"string\",\"supportingEvidenceIds\":[\"ev_id\"],\"howToTest\":\"string\",\"confidence\":\"HIGH|MEDIUM|LOW\"}],\"prioritizedActions\":[{\"priority\":1,\"action\":\"string\",\"reason\":\"string\",\"evidenceIds\":[\"ev_id\"],\"baseline\":{\"metric\":\"string\",\"value\":null,\"unit\":\"string\"},\"target\":{\"metric\":\"string\",\"value\":null,\"unit\":\"string\"},\"expectedMeasurement\":\"string\"}],\"dataGaps\":[\"string\"],\"uncertainty\":[\"string\"]}.`,
      },
      {
        role: 'system',
        content: `Learning loop contract versi ${HERMES_PROMPT_VERSION}: jika tindakan memiliki metricKey dan baseline/target numerik yang ada di trusted evidence, tambahkan windowDays bernilai 7 atau 30. Gunakan hanya metricKey yang tersedia untuk intent ini. Jika tidak ada angka tervalidasi, jangan mengarangnya; tindakan akan dicatat sebagai unmeasured. Outcome historis hanya sinyal pembelajaran dan tidak boleh diperlakukan sebagai bukti kausal.`,
      },
      {
        role: 'system',
        content: 'Setiap prioritizedAction boleh menyertakan metricKey dan windowDays. Gunakan metricKey yang sama dengan baseline.metric/target.metric dan hanya angka/unit yang ada pada evidence; jika tidak dapat dibuktikan, gunakan null dan jangan mengarang. Metadata tracking adalah opsional: bila metricKey tidak ada di Metric contract, jangan gunakan metricKey/windowDays/baseline/target untuk metrik itu; tetap kembalikan tindakan sebagai tindakan kualitatif tanpa tracking.',
      },
      {
        role: 'system',
        content: `Metric contract canonical: ${JSON.stringify(context.metricCatalog || [])}. Gunakan unit persis dari katalog; untuk conversion rate gunakan percentage points dengan unit "%", bukan unit "ratio" atau pecahan 0-1.`,
      },
      {
        role: 'user',
        content: `TRUSTED_CONTEXT:\n${JSON.stringify(safeContext)}`,
      },
    ];
  }

  async validate(args = {}) {
    const context = await this.buildContext(args);
    if (!context.success) return context;
    return {
      success: true,
      intent: context.intent,
      period: context.period,
      quality: context.quality,
      canCallHermes: context.quality.canCallHermes,
      trustedContextPreview: {
        trustedMetrics: context.trustedMetrics,
        comparisons: context.comparisons,
        details: context.details,
        evidence: context.evidence || [],
        effectivePeriod: context.effectivePeriod || null,
        sourceMode: context.sourceMode || context.quality?.sourceMode || 'SNAPSHOT',
        reconciliation: context.quality?.reconciliation || { status: 'NOT_EVALUATED', fields: {} },
        skill: context.skill || null,
        metricCatalog: context.metricCatalog || [],
        promptVersion: context.promptVersion || HERMES_PROMPT_VERSION,
        learning: context.learning || null,
      },
      allowedClaims: context.allowedClaims,
      blockedClaims: context.blockedClaims,
      dataGaps: context.dataGaps,
    };
  }

  async analyze(args = {}) {
    const context = await this.buildContext(args);
    if (!context.success) return context;
    if (!context.quality.canCallHermes) {
      return {
        success: false,
        provider: 'HERMES_AGENT',
        errorCode: 'DATA_BLOCKED',
        intent: context.intent,
        period: context.period,
        quality: context.quality,
        dataGaps: context.dataGaps,
        message: context.quality.reason,
        statusCode: 422,
      };
    }

    const reviewer = reviewContext(context);
    if (!reviewer.pass) {
      return {
        success: false,
        provider: 'HERMES_AGENT',
        errorCode: 'CONTEXT_REVIEW_BLOCKED',
        intent: context.intent,
        period: context.period,
        quality: context.quality,
        review: reviewer,
        dataGaps: context.dataGaps,
        message: 'Konteks belum lolos critical reviewer sebelum dikirim ke Hermes.',
        statusCode: 422,
      };
    }

    const result = await hermesAgentService.chat({
      messages: this.buildMessages(context),
      model: args.model,
      mode: 'GROUNDED_ANALYSIS',
      temperature: 0.2,
      maxTokens: 6000,
      responseFormat: { type: 'json_object' },
    });
    if (!result.success) {
      const diagnostic = {
        stage: 'HERMES_UPSTREAM',
        requestId: args.requestId || null,
        intent: context.intent,
        errorCode: result.errorCode || 'UPSTREAM_ERROR',
        provider: result.provider || 'HERMES_AGENT',
        model: result.model || null,
      };
      console.warn('[Hermes][Diagnostic]', JSON.stringify(diagnostic));
      return { ...result, intent: context.intent, period: context.period, quality: context.quality, dataGaps: context.dataGaps, requestId: args.requestId || null, diagnostic };
    }

    const content = result.response?.choices?.[0]?.message?.content;
    const validatedOutput = hermesOutputValidator.parseAndValidate(content, context);
    if (!validatedOutput.valid) {
      // Alasan penolakan (bukan data mentah) selalu di-log agar kegagalan kontrak
      // dapat didiagnosa dari server. Isi mentah model hanya di-dump bila HERMES_DEBUG=true.
      const diagnostic = {
        stage: 'OUTPUT_VALIDATION',
        requestId: args.requestId || null,
        intent: context.intent,
        period: context.period,
        errorCode: validatedOutput.errorCode || 'INVALID_CONTRACT',
        errors: (validatedOutput.errors || []).slice(0, 20),
        warnings: (validatedOutput.warnings || []).slice(0, 20),
        response: {
          contentType: typeof content,
          contentLength: String(content || '').length,
        },
      };
      console.warn('[Hermes][Diagnostic]', JSON.stringify(diagnostic));
      if (String(process.env.HERMES_DEBUG || '').toLowerCase() === 'true') {
        console.warn('[Hermes][DEBUG] Isi mentah model (dipotong 4000):', String(content).slice(0, 4000));
      }
      return {
        success: false,
        provider: 'HERMES_AGENT',
        errorCode: 'INVALID_RESPONSE',
        intent: context.intent,
        period: context.period,
        quality: context.quality,
        review: reviewer,
        validationErrors: validatedOutput.errors,
        validationWarnings: validatedOutput.warnings,
        requestId: args.requestId || null,
        diagnostic,
        message: validatedOutput.errorCode === 'INVALID_JSON'
          ? 'Hermes mengembalikan hasil yang bukan JSON valid untuk kontrak analisa.'
          : 'Hermes mengembalikan JSON, tetapi tidak memenuhi kontrak evidence analisa.',
        statusCode: 502,
      };
    }

    const analysis = addRecommendationMetadata(validatedOutput.analysis);
    const normalizedResult = { ...result, analysis };
    const memory = await hermesMemoryService.persistAnalysis({
      userId: args.user?.id,
      storeId: context.quality?.sessionStoreId,
      context,
      result: normalizedResult,
    }).catch((error) => {
      console.warn('[Hermes] Memori analisa tidak tersimpan; hasil utama tetap dikembalikan:', error.message);
      return null;
    });

    return {
      success: true,
      provider: result.provider,
      model: result.model,
      intent: context.intent,
      period: context.period,
      quality: context.quality,
      analysis,
      skill: context.skill,
      review: reviewer,
      evidence: context.evidence || [],
      effectivePeriod: context.effectivePeriod || null,
      validationWarnings: validatedOutput.warnings,
      dataGaps: context.dataGaps,
      memoryId: memory?.id || null,
      memoryPersisted: Boolean(memory),
      promptVersion: context.promptVersion || HERMES_PROMPT_VERSION,
      outputSchemaVersion: HERMES_OUTPUT_SCHEMA_VERSION,
      requestId: args.requestId || null,
    };
  }
}

const service = new HermesAnalysisService();
service.HermesAnalysisService = HermesAnalysisService;
service.INTENTS = INTENTS;
service.THRESHOLDS = THRESHOLDS;
service.normalizeIntent = normalizeIntent;
service.resolveAnalysisRange = resolveAnalysisRange;
service.aggregateAds = aggregateAds;
service.aggregateOrders = aggregateOrders;

module.exports = service;
