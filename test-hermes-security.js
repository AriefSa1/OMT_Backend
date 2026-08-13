const { sanitizeForHermes } = require('./src/services/hermesPayloadSanitizer');

const payload = sanitizeForHermes({
  trustedMetrics: { sales: 1000 },
  learning: { comment: 'Ulasan pengguna yang panjang.' },
  cookieString: 'session-secret',
  apiKey: 'top-secret',
  nested: { authorization: 'Bearer secret' },
});

const checks = [
  ['credential keys are redacted', payload.cookieString === '[REDACTED]' && payload.apiKey === '[REDACTED]'],
  ['nested credential keys are redacted', payload.nested.authorization === '[REDACTED]'],
  ['trusted metrics remain available', payload.trustedMetrics.sales === 1000],
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
