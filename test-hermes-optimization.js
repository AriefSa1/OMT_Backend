const hermesMetricRegistry = require('./src/services/hermesMetricRegistry');
const hermesMemoryService = require('./src/services/hermesMemoryService');
const { validateAnalysisOutput } = require('./src/services/hermesOutputValidator');

const checks = [];
function check(label, condition) {
  checks.push({ label, condition: Boolean(condition) });
  console.log(`  ${condition ? 'PASS' : 'FAIL'} ${label}`);
}

check('ads ROAS metric is registered', hermesMetricRegistry.getMetricDefinition('IKLAN', 'roas')?.unit === 'x');
check('store sales alias resolves to confirmed GMV', hermesMetricRegistry.normalizeMetricKey('PERFORMA_TOKO', 'sales') === 'confirmedGmv');
check('unknown metric is rejected for an intent', hermesMetricRegistry.validateTrackingConfig({ intent: 'IKLAN', metricKey: 'profit', baselineValue: 1 }).valid === false);
check('wrong unit is rejected', hermesMetricRegistry.validateTrackingConfig({ intent: 'IKLAN', metricKey: 'roas', baselineValue: 1, unit: '%' }).valid === false);
const currentSevenDayRange = hermesMemoryService.postActionRange(new Date(Date.now() - (7 * 86400000)), 7);
check('native period is explicitly labeled only for the current rolling window', hermesMemoryService.assessPeriodStatus({ effectivePeriod: { native: 'past7days', measured: {} } }, currentSevenDayRange, 7) === 'NATIVE_PERIOD');
check('stale native period is not treated as an exact outcome window', hermesMemoryService.assessPeriodStatus({ effectivePeriod: { native: 'past7days', measured: {} } }, { startDate: '2026-08-01', endDate: '2026-08-07' }, 7) === 'PERIOD_MISMATCH');
check('mismatched measured period is not evaluated', hermesMemoryService.assessPeriodStatus({ effectivePeriod: { native: 'past7days', measured: { startDate: '2026-07-01', endDate: '2026-07-07' } } }, { startDate: '2026-08-01', endDate: '2026-08-07' }, 7) === 'PERIOD_MISMATCH');

const output = {
  schemaVersion: '1.0',
  executiveVerdict: 'CTR terukur.',
  criticalFindings: [],
  rootCauseAnalysis: [],
  prioritizedActions: [{
    priority: 1,
    action: 'Uji kreatif',
    reason: 'Mengisolasi perubahan CTR.',
    evidenceIds: ['ads_ctr'],
    metricKey: 'ctr',
    windowDays: 7,
    baseline: { metric: 'ctr', value: 2.5, unit: '%' },
    target: { metric: 'ctr', value: 3, unit: '%' },
    expectedMeasurement: 'Ukur CTR setelah 7 hari.',
  }],
  dataGaps: [],
  uncertainty: [],
};
const validation = validateAnalysisOutput(output, { intent: 'IKLAN', evidence: [{ id: 'ads_ctr', value: 2.5 }, { id: 'ads_ctr_target', value: 3 }], trustedMetrics: { ctr: { value: 2.5 } } });
check('valid tracking config passes output validation', validation.valid);
check('recommendation ID is deterministic on server normalization', hermesMemoryService.normalizeAction(output.prioritizedActions[0], 0, 'IKLAN').recommendationId === 'rec-1');

const passed = checks.filter((item) => item.condition).length;
console.log(`\n=== ${passed}/${checks.length} checks passed ===`);
if (passed !== checks.length) process.exitCode = 1;
