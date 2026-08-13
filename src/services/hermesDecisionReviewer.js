function reviewContext(context = {}) {
  const errors = [];
  const warnings = [];
  const evidence = Array.isArray(context.evidence) ? context.evidence : [];
  const trustedMetrics = context.trustedMetrics || {};
  const skill = context.skill || null;

  if (!context.quality || context.quality.status !== 'SAFE') {
    errors.push('Konteks belum berstatus SAFE.');
  }
  if (!evidence.length) errors.push('Evidence ledger kosong.');
  if (!skill) errors.push('Skill analisa belum dipilih.');
  if (context.intent === 'PERFORMA_PRODUK' && context.quality?.reconciliation?.status !== 'MATCH') {
    errors.push('Performa Produk belum memiliki rekonsiliasi core MATCH.');
  }
  for (const requiredMetric of skill?.requiredEvidence || []) {
    const metric = trustedMetrics[requiredMetric];
    const value = metric?.value ?? metric;
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
      warnings.push(`Evidence wajib ${requiredMetric} belum tersedia sebagai trusted metric.`);
    }
  }
  if (!context.effectivePeriod) warnings.push('Periode efektif sumber belum tersedia.');

  return {
    pass: errors.length === 0,
    errors,
    warnings,
    checked: {
      quality: context.quality?.status || null,
      evidenceCount: evidence.length,
      skill: skill?.id || null,
      reconciliation: context.quality?.reconciliation?.status || 'NOT_EVALUATED',
    },
  };
}

module.exports = { reviewContext };
