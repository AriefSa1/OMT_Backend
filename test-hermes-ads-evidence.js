/*
 * Regression test: ads campaigns expose only scaled amounts to Hermes, and each
 * campaign number is added to the evidence ledger so it can be cited/validated.
 * Fully mocked — no DB, no Shopee.
 */
const hermesCanonicalDataService = require('./src/services/hermesCanonicalDataService');
const shopeeService = require('./src/services/shopeeService');
const { validateAnalysisOutput } = require('./src/services/hermesOutputValidator');

const checks = [];
function check(label, condition) {
  checks.push(Boolean(condition));
  console.log(`  ${condition ? 'PASS' : 'FAIL'} ${label}`);
}

const originalFetch = shopeeService.fetchShopeeAdsMetrics;
shopeeService.fetchShopeeAdsMetrics = async () => ({
  success: true, dataSource: 'SHOPEE_API',
  totalSpend: 4595426.87, totalSalesGenerated: 25306952, roas: 5.51,
  impressions: 567989, clicks: 23538, ctr: 4.14, orders: 159, itemSold: 298,
  period: { startTime: 1, endTime: 2 },
  topCampaigns: [
    // Carries BOTH scaled (spend) and raw (rawSpend) — raw must never reach Hermes.
    { id: '482025455', name: 'FS41', type: 'x', state: 'ongoing', dailyBudget: 0, spend: 2174976.47, rawSpend: 217497647000, sales: 15418317, rawSales: 1, voucherSpend: 0, voucherSales: 0, impressions: 307000, clicks: 12980, orders: 93, itemSold: 100, roas: 7.09, ctr: 4.23, amountDivisor: 100000 },
    { id: '487242862', name: 'Vella', type: 'x', state: 'ongoing', dailyBudget: 0, spend: 97425.82, rawSpend: 9742582000, sales: 0, rawSales: 0, voucherSpend: 0, voucherSales: 0, impressions: 5660, clicks: 287, orders: 0, itemSold: 0, roas: 0, ctr: 5.07, amountDivisor: 100000 },
  ],
});

async function main() {
  const context = await hermesCanonicalDataService.load({
    intent: 'IKLAN',
    range: { startDate: '2026-07-15', endDate: '2026-08-13', days: 30 },
    storeId: 's1',
  });

  const campaign = context.details.campaigns[0];
  check('raw scaling fields are not exposed to Hermes', !('rawSpend' in campaign) && !('rawSales' in campaign) && !('amountDivisor' in campaign));
  check('scaled campaign spend is preserved', context.details.campaigns.find((c) => c.id === '487242862').spend === 97425.82);

  const campEvidence = context.evidence.filter((e) => e.id.startsWith('ads_campaign_'));
  check('per-campaign evidence rows are emitted', campEvidence.length > 0);
  const vellaSpend = context.evidence.find((e) => e.id === 'ads_campaign_487242862_spend');
  check('campaign evidence carries the scaled value', vellaSpend && vellaSpend.value === 97425.82);
  check('evidence ledger stays under the 100-row sanitizer cap', context.evidence.length <= 100);

  // A model citing the campaign figure now validates instead of being rejected/nulled.
  const output = {
    schemaVersion: '1.0', executiveVerdict: 'Vella boros: spend tanpa sales.',
    criticalFindings: [{ severity: 'HIGH', title: 'Vella boros', description: 'Spend tanpa sales.', evidenceIds: ['ads_campaign_487242862_spend'], impact: { metric: 'spend', value: 97425.82, unit: 'IDR' }, confidence: 'HIGH' }],
    rootCauseAnalysis: [],
    prioritizedActions: [{ priority: 1, action: 'Pause Vella.', reason: 'Boros.', evidenceIds: ['ads_campaign_487242862_spend'], baseline: { metric: 'spend', value: 97425.82, unit: 'IDR' }, expectedMeasurement: 'Spend turun ke 0.' }],
    dataGaps: [], uncertainty: [],
  };
  const validated = validateAnalysisOutput(output, context);
  check('citing a campaign figure now validates', validated.valid === true);
  check('cited campaign baseline is kept (not nulled)', output.prioritizedActions[0].baseline.value === 97425.82);

  const passed = checks.filter(Boolean).length;
  console.log(`\n=== ${passed}/${checks.length} checks passed ===`);
  shopeeService.fetchShopeeAdsMetrics = originalFetch;
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
