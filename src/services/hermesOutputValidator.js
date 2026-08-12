const VALID_SEVERITIES = new Set(['HIGH', 'MEDIUM', 'LOW']);
const VALID_CONFIDENCE = new Set(['HIGH', 'MEDIUM', 'LOW']);
const { validateTrackingConfig, normalizeMetricKey } = require('./hermesMetricRegistry');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function evidenceValueSet(context = {}) {
  const values = new Set();
  for (const item of context.evidence || []) {
    const value = finiteNumber(item?.value);
    if (value !== null) values.add(value);
  }
  for (const metric of Object.values(context.trustedMetrics || {})) {
    const value = finiteNumber(metric?.value ?? metric);
    if (value !== null) values.add(value);
  }
  return values;
}

function validateEvidenceIds(ids, evidenceMap, path, errors, required = true) {
  if (ids === undefined && !required) return;
  if (!Array.isArray(ids) || (required && ids.length === 0)) {
    errors.push(`${path} harus berupa array evidence ID${required ? ' yang tidak kosong' : ''}.`);
    return;
  }
  for (const id of ids) {
    if (typeof id !== 'string' || !evidenceMap.has(id)) {
      errors.push(`${path} berisi evidence ID yang tidak dikenal: ${String(id)}.`);
    }
  }
}

function validateNumericValue(value, path, allowedValues, errors) {
  if (value === null || value === undefined) return;
  const parsed = finiteNumber(value);
  if (parsed === null) {
    errors.push(`${path} harus berupa angka atau null.`);
    return;
  }
  if (!allowedValues.has(parsed)) {
    errors.push(`${path}=${parsed} tidak ditemukan pada trusted metrics atau evidence.`);
  }
}

