const hermesAnalysisService = require('./src/services/hermesAnalysisService');
const hermesCanonicalDataService = require('./src/services/hermesCanonicalDataService');
const hermesAgentService = require('./src/services/hermesAgentService');

const originalLoad = hermesCanonicalDataService.load;
const originalChat = hermesAgentService.chat;

const context = {
  success: true,
  sourceMode: 'LIVE_CANONICAL',
  quality: {
    status: 'SAFE',
    analysisMode: 'FULL',
    canCallHermes: true,
    sourceMode: 'LIVE_CANONICAL',
    reconciliation: { status: 'NOT_REQUIRED', fields: {} },
    sources: [{ name: 'shopee_ads_live', status: 'VALID', rows: 1, coverage: { coverageRatio: 1 } }],
    dataGaps: [],
  },
  trustedMetrics: {
    spend: { value: 100, unit: 'IDR' },
    sales: { value: 250, unit: 'IDR' },
    roas: { value: 2.5, unit: 'x' },
    impressions: { value: 1000, unit: 'count' },
    clicks: { value: 50, unit: 'count' },
    ctr: { value: 5, unit: '%' },
  },
  comparisons: {},
  details: { campaigns: [] },
  evidence: [
    { id: 'ads_sales', metric: 'sales', value: 250, unit: 'IDR', source: 'Shopee Ads live' },
    { id: 'ads_roas', metric: 'roas', value: 2.5, unit: 'x', source: 'Shopee Ads live' },
  ],
  effectivePeriod: { native: 'past30days' },
  allowedClaims: [],
  blockedClaims: [],
  dataGaps: [],
};

function validModelOutput() {
  return {
    schemaVersion: '1.0',
    executiveVerdict: 'ROAS terukur dari data live.',
    criticalFindings: [{
      severity: 'MEDIUM',
      title: 'ROAS terukur',
      description: 'Nilai ROAS tersedia dari sumber live.',
      evidenceIds: ['ads_roas'],
      impact: { metric: 'roas', value: 2.5, unit: 'x' },
      confidence: 'HIGH',
    }],
    rootCauseAnalysis: [{
      hypothesis: 'Belum ada hipotesis kausal yang cukup kuat.',
      supportingEvidenceIds: ['ads_roas'],
      howToTest: 'Ambil perbandingan periode lengkap sebelum menyimpulkan tren.',
      confidence: 'LOW',
    }],
    prioritizedActions: [{
      priority: 1,
      action: 'Pantau ROAS pada periode berikutnya.',
      reason: 'Membangun baseline sebelum mengubah budget.',
      evidenceIds: ['ads_roas'],
      expectedMeasurement: 'Bandingkan ROAS periode berikutnya dengan baseline.',
    }],
    dataGaps: [],
    uncertainty: [],
  };
}

async function main() {
  const service = new hermesAnalysisService.HermesAnalysisService();
  service.resolveSession = async () => ({ storeId: 'store-test', userId: 'user-test' });
  hermesCanonicalDataService.load = async () => ({ ...context });
  hermesAgentService.chat = async () => ({ success: true, provider: 'HERMES_AGENT', model: 'hermes-agent', response: { choices: [{ message: { content: JSON.stringify(validModelOutput()) } }] } });

  const valid = await service.analyze({ intent: 'IKLAN', user: { id: 'user-test', role: 'USER' } });
  hermesAgentService.chat = async () => ({ success: true, provider: 'HERMES_AGENT', model: 'hermes-agent', response: { choices: [{ message: { content: JSON.stringify({ ...validModelOutput(), criticalFindings: [{ ...validModelOutput().criticalFindings[0], evidenceIds: ['unknown'] }] }) } }] } });
  const invalid = await service.analyze({ intent: 'IKLAN', user: { id: 'user-test', role: 'USER' } });

  const checks = [
    ['valid grounded analysis passes', valid.success === true && valid.review?.pass === true],
    ['analysis returns evidence ledger', valid.evidence?.length === 2],
    ['invalid evidence output is rejected', invalid.success === false && invalid.errorCode === 'INVALID_RESPONSE'],
    ['invalid output exposes validator errors', Array.isArray(invalid.validationErrors) && invalid.validationErrors.length > 0],
  ];
  let passed = 0;
  for (const [label, condition] of checks) {
    if (condition) {
      passed += 1;
      console.log(`  PASS ${label}`);
    } else {
      console.log(`  FAIL ${label}`);
    }
  }
  console.log(`\n=== ${passed}/${checks.length} checks passed ===`);
  process.exitCode = passed === checks.length ? 0 : 1;
}

main()
  .catch((error) => {
    console.error('Suite crashed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    hermesCanonicalDataService.load = originalLoad;
    hermesAgentService.chat = originalChat;
  });
