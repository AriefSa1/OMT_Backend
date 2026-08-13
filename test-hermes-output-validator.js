const { validateAnalysisOutput, parseAndValidate } = require('./src/services/hermesOutputValidator');

const context = {
  evidence: [
    { id: 'ev_sales', value: 1000000 },
    { id: 'ev_ctr', value: 2.5 },
  ],
  trustedMetrics: {
    sales: { value: 1000000 },
    ctr: { value: 2.5 },
  },
};

const validOutput = {
  schemaVersion: '1.0',
  executiveVerdict: 'Sales terukur dan evidence tersedia.',
  criticalFindings: [{
    severity: 'MEDIUM',
    title: 'CTR perlu dipantau',
    description: 'CTR berada pada level yang dapat diuji lebih lanjut.',
    evidenceIds: ['ev_ctr'],
    impact: { metric: 'ctr', value: 2.5, unit: '%' },
    confidence: 'HIGH',
  }],
  rootCauseAnalysis: [{
    hypothesis: 'Kreatif iklan mungkin belum optimal.',
    supportingEvidenceIds: ['ev_ctr'],
    howToTest: 'Uji kreatif alternatif selama tujuh hari.',
    confidence: 'LOW',
  }],
  prioritizedActions: [{
    priority: 1,
    action: 'Uji satu variasi kreatif.',
    reason: 'Mengisolasi pengaruh kreatif terhadap CTR.',
    evidenceIds: ['ev_ctr'],
    baseline: { metric: 'ctr', value: 2.5, unit: '%' },
    expectedMeasurement: 'Bandingkan CTR dan spend setelah tujuh hari.',
  }],
  dataGaps: [],
  uncertainty: [],
};

const invalidOutput = {
  ...validOutput,
  criticalFindings: [{
    ...validOutput.criticalFindings[0],
    evidenceIds: ['ev_missing'],
    impact: { metric: 'ctr', value: 99, unit: '%' },
  }],
};

// Angka turunan yang tak ada di evidence TIDAK menolak analisa — dikosongkan + warning.
const ungroundedNumberOutput = {
  ...validOutput,
  criticalFindings: [{
    ...validOutput.criticalFindings[0],
    evidenceIds: ['ev_ctr'],
    impact: { metric: 'ctr', value: 99, unit: '%' },
  }],
  prioritizedActions: [{
    ...validOutput.prioritizedActions[0],
    baseline: { metric: 'ctr', value: 42, unit: '%' },
  }],
};
const repaired = parseAndValidate(JSON.stringify(ungroundedNumberOutput), context);

const storeContext = {
  intent: 'PERFORMA_TOKO',
  evidence: [
    { id: 'store_gmv', metric: 'confirmedGmv', value: 1000000, unit: 'IDR' },
    { id: 'store_buyers', metric: 'confirmedBuyers', value: 10, unit: 'count' },
  ],
  trustedMetrics: {
    confirmedGmv: { value: 1000000, unit: 'IDR' },
    confirmedBuyers: { value: 10, unit: 'count' },
  },
};
const unsupportedStoreTracking = {
  ...validOutput,
  executiveVerdict: 'GMV dan buyer terukur dari Product Overview.',
  rootCauseAnalysis: [],
  criticalFindings: [{
    severity: 'MEDIUM',
    title: 'Funnel perlu diuji',
    description: 'Ada metrik funnel yang perlu diverifikasi pada sumber yang sesuai.',
    evidenceIds: ['store_gmv'],
    impact: { metric: 'confirmedGmv', value: 1000000, unit: 'IDR' },
    confidence: 'MEDIUM',
  }],
  prioritizedActions: [{
    priority: 1,
    action: 'Perbaiki alur toko dan ukur ulang.',
    reason: 'Menguji hipotesis funnel.',
    evidenceIds: ['store_gmv'],
    metricKey: 'bounceRate',
    windowDays: 7,
    baseline: { metric: 'bounceRate', value: 0.6906190346332152, unit: 'ratio' },
    target: { metric: 'bounceRate', value: 0.6906190346332152, unit: 'ratio' },
    expectedMeasurement: 'Ukur perubahan pada metrik funnel yang tersedia.',
  }],
};
const repairedStore = parseAndValidate(JSON.stringify(unsupportedStoreTracking), storeContext);

const checks = [
  ['valid output passes', validateAnalysisOutput(validOutput, context).valid === true],
  ['unknown evidence is rejected', validateAnalysisOutput(invalidOutput, context).valid === false],
  ['ungrounded numeric passes but is nulled', repaired.valid === true && repaired.analysis.criticalFindings[0].impact.value === null],
  ['ungrounded baseline is nulled', repaired.analysis.prioritizedActions[0].baseline.value === null],
  ['ungrounded numeric raises a warning', repaired.warnings.some((warning) => warning.includes('99') || warning.includes('42'))],
  ['grounded numeric within float tolerance is kept', parseAndValidate(JSON.stringify({ ...validOutput, criticalFindings: [{ ...validOutput.criticalFindings[0], impact: { metric: 'ctr', value: 2.5000000001, unit: '%' } }] }), context).analysis.criticalFindings[0].impact.value === 2.5000000001],
  ['unsupported store tracking does not reject valid analysis', repairedStore.valid === true],
  ['unsupported store tracking metadata is removed', repairedStore.analysis.prioritizedActions[0].metricKey === undefined && repairedStore.analysis.prioritizedActions[0].windowDays === undefined],
  ['unsupported store tracking emits a warning', repairedStore.warnings.some((warning) => warning.includes('tidak terdaftar') || warning.includes('tidak sesuai'))],
  ['JSON parser validates output contract', parseAndValidate(JSON.stringify(validOutput), context).valid === true],
  ['invalid JSON is rejected', parseAndValidate('{not-json}', context).errorCode === 'INVALID_JSON'],
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
