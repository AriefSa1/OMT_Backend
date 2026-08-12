const hermesAgentService = require('../services/hermesAgentService');
const hermesAnalysisService = require('../services/hermesAnalysisService');
const hermesMemoryService = require('../services/hermesMemoryService');
const { wrapHandlers } = require('../utils/asyncHandler');

async function getStatus(req, res) {
  return res.json(hermesAgentService.getStatus());
}

async function chat(req, res) {
  const result = await hermesAgentService.chat({
    messages: req.body?.messages,
    model: req.body?.model,
    temperature: req.body?.temperature,
    maxTokens: req.body?.maxTokens,
    conversation: req.body?.conversation,
    previousResponseId: req.body?.previousResponseId,
    mode: req.body?.mode,
  });
  const { statusCode = 200, ...payload } = result;
  return res.status(statusCode).json(payload);
}

function analysisArgs(req) {
  return {
    intent: req.body?.intent,
    prompt: req.body?.prompt,
    storeId: req.body?.storeId || req.body?.store_id,
    startDate: req.body?.startDate || req.body?.start_date,
    endDate: req.body?.endDate || req.body?.end_date,
    days: req.body?.days,
    user: req.user,
  };
}

async function validateAnalysis(req, res) {
  const result = await hermesAnalysisService.validate(analysisArgs(req));
  const { statusCode = 200, ...payload } = result;
  return res.status(statusCode).json(payload);
}

async function analyze(req, res) {
  const result = await hermesAnalysisService.analyze(analysisArgs(req));
  const { statusCode = 200, ...payload } = result;
  return res.status(statusCode).json(payload);
}

async function listMemories(req, res) {
  const memories = await hermesMemoryService.listMemories({
    userId: req.user.id,
    storeId: req.query?.storeId || req.query?.store_id,
    intent: req.query?.intent,
    limit: req.query?.limit,
  });
  return res.json({ success: true, memories });
}

async function getMemory(req, res) {
  const memory = await hermesMemoryService.getMemory({ userId: req.user.id, id: req.params.id });
  if (!memory) return res.status(404).json({ success: false, errorCode: 'MEMORY_NOT_FOUND', message: 'Memori analisa tidak ditemukan.' });
  return res.json({ success: true, memory });
}

async function saveFeedback(req, res) {
  const result = await hermesMemoryService.saveFeedback({
    userId: req.user.id,
    analysisId: req.params.id,
    rating: req.body?.rating,
    reasons: req.body?.reasons,
    comment: req.body?.comment,
  });
  return res.status(result.success ? 200 : 422).json(result);
}

async function createAction(req, res) {
  const result = await hermesMemoryService.createAction({
    userId: req.user.id,
    analysisId: req.params.id,
    recommendationIndex: req.body?.recommendationIndex ?? req.body?.recommendation_index,
  });
  return res.status(result.success ? 200 : 422).json(result);
}

async function updateAction(req, res) {
  const result = await hermesMemoryService.updateAction({
    userId: req.user.id,
    actionId: req.params.id,
    status: req.body?.status,
    notes: req.body?.notes,
  });
  return res.status(result.success ? 200 : 422).json(result);
}

async function evaluateAction(req, res) {
  const result = await hermesMemoryService.evaluateAction({
    userId: req.user.id,
    actionId: req.params.id,
    windowDays: req.body?.windowDays ?? req.body?.window_days ?? req.query?.windowDays,
  });
  return res.status(result.success ? 200 : 422).json(result);
}

module.exports = wrapHandlers({
  getStatus,
  chat,
  validateAnalysis,
  analyze,
  listMemories,
  getMemory,
  saveFeedback,
  createAction,
  updateAction,
  evaluateAction,
});
