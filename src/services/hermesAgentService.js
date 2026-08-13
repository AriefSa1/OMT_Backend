const axios = require('axios');

const DEFAULT_BASE_URL = 'http://127.0.0.1:8642/v1';
const DEFAULT_MODEL = 'hermes-agent';
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_MESSAGES = 100;
const CHAT_MODES = Object.freeze({
  EXPLORATORY: 'EXPLORATORY',
  GROUNDED_ANALYSIS: 'GROUNDED_ANALYSIS',
});

function cleanBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function parseTimeout(value) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS;
}

function classifyHermesError(err) {
  if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT') {
    return { code: 'TIMEOUT', status: 504, message: 'Hermes Agent tidak merespons dalam batas waktu.' };
  }

  const status = Number(err?.response?.status);
  if (status === 401 || status === 403) {
    return { code: 'UNAUTHORIZED', status: 502, message: 'Hermes Agent menolak API key yang dikonfigurasi.' };
  }
  if (status === 429) {
    return { code: 'RATE_LIMITED', status: 503, message: 'Hermes Agent sedang membatasi permintaan.' };
  }
  if (status >= 400 && status < 500) {
    return { code: 'BAD_REQUEST', status: 502, message: 'Hermes Agent menolak format permintaan.' };
  }
  if (status >= 500) {
    return { code: 'UPSTREAM_ERROR', status: 502, message: 'Hermes Agent mengembalikan kegagalan layanan.' };
  }
  return { code: 'UNAVAILABLE', status: 503, message: 'Hermes Agent lokal tidak dapat dihubungi.' };
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 'Field messages wajib berupa array yang tidak kosong.';
  }
  if (messages.length > MAX_MESSAGES) {
    return `Field messages tidak boleh berisi lebih dari ${MAX_MESSAGES} pesan.`;
  }

  for (const message of messages) {
    if (!message || !['system', 'user', 'assistant', 'tool'].includes(message.role)) {
      return 'Setiap pesan harus memiliki role system, user, assistant, atau tool.';
    }
    if (typeof message.content !== 'string' && !Array.isArray(message.content)) {
      return 'Setiap pesan harus memiliki content berupa string atau array content.';
    }
  }
  return null;
}

class HermesAgentService {
  constructor() {
    this.refreshFromEnv();
  }

  refreshFromEnv() {
    this.enabled = String(process.env.HERMES_AGENT_ENABLED || '').toLowerCase() === 'true';
    this.baseUrl = cleanBaseUrl(process.env.HERMES_AGENT_BASE_URL || DEFAULT_BASE_URL);
    this.apiKey = String(process.env.HERMES_AGENT_API_KEY || '').trim();
    this.defaultModel = String(process.env.HERMES_AGENT_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    this.timeoutMs = parseTimeout(process.env.HERMES_AGENT_TIMEOUT_MS);
  }

  isConfigured() {
    return this.enabled && Boolean(this.baseUrl) && Boolean(this.apiKey);
  }

  getStatus() {
    return {
      success: true,
      provider: 'HERMES_AGENT',
      enabled: this.enabled,
      configured: this.isConfigured(),
      baseUrl: this.baseUrl || null,
      model: this.defaultModel,
      timeoutMs: this.timeoutMs,
      availability: 'NOT_CHECKED',
      message: this.isConfigured()
        ? 'Hermes Agent dikonfigurasi. Ketersediaan belum diprobe.'
        : 'Hermes Agent belum dikonfigurasi secara lengkap.',
    };
  }

  async chat({ messages, model, temperature, maxTokens, conversation, previousResponseId, responseFormat, mode = CHAT_MODES.EXPLORATORY } = {}) {
    const validationError = validateMessages(messages);
    if (validationError) {
      return {
        success: false,
        provider: 'HERMES_AGENT',
        errorCode: 'MISSING_INPUT',
        message: validationError,
        statusCode: 400,
      };
    }

    if (!this.isConfigured()) {
      return {
        success: false,
        provider: 'HERMES_AGENT',
        errorCode: 'NOT_CONFIGURED',
        model: this.defaultModel,
        message: 'Hermes Agent belum dikonfigurasi. Isi HERMES_AGENT_ENABLED, HERMES_AGENT_API_KEY, dan URL Hermes lokal.',
        statusCode: 503,
      };
    }

    const normalizedMode = String(mode || CHAT_MODES.EXPLORATORY).toUpperCase();
    if (!Object.values(CHAT_MODES).includes(normalizedMode)) {
      return {
        success: false,
        provider: 'HERMES_AGENT',
        errorCode: 'MISSING_INPUT',
        message: `Mode chat tidak dikenal. Gunakan ${Object.values(CHAT_MODES).join(' atau ')}.`,
        statusCode: 400,
      };
    }

    const payload = {
      model: model || this.defaultModel,
      messages,
      stream: false,
    };
    if (temperature !== undefined) payload.temperature = temperature;
    if (maxTokens !== undefined) payload.max_tokens = maxTokens;
    if (conversation !== undefined) payload.conversation = conversation;
    if (previousResponseId !== undefined) payload.previous_response_id = previousResponseId;
    if (responseFormat !== undefined) payload.response_format = responseFormat;

    try {
      const response = await axios.post(
        `${this.baseUrl}/chat/completions`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: this.timeoutMs,
        }
      );

      const data = response.data;
      const content = data?.choices?.[0]?.message?.content;
      if (!data || !Array.isArray(data.choices) || !data.choices[0]?.message || content === undefined) {
        return {
          success: false,
          provider: 'HERMES_AGENT',
          mode: normalizedMode,
          grounding: normalizedMode === CHAT_MODES.GROUNDED_ANALYSIS ? 'CANONICAL_DATA_REQUIRED' : 'UNVERIFIED_EXPLORATORY',
          errorCode: 'INVALID_RESPONSE',
          model: payload.model,
          message: 'Hermes Agent mengembalikan format response yang tidak dikenali.',
          statusCode: 502,
        };
      }

      return {
        success: true,
        provider: 'HERMES_AGENT',
        mode: normalizedMode,
        grounding: normalizedMode === CHAT_MODES.GROUNDED_ANALYSIS ? 'CANONICAL_DATA_REQUIRED' : 'UNVERIFIED_EXPLORATORY',
        model: data.model || payload.model,
        response: data,
      };
    } catch (err) {
      const classified = classifyHermesError(err);
      console.warn(`[Hermes Agent] ${classified.code}: ${err.message}`);
      return {
        success: false,
        provider: 'HERMES_AGENT',
        mode: normalizedMode,
        grounding: normalizedMode === CHAT_MODES.GROUNDED_ANALYSIS ? 'CANONICAL_DATA_REQUIRED' : 'UNVERIFIED_EXPLORATORY',
        errorCode: classified.code,
        model: payload.model,
        message: classified.message,
        statusCode: classified.status,
      };
    }
  }
}

const hermesAgentService = new HermesAgentService();
hermesAgentService.HermesAgentService = HermesAgentService;
hermesAgentService.classifyHermesError = classifyHermesError;

module.exports = hermesAgentService;
