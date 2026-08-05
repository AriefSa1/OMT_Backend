/**
 * Regression suite for src/services/aiService.js — the retry/classification logic, the
 * envelope contract (notConfigured / missingInput / aiFailed / aiResult), and that
 * deterministic figures (metrics, calculations) survive a model failure.
 *
 * Deliberately makes ZERO live calls to Gemini. `aiService.ai.models.generateContent`
 * is replaced with a script of scripted responses/errors, the same way a unit test
 * would mock any other network dependency. The previous version of this file called
 * all 5 live Gemini endpoints on every run — a needless real request each time, on a
 * free tier whose whole daily quota is 20. Do not add a live call back into this file;
 * that turns "run the tests" into "spend the day's AI quota". If you need to confirm the
 * live API itself still answers, run a single manual call — see docs/AI_SERVICE.md.
 *
 *   node test-ai-suite.js   (or: npm run test:ai)
 */
const aiService = require('./src/services/aiService');

let passed = 0;
let total = 0;

function check(label, condition) {
  total += 1;
  if (condition) {
    passed += 1;
    console.log(`  PASS ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
  }
}

function fakeApiError(status, body) {
  const err = new Error(JSON.stringify(body));
  err.status = status;
  err.name = 'ApiError';
  return err;
}

function mockGemini(script) {
  // `script` is an array of either a JSON-serialisable response or an Error to throw,
  // consumed one per call. The last entry repeats once exhausted.
  let index = 0;
  aiService.ai = {
    models: {
      generateContent: async () => {
        const entry = script[Math.min(index, script.length - 1)];
        index += 1;
        if (entry instanceof Error) throw entry;
        return { text: JSON.stringify(entry) };
      },
    },
  };
  return () => index;
}

async function main() {
  console.log('=== AI service — mocked regression suite (no live Gemini calls) ===\n');

  console.log('1. Transient 429 twice, then a real response — must retry and succeed');
  const calls1 = mockGemini([
    fakeApiError(429, { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.01s' }] } }),
    fakeApiError(429, { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.01s' }] } }),
    { campaignName: 'X', summary: 'ok', negativeKeywordsToExclude: [], bidAdjustments: [], scaleKeywordsRecommended: [] },
  ]);
  const r1 = await aiService.optimizeAdsKeywordsAndBids({ campaignName: 'X', spend: 1, sales: 1, roas: 1, ctr: 1 });
  check('succeeds after transient retries', r1.success === true && r1.provider === 'REAL_GEMINI_API');
  check('made exactly 3 attempts (1 + 2 retries)', calls1() === 3);

  console.log('\n2. 429 on every attempt — must exhaust retries and report RATE_LIMITED, not a generic error');
  const calls2 = mockGemini([fakeApiError(429, { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.01s' }] } })]);
  const r2 = await aiService.optimizeAdsKeywordsAndBids({ campaignName: 'X', spend: 1, sales: 1, roas: 1, ctr: 1 });
  check('reports RATE_LIMITED once retries are exhausted', r2.success === false && r2.errorCode === 'RATE_LIMITED');
  check('fallbackPayload (empty arrays) still present on failure', Array.isArray(r2.negativeKeywordsToExclude));
  check('stopped after 1 + maxRetries(2) = 3 attempts, not more', calls2() === 3);

  console.log('\n3. A non-retryable 400 — must fail on the first attempt, no retry wasted');
  const calls3 = mockGemini([fakeApiError(400, { error: { message: 'bad request' } })]);
  const r3 = await aiService.optimizeAdsKeywordsAndBids({ campaignName: 'X', spend: 1, sales: 1, roas: 1, ctr: 1 });
  check('classified as HTTP_400', r3.success === false && r3.errorCode === 'HTTP_400');
  check('made exactly 1 attempt (no retry for a non-transient error)', calls3() === 1);

  console.log("\n4. predictRestockAndLiquidation — metrics are this service's own arithmetic and must survive a failure");
  mockGemini([fakeApiError(400, {})]);
  const r4 = await aiService.predictRestockAndLiquidation({ name: 'P', sku: 'S1', stock: 10, salesCount: 5, warehouseStock: 20, leadTimeDays: 7 });
  check('reports failure', r4.success === false);
  check('metrics.currentStock is the real 10+20=30, not dropped', r4.metrics?.currentStock === 30);
  check('liquidationPlaybook falls back to null, not invented prose', r4.liquidationPlaybook === null);

  console.log('\n5. predictRestockAndLiquidation — refuses to guess when warehouseStock is not mapped to this SKU');
  const r5 = await aiService.predictRestockAndLiquidation({ name: 'P', sku: 'S2', stock: 10, salesCount: 5, warehouseStock: null });
  check('MISSING_INPUT before any Gemini call', r5.success === false && r5.provider === 'MISSING_INPUT');

  console.log('\n6. simulateDynamicPricing — refuses to guess a platform fee percentage');
  const r6 = await aiService.simulateDynamicPricing({ name: 'P', currentPrice: 1000, platformFeePercent: null });
  check('MISSING_INPUT before any Gemini call', r6.success === false && r6.provider === 'MISSING_INPUT');

  console.log('\n7. Every FITUR method reports NOT_CONFIGURED (not a crash) when no key is set');
  aiService.setApiKey('');
  const r7a = await aiService.generateABTestCopy({ name: 'P' });
  const r7b = await aiService.generateDailyBriefing({});
  check('generateABTestCopy -> NOT_CONFIGURED', r7a.provider === 'NOT_CONFIGURED');
  check('generateDailyBriefing -> NOT_CONFIGURED', r7b.provider === 'NOT_CONFIGURED');

  console.log(`\n=== ${passed}/${total} checks passed ===`);
  process.exitCode = passed === total ? 0 : 1;
}

main().catch((err) => {
  console.error('Suite crashed:', err);
  process.exitCode = 1;
});
