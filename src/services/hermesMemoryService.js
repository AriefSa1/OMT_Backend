const prisma = require('../utils/prisma');
const hermesCanonicalDataService = require('./hermesCanonicalDataService');
const { normalizeMetricKey, validateTrackingConfig } = require('./hermesMetricRegistry');

const FEEDBACK_RATINGS = new Set(['HELPFUL', 'PARTIALLY_HELPFUL', 'NOT_HELPFUL', 'INACCURATE']);
const FEEDBACK_REASONS = new Set([
  'DATA_MISMATCH',
  'ANALYSIS_TOO_GENERAL',
  'RECOMMENDATION_NOT_EXECUTABLE',
  'OUTCOME_NOT_IMPROVED',
  'NUMBERS_CORRECT_INTERPRETATION_WRONG',
  'INSUFFICIENT_DATA',
  'ACTION_WORKED',
]);
const ACTION_STATUSES = new Set(['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED', 'CANCELLED']);
const EVALUATION_WINDOWS = new Set([7, 30]);

// Memori tersedia jika Prisma Client memang memiliki model Hermes (sudah di-generate
// dari schema ini). Ini capability check yang akurat — bukan menebak dari string
// DATABASE_URL — sehingga tetap benar untuk koneksi Postgres langsung maupun Accelerate
// (prisma://), dan menonaktifkan learning loop secara bersih bila migrasi belum dijalankan.
function isMemoryStoreAvailable() {
  return Boolean(prisma && prisma.hermesAnalysisMemory);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function json(value, fallback = {}) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function dateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDateKey(value, days) {
  const [year, month, day] = String(value).split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1, day));
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

function rangeForDays(days) {
  const normalized = Number(days);
  const endDate = dateKey();
  return {
    startDate: shiftDateKey(endDate, -(normalized - 1)),
    endDate,
    days: normalized,
  };
}

function postActionRange(completedAt, days) {
  const completed = new Date(completedAt);
  const start = new Date(completed.getTime() + 86400000);
  const end = new Date(completed.getTime() + (Number(days) * 86400000));
  return { startDate: dateKey(start), endDate: dateKey(end), days: Number(days) };
}

function assessPeriodStatus(canonical, requestedRange, windowDays) {
  const measured = canonical?.effectivePeriod?.measured || {};
  if (measured.startDate && measured.endDate) {
    return measured.startDate === requestedRange.startDate && measured.endDate === requestedRange.endDate
      ? 'EXACT'
      : 'PERIOD_MISMATCH';
  }
  const expectedNative = Number(windowDays) === 7 ? 'past7days' : 'past30days';
  const endDate = dateKey();
  const currentNativeStart = shiftDateKey(endDate, -(Number(windowDays) - 1));
  const nativeMatchesRequestedRange = requestedRange?.startDate === currentNativeStart
    && requestedRange?.endDate === endDate;
  return canonical?.effectivePeriod?.native === expectedNative && nativeMatchesRequestedRange
    ? 'NATIVE_PERIOD'
    : 'PERIOD_MISMATCH';
}

function isoDate(value) {
  return value instanceof Date ? value.toISOString() : value || null;
}

function metricFromContext(context, metricKey) {
  const value = context?.trustedMetrics?.[metricKey];
  if (value && typeof value === 'object' && 'value' in value) return finiteNumber(value.value);
  return finiteNumber(value);
}

function metricFromCanonical(canonical, metricKey) {
  const direct = finiteNumber(canonical?.trustedMetrics?.[metricKey]);
  if (direct !== null) return direct;
  const aliases = {
    confirmedGmv: ['confirmedSales'],
    confirmedSales: ['confirmedGmv'],
    confirmedUnits: ['totalUnits'],
    totalUnits: ['confirmedUnits'],
    sales: ['confirmedSales'],
    gmv: ['confirmedGmv'],
  };
  for (const alias of aliases[metricKey] || []) {
    const candidate = finiteNumber(canonical?.trustedMetrics?.[alias]);
    if (candidate !== null) return candidate;
  }
  return null;
}

