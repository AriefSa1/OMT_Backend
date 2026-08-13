const hermesAnalysisService = require('./src/services/hermesAnalysisService');
const hermesAgentService = require('./src/services/hermesAgentService');
const { getSkill } = require('./src/services/hermesSkillRegistry');

const service = new hermesAnalysisService.HermesAnalysisService();
const originalChat = hermesAgentService.chat;
const originalBuildContext = service.buildContext;

async function main() {
  service.buildContext = async () => ({
    success: true,
    intent: 'IKLAN',
    period: { startDate: '2026-07-15', endDate: '2026-08-13', days: 30 },
    quality: { status: 'SAFE', canCallHermes: true, sessionStoreId: 'store-test' },
    skill: getSkill('IKLAN'),
    evidence: [{ id: 'ads_ctr', value: 2.5, unit: '%' }],
    trustedMetrics: { ctr: { value: 2.5, unit: '%' } },
    comparisons: {},
    details: {},
    dataGaps: [],
    blockedClaims: [],
    effectivePeriod: null,
  });
  hermesAgentService.chat = async () => ({
    success: true,
    provider: 'HERMES_AGENT',
    model: 'hermes-agent',
    response: {
      choices: [{ message: { content: JSON.stringify({
        schemaVersion: '1.0',
        executiveVerdict: 'Tidak valid.',
        criticalFindings: [],
        rootCauseAnalysis: [],
        prioritizedActions: [{
          priority: 1,
          action: 'Uji ulang',
          reason: 'Validasi diagnostic',
          evidenceIds: ['missing-evidence'],
          expectedMeasurement: 'Ukur ulang',
        }],
        dataGaps: [],
        uncertainty: [],
      }) } }],
    },
  });

  const result = await service.analyze({ requestId: 'hermes-test-request-001', user: { id: 'user-test', role: 'USER' } });
  const checks = [
    ['returns invalid response code', result.errorCode === 'INVALID_RESPONSE'],
    ['returns request id', result.requestId === 'hermes-test-request-001'],
    ['returns diagnostic stage', result.diagnostic?.stage === 'OUTPUT_VALIDATION'],
    ['returns exact validator error', result.diagnostic?.errors?.some((error) => error.includes('missing-evidence'))],
    ['returns validation errors to client', result.validationErrors?.length > 0],
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
    hermesAgentService.chat = originalChat;
    service.buildContext = originalBuildContext;
  });
