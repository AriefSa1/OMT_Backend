const hermesAgentService = require('../services/hermesAgentService');
const hermesAnalysisService = require('../services/hermesAnalysisService');
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

module.exports = wrapHandlers({ getStatus, chat, validateAnalysis, analyze });
