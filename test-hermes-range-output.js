/**
 * Read-only report for comparing Hermes trusted metrics with the Shopee dashboard.
 * It reads persisted application snapshots only; it does not run Shopee Sync and does
 * not call Hermes.
 */
require('dotenv').config();

const prisma = require('./src/utils/prisma');
const hermesAnalysisService = require('./src/services/hermesAnalysisService');

const INTENTS = ['IKLAN', 'PERFORMA_TOKO', 'PERFORMA_PRODUK'];
const RANGES = [
  { label: '30_HARI_DEFAULT', args: {} },
  { label: '7_HARI', args: { days: 7 } },
];

function compactMetric(metric) {
  if (!metric) return null;
  return {
    value: metric.value,
    unit: metric.unit,
    trusted: metric.trusted,
    source: metric.source,
    sourceField: metric.sourceField,
    reason: metric.reason,
  };
}

function compactComparison(comparison) {
  if (!comparison) return null;
  const compact = { comparable: comparison.comparable };
  for (const period of ['previous', 'current']) {
    if (comparison[period]) {
      const { startDate, endDate, ...metrics } = comparison[period];
      compact[period] = { startDate, endDate, metrics };
    }
  }
  return compact;
}

function buildReport(result, rangeLabel, session) {
  const preview = result.trustedContextPreview || {};
  const details = preview.details || {};
  const quality = result.quality || {};
  const sources = (quality.sources || []).map((source) => ({
    name: source.name,
    status: source.status,
    rows: source.rows,
    dataAsOf: source.dataAsOf,
    coverage: source.coverage,
    invalidRows: source.invalidRows,
    message: source.message,
  }));
  const comparisons = Object.fromEntries(
    Object.entries(preview.comparisons || {}).map(([key, value]) => [key, compactComparison(value)]),
  );

  const report = {
    rangeLabel,
    intent: result.intent,
    store: { storeId: session.storeId, storeName: session.storeName },
    period: result.period,
    quality: {
      status: quality.status,
      analysisMode: quality.analysisMode,
      canCallHermes: result.canCallHermes,
      reason: quality.reason,
      thresholds: quality.thresholds,
    },
    sources,
    trustedMetrics: Object.fromEntries(
      Object.entries(preview.trustedMetrics || {}).map(([key, metric]) => [key, compactMetric(metric)]),
    ),
    comparisons,
    details: {
      measuredOrderRows: details.measuredOrderRows ?? null,
      measuredAdsRows: details.measuredAdsRows ?? null,
      measuredProducts: details.measuredProducts ?? null,
      catalogCount: details.catalogCount ?? null,
      campaignCountMeasured: details.campaignCountMeasured ?? null,
      topProducts: Array.isArray(details.products) ? details.products.slice(0, 10).map((product) => ({
        itemId: product.itemId,
        name: product.name,
        snapshots: product.snapshots,
        confirmedSales: product.confirmedSales,
        confirmedOrders: product.confirmedOrders,
        confirmedUnits: product.confirmedUnits,
        impressions: product.impressions,
        clicks: product.clicks,
        ctr: product.ctr,
        conversionRate: product.conversionRate,
      })) : null,
    },
    dataGaps: result.dataGaps || [],
  };

  if (result.success === false) {
    report.error = {
      errorCode: result.errorCode,
      message: result.message || result.error,
    };
  }
  return report;
}

async function main() {
  const session = await prisma.storeSession.findFirst({
    where: { isActive: true, userId: { not: null } },
    select: { storeId: true, storeName: true, userId: true },
    orderBy: { updatedAt: 'desc' },
  });

  if (!session) {
    console.error('Tidak ada session toko aktif dengan userId. Tidak ada data yang diuji.');
    process.exitCode = 1;
    return;
  }

  const user = { id: session.userId, role: 'USER' };
  const report = {
    generatedAt: new Date().toISOString(),
    note: 'Read-only dari snapshot aplikasi. Tidak ada Shopee Sync dan tidak ada request ke Hermes.',
        comparisonHint: '7_HARI = hari ini + 6 hari sebelumnya. 30_HARI_DEFAULT = hari ini + 29 hari sebelumnya.',
    runs: [],
  };

  for (const range of RANGES) {
    for (const intent of INTENTS) {
      const result = await hermesAnalysisService.validate({
        intent,
        user,
        storeId: session.storeId,
        ...range.args,
      });
      report.runs.push(buildReport(result, range.label, session));
    }
  }

  if (process.argv.includes('--summary')) {
    const summary = {
      generatedAt: report.generatedAt,
      note: report.note,
      comparisonHint: report.comparisonHint,
      runs: report.runs.map((run) => ({
        rangeLabel: run.rangeLabel,
        intent: run.intent,
        store: run.store,
        period: run.period,
        quality: run.quality,
        sources: run.sources.map((source) => ({
          name: source.name,
          rows: source.rows,
          measuredDays: source.coverage?.measuredDays ?? null,
          coverageRatio: source.coverage?.coverageRatio ?? null,
          dates: source.coverage?.dates ?? [],
        })),
        trustedMetrics: Object.fromEntries(Object.entries(run.trustedMetrics).map(([key, metric]) => [key, metric?.value ?? null])),
        details: {
          measuredOrderRows: run.details.measuredOrderRows,
          measuredAdsRows: run.details.measuredAdsRows,
          catalogCount: run.details.catalogCount,
          campaignCountMeasured: run.details.campaignCountMeasured,
          topProducts: run.details.topProducts?.slice(0, 5) || null,
        },
        dataGaps: run.dataGaps,
        error: run.error || null,
      })),
    };
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

main()
  .catch((error) => {
    console.error('Range report gagal:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
