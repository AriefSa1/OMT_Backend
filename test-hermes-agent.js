/**
 * Mocked regression suite for the dedicated Hermes Agent route service.
 * It never calls a live local Hermes process.
 */
const axios = require('axios');

process.env.HERMES_AGENT_ENABLED = 'true';
process.env.HERMES_AGENT_BASE_URL = 'http://127.0.0.1:8642/v1';
process.env.HERMES_AGENT_API_KEY = 'test-hermes-key';
process.env.HERMES_AGENT_MODEL = 'hermes-agent';
process.env.HERMES_AGENT_TIMEOUT_MS = '1000';

const hermesAgentService = require('./src/services/hermesAgentService');

let passed = 0;
let total = 0;

function check(label, condition) {
  total += 1;
  if (condition) {
    passed += 1;
    console.log(`  PASS ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
  }
}

async function main() {
  console.log('=== Hermes Agent service — mocked regression suite ===\n');

  const originalPost = axios.post;
  try {
    console.log('1. Valid OpenAI-compatible response');
    let request;
    axios.post = async (url, body, config) => {
      request = { url, body, config };
      return {
        data: {
          id: 'chatcmpl-test',
          model: 'hermes-agent',
          choices: [{ message: { role: 'assistant', content: 'Halo dari Hermes.' } }],
        },
      };
    };
    const success = await hermesAgentService.chat({
      messages: [{ role: 'user', content: 'Halo' }],
    });
    check('returns successful Hermes envelope', success.success === true && success.provider === 'HERMES_AGENT');
    check('uses the dedicated chat completions endpoint', request.url === 'http://127.0.0.1:8642/v1/chat/completions');
    check('sends bearer authentication without exposing it in the response', request.config.headers.Authorization === 'Bearer test-hermes-key' && !JSON.stringify(success).includes('test-hermes-key'));
    check('forwards messages and disables streaming for this first route', request.body.messages[0].content === 'Halo' && request.body.stream === false);
    check('labels exploratory chat as unverified', success.mode === 'EXPLORATORY' && success.grounding === 'UNVERIFIED_EXPLORATORY');

    await hermesAgentService.chat({
      messages: [{ role: 'user', content: 'Pakai model pilihan' }],
      model: 'deepseek/deepseek-v4-pro',
    });
    check('forwards the user-selected model', request.body.model === 'deepseek/deepseek-v4-pro');

    const originalGet = axios.get;
    axios.get = async () => ({ data: { data: [{ id: 'z-model' }, { id: 'a-model' }, { id: 'z-model' }] } });
    const discovered = await hermesAgentService.listModels({ force: true });
    check('discovers and normalizes upstream models', discovered.success === true && discovered.modelCount === 2 && discovered.models[0].id === 'a-model');
    axios.get = originalGet;

    const grounded = await hermesAgentService.chat({
      messages: [{ role: 'user', content: 'Analisa data' }],
      mode: 'GROUNDED_ANALYSIS',
    });
    check('supports an explicit grounded mode label', grounded.mode === 'GROUNDED_ANALYSIS' && grounded.grounding === 'CANONICAL_DATA_REQUIRED');

    const invalidMode = await hermesAgentService.chat({
      messages: [{ role: 'user', content: 'Tes' }],
      mode: 'UNKNOWN',
    });
    check('rejects unknown chat mode', invalidMode.success === false && invalidMode.errorCode === 'MISSING_INPUT');

    console.log('\n2. Invalid input must not call Hermes');
    let invalidCalls = 0;
    axios.post = async () => {
      invalidCalls += 1;
      return { data: {} };
    };
    const invalid = await hermesAgentService.chat({ messages: [] });
    check('reports MISSING_INPUT', invalid.success === false && invalid.errorCode === 'MISSING_INPUT');
    check('does not call upstream for invalid input', invalidCalls === 0);

    console.log('\n3. Upstream timeout is classified');
    axios.post = async () => {
      const error = new Error('timeout');
      error.code = 'ECONNABORTED';
      throw error;
    };
    const timeout = await hermesAgentService.chat({ messages: [{ role: 'user', content: 'Tes' }] });
    check('reports TIMEOUT instead of generic failure', timeout.success === false && timeout.errorCode === 'TIMEOUT');

    console.log('\n4. Missing configuration is explicit');
    hermesAgentService.enabled = false;
    const notConfigured = await hermesAgentService.chat({ messages: [{ role: 'user', content: 'Tes' }] });
    check('reports NOT_CONFIGURED', notConfigured.success === false && notConfigured.errorCode === 'NOT_CONFIGURED');
    hermesAgentService.refreshFromEnv();

    console.log(`\n=== ${passed}/${total} checks passed ===`);
    process.exitCode = passed === total ? 0 : 1;
  } finally {
    axios.post = originalPost;
  }
}

main().catch((err) => {
  console.error('Suite crashed:', err);
  process.exitCode = 1;
});