function validateAnalysisOutput(output, context = {}) {
  const errors = [];
  const warnings = [];
  const evidenceMap = new Map((context.evidence || []).map((item) => [item.id, item]));
  const allowedValues = evidenceValueSet(context);

  if (!isPlainObject(output)) {
    return { valid: false, errors: ['Output Hermes harus berupa object JSON.'], warnings };
  }
  if (!nonEmptyString(output.executiveVerdict)) errors.push('executiveVerdict wajib berupa string yang tidak kosong.');
  if (output.schemaVersion !== undefined && output.schemaVersion !== '1.0') errors.push('schemaVersion harus 1.0.');

  if (!Array.isArray(output.criticalFindings)) {
    errors.push('criticalFindings wajib berupa array.');
  } else if (output.criticalFindings.length > 10) {
    errors.push('criticalFindings tidak boleh lebih dari 10 item.');
  } else {
    output.criticalFindings.forEach((finding, index) => {
      const path = `criticalFindings[${index}]`;
      if (!isPlainObject(finding)) {
        errors.push(`${path} harus berupa object.`);
        return;
      }
      if (!VALID_SEVERITIES.has(finding.severity)) errors.push(`${path}.severity tidak valid.`);
      if (!nonEmptyString(finding.title)) errors.push(`${path}.title wajib diisi.`);
      if (!nonEmptyString(finding.description)) errors.push(`${path}.description wajib diisi.`);
      if (!VALID_CONFIDENCE.has(finding.confidence)) errors.push(`${path}.confidence tidak valid.`);
      validateEvidenceIds(finding.evidenceIds, evidenceMap, `${path}.evidenceIds`, errors);
      if (finding.impact !== undefined) {
        if (!isPlainObject(finding.impact)) errors.push(`${path}.impact harus berupa object.`);
        else validateNumericValue(finding.impact.value, `${path}.impact.value`, allowedValues, errors);
      }
    });
  }

  if (!Array.isArray(output.rootCauseAnalysis)) {
    errors.push('rootCauseAnalysis wajib berupa array.');
  } else if (output.rootCauseAnalysis.length > 10) {
    errors.push('rootCauseAnalysis tidak boleh lebih dari 10 item.');
  } else {
    output.rootCauseAnalysis.forEach((cause, index) => {
      const path = `rootCauseAnalysis[${index}]`;
      if (!isPlainObject(cause)) {
        errors.push(`${path} harus berupa object.`);
        return;
      }
      if (!nonEmptyString(cause.hypothesis)) errors.push(`${path}.hypothesis wajib diisi.`);
      if (!VALID_CONFIDENCE.has(cause.confidence)) errors.push(`${path}.confidence tidak valid.`);
      validateEvidenceIds(cause.supportingEvidenceIds, evidenceMap, `${path}.supportingEvidenceIds`, errors);
      if (!nonEmptyString(cause.howToTest)) warnings.push(`${path}.howToTest belum diberikan.`);
    });
  }

  if (!Array.isArray(output.prioritizedActions)) {
    errors.push('prioritizedActions wajib berupa array.');
  } else if (output.prioritizedActions.length > 10) {
    errors.push('prioritizedActions tidak boleh lebih dari 10 item.');
  } else {
    output.prioritizedActions.forEach((action, index) => {
      const path = `prioritizedActions[${index}]`;
      if (!isPlainObject(action)) {
        errors.push(`${path} harus berupa object.`);
        return;
      }
      const priority = finiteNumber(action.priority);
      if (priority === null || priority < 1 || priority > 10 || !Number.isInteger(priority)) errors.push(`${path}.priority harus integer 1-10.`);
      if (!nonEmptyString(action.action)) errors.push(`${path}.action wajib diisi.`);
      if (!nonEmptyString(action.reason)) errors.push(`${path}.reason wajib diisi.`);
      if (!nonEmptyString(action.expectedMeasurement)) errors.push(`${path}.expectedMeasurement wajib diisi.`);
      if (action.metricKey !== undefined && !nonEmptyString(action.metricKey)) errors.push(`${path}.metricKey harus berupa string yang tidak kosong.`);
      if (action.windowDays !== undefined) {
        const windowDays = finiteNumber(action.windowDays);
        if (!Number.isInteger(windowDays) || ![7, 30].includes(windowDays)) errors.push(`${path}.windowDays harus 7 atau 30.`);
      }
      validateEvidenceIds(action.evidenceIds, evidenceMap, `${path}.evidenceIds`, errors);
      for (const field of ['baseline', 'target']) {
        if (action[field] !== undefined) {
          if (!isPlainObject(action[field])) errors.push(`${path}.${field} harus berupa object.`);
          else validateNumericValue(action[field].value, `${path}.${field}.value`, allowedValues, errors);
        }
      }
      const baselineMetric = action.baseline?.metric ? normalizeMetricKey(context.intent, action.baseline.metric) : null;
      const targetMetric = action.target?.metric ? normalizeMetricKey(context.intent, action.target.metric) : null;
      const metricKey = action.metricKey ? normalizeMetricKey(context.intent, action.metricKey) : (baselineMetric || targetMetric);
      const tracking = validateTrackingConfig({
        intent: context.intent,
        metricKey,
        baselineValue: action.baseline?.value === undefined ? null : finiteNumber(action.baseline.value),
        targetValue: action.target?.value === undefined ? null : finiteNumber(action.target.value),
        unit: action.target?.unit || action.baseline?.unit,
        windowDays: action.windowDays,
      });
      tracking.errors.forEach((error) => errors.push(`${path}: ${error}`));
      tracking.warnings.forEach((warning) => warnings.push(`${path}: ${warning}`));
      if (baselineMetric && targetMetric && baselineMetric !== targetMetric) errors.push(`${path}.baseline.metric dan target.metric harus sama.`);
      if (action.metricKey && baselineMetric && normalizeMetricKey(context.intent, action.metricKey) !== baselineMetric) errors.push(`${path}.metricKey harus sama dengan baseline.metric.`);
      if (action.metricKey && targetMetric && normalizeMetricKey(context.intent, action.metricKey) !== targetMetric) errors.push(`${path}.metricKey harus sama dengan target.metric.`);
      if (action.metricKey && (!action.baseline || finiteNumber(action.baseline.value) === null)) {
        warnings.push(`${path} belum memiliki baseline numerik; outcome tracking akan berstatus INSUFFICIENT_DATA.`);
      }
    });
  }

  if (!Array.isArray(output.dataGaps) || output.dataGaps.some((gap) => !nonEmptyString(gap))) {
    errors.push('dataGaps wajib berupa array string.');
  }
  if (output.uncertainty !== undefined && (!Array.isArray(output.uncertainty) || output.uncertainty.some((item) => !nonEmptyString(item)))) {
    errors.push('uncertainty harus berupa array string.');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    schemaVersion: '1.0',
  };
}

function parseAndValidate(content, context = {}) {
  let parsed;
  try {
    const cleaned = String(content || '').replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return { valid: false, errorCode: 'INVALID_JSON', errors: ['Hermes mengembalikan JSON yang tidak valid.'], warnings: [] };
  }
  return { ...validateAnalysisOutput(parsed, context), analysis: parsed };
}

module.exports = {
  validateAnalysisOutput,
  parseAndValidate,
};
