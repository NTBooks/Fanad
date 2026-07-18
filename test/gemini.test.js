// Gemini provider translates OpenAI-shaped calls to Google's generativelanguage REST API. We stub fetch
// so this runs offline (no key / network): the value is asserting the request we BUILD and the response we
// PARSE — system→systemInstruction, role remap, responseFormat→responseSchema (additionalProperties stripped),
// :generateContent / :embedContent endpoints, and the x-goog-api-key header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-gemini-'));
process.env.KEK = Buffer.alloc(32, 9).toString('base64');
process.env.LLM_ALLOW_CLOUD = '1';
process.env.LLM_PROVIDER = 'gemini';
process.env.EMBED_PROVIDER = 'gemini';
process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_CHAT_MODEL = 'gemini-2.0-flash';
process.env.GEMINI_EMBED_MODEL = 'text-embedding-004';

const { migrate } = await import('../server/db.js');
const llm = await import('../server/services/llm/index.js');
migrate();

const realFetch = global.fetch;
function stub(response) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts, body: opts?.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => response };
  };
  return calls;
}

const SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'pick', strict: true,
    schema: {
      type: 'object', additionalProperties: false, required: ['task_id'],
      properties: { task_id: { type: 'integer' }, kind: { type: 'string', enum: ['a', 'b'] } },
    },
  },
};

test('chat: messages → contents/systemInstruction, schema translated, response parsed', async () => {
  const calls = stub({ candidates: [{ content: { parts: [{ text: '{"task_id":7}' }] } }] });
  try {
    const out = await llm.chat({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      responseFormat: SCHEMA, maxTokens: 120, temperature: 0.3,
    });
    assert.equal(out, '{"task_id":7}');

    const { url, opts, body } = calls[0];
    assert.match(url, /\/models\/gemini-2\.0-flash:generateContent$/);
    assert.equal(opts.headers['x-goog-api-key'], 'test-key');
    // system pulled out; user/assistant remapped (assistant → 'model').
    assert.deepEqual(body.systemInstruction, { parts: [{ text: 'be brief' }] });
    assert.deepEqual(body.contents, [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi' }] },
    ]);
    assert.equal(body.generationConfig.maxOutputTokens, 120);
    assert.equal(body.generationConfig.temperature, 0.3);
    // structured output: OpenAI wrapper gone, additionalProperties stripped, enum/required kept.
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    const rs = body.generationConfig.responseSchema;
    assert.equal(rs.additionalProperties, undefined);
    assert.deepEqual(rs.required, ['task_id']);
    assert.deepEqual(rs.properties.kind.enum, ['a', 'b']);
  } finally { global.fetch = realFetch; }
});

test('chat: a 2.5+ "thinking" model gets thinking turned OFF (so short JSON calls never come back empty)', async () => {
  const calls = stub({ candidates: [{ content: { parts: [{ text: '{"task_id":1}' }] } }] });
  try {
    await llm.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'gemini-2.5-flash', responseFormat: SCHEMA, maxTokens: 280 });
    assert.deepEqual(calls[0].body.generationConfig.thinkingConfig, { thinkingBudget: 0 }, 'thinking disabled on 2.5');
  } finally { global.fetch = realFetch; }
});

test('chat: a pre-2.5 model is NOT sent thinkingConfig (older models reject the field)', async () => {
  const calls = stub({ candidates: [{ content: { parts: [{ text: '{"task_id":1}' }] } }] });
  try {
    await llm.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'gemini-2.0-flash', responseFormat: SCHEMA });
    assert.equal(calls[0].body.generationConfig.thinkingConfig, undefined, 'no thinkingConfig on 2.0');
  } finally { global.fetch = realFetch; }
});

test('chat: an empty candidate (safety block) still returns "" so callers fall back', async () => {
  const calls = stub({ candidates: [{ finishReason: 'SAFETY' }] });
  try {
    const out = await llm.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'gemini-2.5-flash' });
    assert.equal(out, '', 'no throw; empty string preserves the fall-back contract');
    assert.ok(calls.length === 1);
  } finally { global.fetch = realFetch; }
});

test('chat: an HTTP error carries Google\'s own message + status (so callers can say "out of credits")', async () => {
  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { code: 429, message: 'Your prepayment credits are depleted.', status: 'RESOURCE_EXHAUSTED' } }) });
  try {
    await llm.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'gemini-2.0-flash' });
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.status, 429);
    assert.match(e.message, /prepayment credits are depleted/);
  } finally { global.fetch = realFetch; }
});

test('embed: hits :embedContent and returns embedding.values', async () => {
  const calls = stub({ embedding: { values: [0.1, 0.2, 0.3] } });
  try {
    const vec = await llm.embed('some text');
    assert.deepEqual(vec, [0.1, 0.2, 0.3]);
    const { url, body } = calls[0];
    assert.match(url, /\/models\/text-embedding-004:embedContent$/);
    assert.deepEqual(body.content, { parts: [{ text: 'some text' }] });
    assert.equal(body.model, 'models/text-embedding-004');
  } finally { global.fetch = realFetch; }
});

test('llmStatus: lists models and tags embedding-capable ones', async () => {
  stub({ models: [
    { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
  ] });
  try {
    const st = await llm.llmStatus();
    assert.equal(st.ok, true);
    assert.equal(st.provider, 'gemini');
    assert.deepEqual(st.models, [
      { id: 'gemini-2.0-flash', type: null },
      { id: 'text-embedding-004', type: 'embeddings' },
    ]);
  } finally { global.fetch = realFetch; }
});
