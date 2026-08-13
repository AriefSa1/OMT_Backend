const hermesMemoryService = require('./src/services/hermesMemoryService');

const checks = [];
function check(label, condition) {
  checks.push({ label, condition: Boolean(condition) });
  console.log(`  ${condition ? 'PASS' : 'FAIL'} ${label}`);
}

check('target met when an increasing metric reaches target', hermesMemoryService.compareOutcome(10, 15, 15) === 'TARGET_MET');
check('decline is distinguished from below-target improvement', hermesMemoryService.compareOutcome(10, 15, 8) === 'NOT_IMPROVED');
check('decreasing target can be evaluated', hermesMemoryService.compareOutcome(10, 8, 8) === 'TARGET_MET');
const normalized = hermesMemoryService.normalizeAction({
  action: 'Uji perubahan listing',
  metricKey: 'confirmedSales',
  windowDays: 7,
  baseline: { value: 100, unit: 'IDR' },
  target: { value: 120, unit: 'IDR' },
}, 0);
check('action tracking keeps explicit metric and baseline', normalized.metricKey === 'confirmedSales' && normalized.baselineValue === 100 && normalized.windowDays === 7);
const unmeasured = hermesMemoryService.normalizeAction({ action: 'Perbaiki foto produk' }, 1);
check('qualitative action remains unmeasured instead of fabricated', unmeasured.metricKey === null && unmeasured.baselineValue === null && unmeasured.windowDays === null);
check('planned-action deletion endpoint is implemented', typeof hermesMemoryService.deleteAction === 'function');

const passed = checks.filter((item) => item.condition).length;
console.log(`\n=== ${passed}/${checks.length} checks passed ===`);
if (passed !== checks.length) process.exitCode = 1;
