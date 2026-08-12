/*
 * Unit test for the calendar-day evaluation window of the Hermes learning loop.
 * Mocks Prisma + the canonical data service so it runs offline (no DB, no Shopee).
 */
require('dotenv').config();

const prisma = require('./src/utils/prisma');
const hermesCanonicalDataService = require('./src/services/hermesCanonicalDataService');
const hermesMemoryService = require('./src/services/hermesMemoryService');

const checks = [];
function check(label, condition) {
  checks.push({ label, condition: Boolean(condition) });
  console.log(`  ${condition ? 'PASS' : 'FAIL'} ${label}`);
}

// Asia/Jakarta date key, mirroring the service implementation.
function dateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const v = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${v.year}-${v.month}-${v.day}`;
}
function shiftDateKey(value, days) {
  const [y, m, d] = String(value).split('-').map(Number);
  const r = new Date(Date.UTC(y, m - 1, d));
  r.setUTCDate(r.getUTCDate() + days);
  return r.toISOString().slice(0, 10);
}

// ---- Mocks ------------------------------------------------------------------
let evaluationRow = null;
prisma.hermesRecommendationEvaluation.findUnique = async () => evaluationRow;
prisma.hermesRecommendationEvaluation.upsert = async ({ create, update }) => {
  // Emulate upsert: row didn't exist -> apply create, else merge update.
  evaluationRow = evaluationRow ? { ...evaluationRow, ...update } : { id: 'eval-1', ...create };
  return evaluationRow;
};

function actionCompletedDaysAgo(days, overrides = {}) {
  const completedAt = new Date(Date.now() - days * 86400000);
  return {
    id: 'act-1', userId: 'user-1', completedAt,
    metricKey: 'confirmedSales', baselineValue: 100, targetValue: 120, unit: 'IDR',
    analysis: { intent: 'PERFORMA_PRODUK', storeId: 'store-1' },
    ...overrides,
  };
}
function mockAction(action) {
  prisma.hermesRecommendationAction.findFirst = async () => action;
}

async function main() {
  const window = 7;

  // Case 1: completed 5 days ago -> not yet eligible (needs 7) -> NOT_READY.
  evaluationRow = null;
  mockAction(actionCompletedDaysAgo(window - 2));
  const early = await hermesMemoryService.evaluateAction({ userId: 'user-1', actionId: 'act-1', windowDays: window });
  const expectedEligibleKey = shiftDateKey(dateKey(new Date(Date.now() - (window - 2) * 86400000)), window);
  check('not-yet-due action stays NOT_READY', early.evaluation?.status === 'NOT_READY');
  check('NOT_READY note names the auto-eval date', String(early.evaluation?.notes || '').includes(expectedEligibleKey));

  // Case 2: completed exactly `window` days ago -> aligned day -> EVALUATED.
  evaluationRow = null;
  const action = actionCompletedDaysAgo(window);
  mockAction(action);
  const requestedStart = dateKey(new Date(action.completedAt.getTime() + 86400000));
  const requestedEnd = dateKey(new Date(action.completedAt.getTime() + window * 86400000));
  hermesCanonicalDataService.load = async () => ({
    success: true,
    quality: { status: 'SAFE' },
    trustedMetrics: { confirmedSales: 150 },
    evidence: [],
    effectivePeriod: { measured: { startDate: requestedStart, endDate: requestedEnd } },
  });
  const due = await hermesMemoryService.evaluateAction({ userId: 'user-1', actionId: 'act-1', windowDays: window });
  check('aligned-day action is EVALUATED', due.evaluation?.status === 'EVALUATED');
  check('actual value comes from canonical source', due.evaluation?.actualValue === 150);
  check('verdict reflects target met (150 >= 120)', due.evaluation?.verdict === 'TARGET_MET');

  const passed = checks.filter((c) => c.condition).length;
  console.log(`\n=== ${passed}/${checks.length} checks passed ===`);
  if (passed !== checks.length) process.exitCode = 1;
  process.exit(process.exitCode || 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