function normalizeAction(action, index, intent) {
  const baseline = action?.baseline && typeof action.baseline === 'object' ? action.baseline : {};
  const target = action?.target && typeof action.target === 'object' ? action.target : {};
  const rawMetricKey = String(action?.metricKey || baseline.metric || target.metric || '').trim() || null;
  const metricKey = normalizeMetricKey(intent, rawMetricKey);
  const windowDays = EVALUATION_WINDOWS.has(Number(action?.windowDays)) ? Number(action.windowDays) : null;
  const tracking = validateTrackingConfig({
    intent,
    metricKey,
    baselineValue: finiteNumber(baseline.value),
    targetValue: finiteNumber(target.value),
    unit: target.unit || baseline.unit,
    windowDays,
  });
  return {
    recommendationIndex: index,
    recommendationId: String(action?.recommendationId || `rec-${index + 1}`),
    actionText: String(action?.action || '').trim(),
    metricKey,
    windowDays,
    baselineValue: finiteNumber(baseline.value),
    targetValue: finiteNumber(target.value),
    unit: String(target.unit || baseline.unit || '').trim() || null,
    trackingStatus: tracking.valid && metricKey && finiteNumber(baseline.value) !== null ? 'TRACKING_CONFIGURED' : 'TRACKING_UNAVAILABLE',
  };
}

function compareOutcome(baseline, target, actual) {
  if (target === null) {
    if (actual > baseline) return 'IMPROVED_FROM_BASELINE';
    if (actual < baseline) return 'DECLINED_FROM_BASELINE';
    return 'NO_CHANGE';
  }
  if (target > baseline) return actual >= target ? 'TARGET_MET' : actual > baseline ? 'IMPROVED_BELOW_TARGET' : 'NOT_IMPROVED';
  if (target < baseline) return actual <= target ? 'TARGET_MET' : actual < baseline ? 'IMPROVED_ABOVE_TARGET' : 'NOT_IMPROVED';
  return actual === baseline ? 'NO_CHANGE' : actual > baseline ? 'ABOVE_BASELINE' : 'BELOW_BASELINE';
}

function publicEvaluation(evaluation) {
  if (!evaluation) return null;
  return {
    id: evaluation.id,
    actionId: evaluation.actionId,
    windowDays: evaluation.windowDays,
    windowStartDate: evaluation.windowStartDate,
    windowEndDate: evaluation.windowEndDate,
    status: evaluation.status,
    periodStatus: evaluation.periodStatus,
    baselineValue: evaluation.baselineValue,
    targetValue: evaluation.targetValue,
    actualValue: evaluation.actualValue,
    deltaValue: evaluation.deltaValue,
    verdict: evaluation.verdict,
    evidence: parseJson(evaluation.evidenceJson, []),
    effectivePeriod: parseJson(evaluation.effectivePeriodJson, null),
    notes: evaluation.notes,
    evaluatedAt: isoDate(evaluation.evaluatedAt),
  };
}

function publicAction(action) {
  if (!action) return null;
  return {
    id: action.id,
    analysisId: action.analysisId,
    recommendationIndex: action.recommendationIndex,
    recommendationId: action.recommendationId,
    actionText: action.actionText,
    status: action.status,
    metricKey: action.metricKey,
    windowDays: action.windowDays,
    baselineValue: action.baselineValue,
    targetValue: action.targetValue,
    unit: action.unit,
    trackingStatus: action.trackingStatus || (action.metricKey && action.baselineValue !== null ? 'TRACKING_CONFIGURED' : 'TRACKING_UNAVAILABLE'),
    baselinePeriod: action.baselinePeriodStartDate && action.baselinePeriodEndDate
      ? { startDate: action.baselinePeriodStartDate, endDate: action.baselinePeriodEndDate }
      : null,
    notes: action.notes,
    startedAt: isoDate(action.startedAt),
    completedAt: isoDate(action.completedAt),
    createdAt: isoDate(action.createdAt),
    evaluations: (action.evaluations || []).map(publicEvaluation),
  };
}

class HermesMemoryService {
  async persistAnalysis({ userId, storeId, context, result }) {
    if (!isMemoryStoreAvailable() || !userId || !storeId || !context?.period || !result?.analysis) return null;
    return prisma.hermesAnalysisMemory.create({
      data: {
        userId: String(userId),
        storeId: String(storeId),
        intent: context.intent,
        periodStart: context.period.startDate,
        periodEnd: context.period.endDate,
        periodDays: context.period.days,
        sourceMode: context.sourceMode || context.quality?.sourceMode || 'UNKNOWN',
        qualityStatus: context.quality?.status || 'UNKNOWN',
        skillId: context.skill?.id || null,
        skillVersion: context.skill?.version || null,
        provider: result.provider || null,
        model: result.model || null,
        promptVersion: context.promptVersion || '1.1.0',
        outputSchemaVersion: result.analysis?.schemaVersion || '1.0',
        contextJson: json({
          intent: context.intent,
          period: context.period,
          effectivePeriod: context.effectivePeriod || null,
          sourceMode: context.sourceMode || context.quality?.sourceMode || null,
          quality: context.quality,
          trustedMetrics: context.trustedMetrics,
          comparisons: context.comparisons,
          details: context.details,
          learning: context.learning || null,
        }),
        evidenceJson: json(context.evidence || [], []),
        analysisJson: json(result.analysis),
      },
    });
  }

  async listMemories({ userId, storeId, intent, limit = 20 } = {}) {
    if (!isMemoryStoreAvailable() || !userId) return [];
    const where = { userId: String(userId) };
    if (storeId) where.storeId = String(storeId);
    if (intent) where.intent = String(intent);
    let rows;
    try {
      rows = await prisma.hermesAnalysisMemory.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(Number(limit) || 20, 1), 100),
        include: {
          feedback: true,
          actions: { include: { evaluations: true }, orderBy: { recommendationIndex: 'asc' } },
        },
      });
    } catch {
      return [];
    }
    return rows.map((row) => ({
      id: row.id,
      storeId: row.storeId,
      intent: row.intent,
      period: { startDate: row.periodStart, endDate: row.periodEnd, days: row.periodDays },
      sourceMode: row.sourceMode,
      qualityStatus: row.qualityStatus,
      skill: row.skillId ? { id: row.skillId, version: row.skillVersion } : null,
      createdAt: isoDate(row.createdAt),
      feedback: row.feedback.map((item) => ({ rating: item.rating, reasons: parseJson(item.reasonsJson, []), comment: item.comment, createdAt: isoDate(item.createdAt) })),
      actions: row.actions.map(publicAction),
    }));
  }

  async getMemory({ userId, id } = {}) {
    if (!isMemoryStoreAvailable() || !userId || !id) return null;
    let row;
    try {
      row = await prisma.hermesAnalysisMemory.findFirst({
        where: { id: String(id), userId: String(userId) },
        include: {
          feedback: true,
          actions: { include: { evaluations: true }, orderBy: { recommendationIndex: 'asc' } },
        },
      });
    } catch {
      return null;
    }
    if (!row) return null;
    return {
      id: row.id,
      storeId: row.storeId,
      intent: row.intent,
      period: { startDate: row.periodStart, endDate: row.periodEnd, days: row.periodDays },
      sourceMode: row.sourceMode,
      qualityStatus: row.qualityStatus,
      skill: row.skillId ? { id: row.skillId, version: row.skillVersion } : null,
      context: parseJson(row.contextJson),
      evidence: parseJson(row.evidenceJson, []),
      analysis: parseJson(row.analysisJson),
      createdAt: isoDate(row.createdAt),
      feedback: row.feedback.map((item) => ({ id: item.id, rating: item.rating, reasons: parseJson(item.reasonsJson, []), comment: item.comment, createdAt: isoDate(item.createdAt) })),
      actions: row.actions.map(publicAction),
    };
  }

  async saveFeedback({ userId, analysisId, rating, reasons = [], comment = null }) {
    if (!isMemoryStoreAvailable()) return { success: false, errorCode: 'MEMORY_UNAVAILABLE', message: 'Penyimpanan memori Hermes tidak tersedia; feedback tidak dapat disimpan.' };
    const normalized = String(rating || '').toUpperCase();
    if (!FEEDBACK_RATINGS.has(normalized)) return { success: false, errorCode: 'INVALID_FEEDBACK', message: 'Rating feedback tidak dikenali.' };
    const normalizedReasons = [...new Set((Array.isArray(reasons) ? reasons : [reasons])
      .map((reason) => String(reason || '').toUpperCase().trim())
      .filter((reason) => FEEDBACK_REASONS.has(reason)))];
    const memory = await prisma.hermesAnalysisMemory.findFirst({ where: { id: String(analysisId), userId: String(userId) }, select: { id: true } });
    if (!memory) return { success: false, errorCode: 'MEMORY_NOT_FOUND', message: 'Memori analisa tidak ditemukan untuk pengguna ini.' };
    const feedback = await prisma.hermesAnalysisFeedback.upsert({
      where: { analysisId_userId: { analysisId: memory.id, userId: String(userId) } },
      update: { rating: normalized, reasonsJson: json(normalizedReasons, []), comment: comment ? String(comment).slice(0, 2000) : null },
      create: { analysisId: memory.id, userId: String(userId), rating: normalized, reasonsJson: json(normalizedReasons, []), comment: comment ? String(comment).slice(0, 2000) : null },
    });
    return { success: true, feedback: { id: feedback.id, rating: feedback.rating, reasons: normalizedReasons, comment: feedback.comment, createdAt: isoDate(feedback.createdAt) } };
  }

  async createAction({ userId, analysisId, recommendationIndex }) {
    if (!isMemoryStoreAvailable()) return { success: false, errorCode: 'MEMORY_UNAVAILABLE', message: 'Penyimpanan memori Hermes tidak tersedia; tindakan tidak dapat dicatat.' };
    const memory = await prisma.hermesAnalysisMemory.findFirst({ where: { id: String(analysisId), userId: String(userId) } });
    if (!memory) return { success: false, errorCode: 'MEMORY_NOT_FOUND', message: 'Memori analisa tidak ditemukan untuk pengguna ini.' };
    const analysis = parseJson(memory.analysisJson, {});
    const index = Number(recommendationIndex);
    const action = Array.isArray(analysis.prioritizedActions) ? analysis.prioritizedActions[index] : null;
    if (!action) return { success: false, errorCode: 'RECOMMENDATION_NOT_FOUND', message: 'Rekomendasi tidak ditemukan di memori analisa.' };
    const normalized = normalizeAction(action, index, memory.intent);
    const { trackingStatus, ...persistedAction } = normalized;
    const row = await prisma.hermesRecommendationAction.upsert({
      where: { analysisId_recommendationIndex: { analysisId: memory.id, recommendationIndex: index } },
      update: { actionText: persistedAction.actionText, recommendationId: persistedAction.recommendationId, metricKey: persistedAction.metricKey, windowDays: persistedAction.windowDays, baselineValue: persistedAction.baselineValue, targetValue: persistedAction.targetValue, unit: persistedAction.unit, baselinePeriodStartDate: memory.periodStart, baselinePeriodEndDate: memory.periodEnd },
      create: { userId: String(userId), analysisId: memory.id, baselinePeriodStartDate: memory.periodStart, baselinePeriodEndDate: memory.periodEnd, ...persistedAction },
      include: { evaluations: true },
    });
    return { success: true, trackingConfigured: trackingStatus === 'TRACKING_CONFIGURED', action: { ...publicAction(row), trackingStatus } };
  }

  async updateAction({ userId, actionId, status, notes }) {
    if (!isMemoryStoreAvailable()) return { success: false, errorCode: 'MEMORY_UNAVAILABLE', message: 'Penyimpanan memori Hermes tidak tersedia; status tindakan tidak dapat diperbarui.' };
    const normalized = String(status || '').toUpperCase();
    if (!ACTION_STATUSES.has(normalized)) return { success: false, errorCode: 'INVALID_ACTION_STATUS', message: 'Status tindakan tidak dikenali.' };
    const current = await prisma.hermesRecommendationAction.findFirst({ where: { id: String(actionId), userId: String(userId) } });
    if (!current) return { success: false, errorCode: 'ACTION_NOT_FOUND', message: 'Tindakan tidak ditemukan untuk pengguna ini.' };
    const now = new Date();
    const data = {
      status: normalized,
      notes: notes === undefined ? current.notes : (notes ? String(notes).slice(0, 4000) : null),
      startedAt: current.startedAt || (normalized === 'IN_PROGRESS' ? now : null),
      completedAt: normalized === 'COMPLETED' ? (current.completedAt || now) : current.completedAt,
    };
    const row = await prisma.hermesRecommendationAction.update({ where: { id: current.id }, data, include: { evaluations: true } });
    if (normalized === 'COMPLETED') {
      for (const windowDays of [7, 30]) {
        await prisma.hermesRecommendationEvaluation.upsert({
          where: { actionId_windowDays: { actionId: row.id, windowDays } },
          update: {},
          create: { userId: String(userId), actionId: row.id, windowDays, status: 'NOT_READY', periodStatus: 'NOT_CHECKED', notes: 'Menunggu jendela evaluasi setelah tindakan selesai.' },
        });
      }
    }
    const refreshed = await prisma.hermesRecommendationAction.findFirst({ where: { id: row.id, userId: String(userId) }, include: { evaluations: true } });
    return { success: true, action: publicAction(refreshed) };
  }

  async evaluateAction({ userId, actionId, windowDays }) {
    if (!isMemoryStoreAvailable()) return { success: false, errorCode: 'MEMORY_UNAVAILABLE', message: 'Penyimpanan memori Hermes tidak tersedia; evaluasi tidak dapat dijalankan.' };
    const window = Number(windowDays);
    if (!EVALUATION_WINDOWS.has(window)) return { success: false, errorCode: 'INVALID_EVALUATION_WINDOW', message: 'Jendela evaluasi hanya 7 atau 30 hari.' };
    const action = await prisma.hermesRecommendationAction.findFirst({ where: { id: String(actionId), userId: String(userId) }, include: { analysis: true } });
    if (!action) return { success: false, errorCode: 'ACTION_NOT_FOUND', message: 'Tindakan tidak ditemukan untuk pengguna ini.' };
    const current = await prisma.hermesRecommendationEvaluation.findUnique({ where: { actionId_windowDays: { actionId: action.id, windowDays: window } } });
    if (!action.completedAt) return { success: true, evaluation: publicEvaluation(current), message: 'Tindakan belum ditandai selesai; evaluasi belum dimulai.' };
    // Eligibility berbasis hari kalender (bukan selisih milidetik persis). Sumber
    // kanonik live hanya menyajikan rolling window yang berakhir hari ini, jadi jendela
    // pasca-tindakan hanya sejajar pada satu hari: `tanggalSelesai + windowDays`. Dengan
    // menggerbang pada hari kalender — bukan jam persis penyelesaian — pengguna punya
    // satu hari penuh untuk memicu evaluasi saat periodenya masih sejajar.
    const eligibleDateKey = shiftDateKey(dateKey(action.completedAt), window);
    const todayKey = dateKey();
    if (todayKey < eligibleDateKey) {
      const requestedRange = postActionRange(action.completedAt, window);
      const remainingDays = Math.max(1, Math.round((Date.parse(`${eligibleDateKey}T00:00:00.000Z`) - Date.parse(`${todayKey}T00:00:00.000Z`)) / 86400000));
      const note = `Belum waktunya: outcome ${window} hari dapat dievaluasi mulai ${eligibleDateKey} (±${remainingDays} hari lagi).`;
      const updated = await prisma.hermesRecommendationEvaluation.upsert({
        where: { actionId_windowDays: { actionId: action.id, windowDays: window } },
        update: { status: 'NOT_READY', periodStatus: 'NOT_CHECKED', windowStartDate: requestedRange.startDate, windowEndDate: requestedRange.endDate, notes: note },
        create: { userId: String(userId), actionId: action.id, windowDays: window, status: 'NOT_READY', periodStatus: 'NOT_CHECKED', windowStartDate: requestedRange.startDate, windowEndDate: requestedRange.endDate, notes: note },
      });
      return { success: true, evaluation: publicEvaluation(updated), message: 'Jendela evaluasi belum mencapai batas waktunya.' };
    }
    if (!action.metricKey || action.baselineValue === null || action.baselineValue === undefined) {
      const requestedRange = postActionRange(action.completedAt, window);
      const updated = await prisma.hermesRecommendationEvaluation.upsert({
        where: { actionId_windowDays: { actionId: action.id, windowDays: window } },
        update: { status: 'INSUFFICIENT_DATA', periodStatus: 'NOT_CHECKED', windowStartDate: requestedRange.startDate, windowEndDate: requestedRange.endDate, notes: 'Rekomendasi tidak memiliki metricKey dan baseline numerik yang tervalidasi.' },
        create: { userId: String(userId), actionId: action.id, windowDays: window, status: 'INSUFFICIENT_DATA', periodStatus: 'NOT_CHECKED', windowStartDate: requestedRange.startDate, windowEndDate: requestedRange.endDate, notes: 'Rekomendasi tidak memiliki metricKey dan baseline numerik yang tervalidasi.' },
      });
      return { success: true, evaluation: publicEvaluation(updated), message: 'Evaluasi tidak dijalankan karena baseline rekomendasi tidak terukur.' };
    }
    const tracking = validateTrackingConfig({
      intent: action.analysis.intent,
      metricKey: action.metricKey,
      baselineValue: action.baselineValue,
      targetValue: action.targetValue,
      unit: action.unit,
      windowDays: window,
    });
    if (!tracking.valid || !tracking.definition) {
      const requestedRange = postActionRange(action.completedAt, window);
      const updated = await prisma.hermesRecommendationEvaluation.upsert({
        where: { actionId_windowDays: { actionId: action.id, windowDays: window } },
        update: { status: 'INSUFFICIENT_DATA', periodStatus: 'NOT_CHECKED', windowStartDate: requestedRange.startDate, windowEndDate: requestedRange.endDate, notes: tracking.errors.join(' ') || 'Metric key tidak memiliki definisi kanonik.' },
        create: { userId: String(userId), actionId: action.id, windowDays: window, status: 'INSUFFICIENT_DATA', periodStatus: 'NOT_CHECKED', windowStartDate: requestedRange.startDate, windowEndDate: requestedRange.endDate, notes: tracking.errors.join(' ') || 'Metric key tidak memiliki definisi kanonik.' },
      });
      return { success: true, evaluation: publicEvaluation(updated), message: 'Evaluasi ditahan karena metric key tidak memiliki kontrak kanonik.' };
    }

    const requestedRange = postActionRange(action.completedAt, window);
    // The canonical adapters expose native rolling windows only. They are safe for
    // outcome evaluation only when the requested action window is the current
    // rolling window; assessPeriodStatus rejects stale windows below.
    const canonical = await hermesCanonicalDataService.load({ intent: action.analysis.intent, range: rangeForDays(window), storeId: action.analysis.storeId });
    const actual = metricFromCanonical(canonical, action.metricKey);
    if (!canonical.success || canonical.quality?.status !== 'SAFE' || actual === null) {
      const reason = canonical.quality?.reason || `Metrik ${action.metricKey} tidak tersedia pada sumber kanonik.`;
      const updated = await prisma.hermesRecommendationEvaluation.upsert({
        where: { actionId_windowDays: { actionId: action.id, windowDays: window } },
        update: { status: 'INSUFFICIENT_DATA', periodStatus: 'SOURCE_BLOCKED', windowStartDate: requestedRange.startDate, windowEndDate: requestedRange.endDate, notes: reason, evidenceJson: json(canonical.evidence || [], []) },
        create: { userId: String(userId), actionId: action.id, windowDays: window, status: 'INSUFFICIENT_DATA', periodStatus: 'SOURCE_BLOCKED', windowStartDate: requestedRange.startDate, windowEndDate: requestedRange.endDate, notes: reason, evidenceJson: json(canonical.evidence || [], []) },
      });
      return { success: true, evaluation: publicEvaluation(updated), message: 'Data kanonik belum cukup untuk evaluasi.' };
    }

    const periodStatus = assessPeriodStatus(canonical, requestedRange, window);
    if (periodStatus === 'PERIOD_MISMATCH') {
      const updated = await prisma.hermesRecommendationEvaluation.upsert({
        where: { actionId_windowDays: { actionId: action.id, windowDays: window } },
        update: { status: 'PERIOD_MISMATCH', periodStatus, windowStartDate: requestedRange.startDate, windowEndDate: requestedRange.endDate, notes: 'Periode sumber kanonik tidak sama dengan jendela tindakan; verdict tidak dipaksakan.', evidenceJson: json(canonical.evidence || [], []), effectivePeriodJson: json(canonical.effectivePeriod || null) },
        create: { userId: String(userId), actionId: action.id, windowDays: window, status: 'PERIOD_MISMATCH', periodStatus, windowStartDate: requestedRange.startDate, windowEndDate: requestedRange.endDate, notes: 'Periode sumber kanonik tidak sama dengan jendela tindakan; verdict tidak dipaksakan.', evidenceJson: json(canonical.evidence || [], []), effectivePeriodJson: json(canonical.effectivePeriod || null) },
      });
      return { success: true, evaluation: publicEvaluation(updated), message: 'Evaluasi ditahan karena periode sumber tidak sama dengan periode tindakan.' };
    }

    const baseline = finiteNumber(action.baselineValue);
    const target = finiteNumber(action.targetValue);
    const evaluation = await prisma.hermesRecommendationEvaluation.upsert({
      where: { actionId_windowDays: { actionId: action.id, windowDays: window } },
      update: {
        status: 'EVALUATED', periodStatus, windowStartDate: requestedRange.startDate, windowEndDate: requestedRange.endDate,
        baselineValue: baseline, targetValue: target, actualValue: actual, deltaValue: actual - baseline,
        verdict: compareOutcome(baseline, target, actual), evidenceJson: json(canonical.evidence || [], []),
        effectivePeriodJson: json(canonical.effectivePeriod || null),
        notes: 'Perbandingan outcome terhadap baseline; bukan bukti kausal tanpa eksperimen terkontrol.', evaluatedAt: new Date(),
      },
      create: {
        userId: String(userId), actionId: action.id, windowDays: window, status: 'EVALUATED', periodStatus,
        windowStartDate: requestedRange.startDate, windowEndDate: requestedRange.endDate, baselineValue: baseline, targetValue: target,
        actualValue: actual, deltaValue: actual - baseline, verdict: compareOutcome(baseline, target, actual),
        evidenceJson: json(canonical.evidence || [], []), effectivePeriodJson: json(canonical.effectivePeriod || null),
        notes: 'Perbandingan outcome terhadap baseline; bukan bukti kausal tanpa eksperimen terkontrol.', evaluatedAt: new Date(),
      },
    });
    return { success: true, evaluation: publicEvaluation(evaluation), message: 'Outcome berhasil dievaluasi dari sumber kanonik.' };
  }

  async getLearningContext({ userId, storeId, intent, limit = 10 } = {}) {
    if (!isMemoryStoreAvailable() || !userId) return { memoryCount: 0, feedback: [], outcomes: [], note: 'Memori belum tersedia.' };
    let rows;
    try {
      rows = await prisma.hermesAnalysisMemory.findMany({
        where: { userId: String(userId), ...(storeId ? { storeId: String(storeId) } : {}), ...(intent ? { intent: String(intent) } : {}) },
        orderBy: { createdAt: 'desc' }, take: Math.min(Number(limit) || 10, 50),
        include: { feedback: true, actions: { include: { evaluations: true } } },
      });
    } catch {
      return { memoryCount: 0, feedback: [], outcomes: [], note: 'Memori analisa belum dapat dibaca; jangan menyimpulkan pembelajaran historis.' };
    }
    const feedback = rows.flatMap((row) => row.feedback.map((item) => ({ rating: item.rating, reasons: parseJson(item.reasonsJson, []), comment: item.comment, analysisId: row.id })));
    const outcomes = rows.flatMap((row) => row.actions.flatMap((action) => action.evaluations
      .filter((evaluation) => evaluation.status === 'EVALUATED')
      .map((evaluation) => ({
        analysisId: row.id, actionId: action.id, intent: row.intent, action: action.actionText,
        metricKey: action.metricKey, windowDays: evaluation.windowDays, baselineValue: evaluation.baselineValue,
        targetValue: evaluation.targetValue, actualValue: evaluation.actualValue, deltaValue: evaluation.deltaValue,
        verdict: evaluation.verdict, periodStatus: evaluation.periodStatus, notes: evaluation.notes,
      }))));
    const boundedFeedback = feedback.slice(0, 10);
    const boundedOutcomes = outcomes.slice(0, 10);
    return {
      memoryCount: rows.length,
      feedback: boundedFeedback,
      outcomes: boundedOutcomes,
      sampleCount: boundedOutcomes.length,
      learningConfidence: boundedOutcomes.length >= 3 ? 'MEDIUM' : boundedOutcomes.length ? 'LOW' : 'NONE',
      note: boundedOutcomes.length
        ? 'Gunakan outcome ini sebagai sinyal pembelajaran historis; jangan menyatakan rekomendasi sebagai penyebab tanpa eksperimen terkontrol.'
        : 'Belum ada outcome tindakan yang selesai dan tervalidasi; jangan mengklaim pembelajaran empiris.',
    };
  }
}

const service = new HermesMemoryService();
service.HermesMemoryService = HermesMemoryService;
service.isMemoryStoreAvailable = isMemoryStoreAvailable;
service.FEEDBACK_RATINGS = FEEDBACK_RATINGS;
service.ACTION_STATUSES = ACTION_STATUSES;
service.EVALUATION_WINDOWS = EVALUATION_WINDOWS;
service.compareOutcome = compareOutcome;
service.normalizeAction = normalizeAction;
service.assessPeriodStatus = assessPeriodStatus;
service.postActionRange = postActionRange;
service.FEEDBACK_REASONS = FEEDBACK_REASONS;
module.exports = service;
