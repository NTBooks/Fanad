// Google Gemini provider — optional, BYO key. Sends data off-device (opt-in; gated by LLM_ALLOW_CLOUD).
// Gemini's REST API differs from OpenAI's: chat messages map to `contents` + `systemInstruction`, and
// strict JSON uses generationConfig.responseMimeType + responseSchema (not OpenAI's response_format).
// generativelanguage.googleapis.com — generateContent (chat) + embedContent (embeddings).
import { getLlmConfig } from '../../settings.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const cfg = () => getLlmConfig().gemini;
const headers = () => ({ 'Content-Type': 'application/json', 'x-goog-api-key': cfg().apiKey });
// Always bound the network wait: a blackholed egress (firewall/VPN dropping packets) makes a bare fetch
// hang for the OS connect timeout (~minutes), which freezes the Settings probe and the heartbeat. Fail fast.
const TIMEOUT = { status: 8000, chat: 30000, embed: 15000 };

// Gemini's responseSchema is an OpenAPI-3 subset — it rejects JSON-Schema-isms like `additionalProperties`
// and `$schema` (every schema we send sets additionalProperties:false). Strip those recursively; keep the
// structural keywords Gemini accepts (type / properties / required / items / enum / description).
const SCHEMA_DROP = new Set(['additionalProperties', '$schema']);
function cleanSchema(node) {
  if (Array.isArray(node)) return node.map(cleanSchema);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (SCHEMA_DROP.has(k)) continue;
      out[k] = cleanSchema(v);
    }
    return out;
  }
  return node;
}

export async function llmStatus() {
  if (!cfg().apiKey) return { reachable: false, ok: false, provider: 'gemini', error: 'No API key saved — paste your Gemini key and Save.' };
  try {
    const res = await fetch(`${BASE}/models`, { headers: headers(), signal: AbortSignal.timeout(TIMEOUT.status) });
    if (!res.ok) return { reachable: true, ok: false, provider: 'gemini', error: `HTTP ${res.status}` };
    const data = await res.json();
    // Mirror lmstudio's shape so the Settings model dropdowns populate. Tag embedding models so the
    // embed-model picker can prefer them; null otherwise (chat-capable).
    const models = (data.models || []).map((m) => ({
      id: String(m.name || '').replace(/^models\//, ''),
      type: (m.supportedGenerationMethods || []).includes('embedContent') ? 'embeddings' : null,
    }));
    return { reachable: true, ok: true, provider: 'gemini', model: cfg().chatModel, models };
  } catch (e) {
    const error = e.name === 'TimeoutError' ? 'Timed out reaching Gemini (check the box has internet egress).' : e.message;
    return { reachable: false, ok: false, provider: 'gemini', error };
  }
}

export async function chat({ messages, model, responseFormat, maxTokens = 400, temperature = 0.2 }) {
  // system → systemInstruction; user/assistant → contents (assistant is 'model' in Gemini's vocabulary).
  const systemParts = [];
  const contents = [];
  for (const m of messages || []) {
    if (m.role === 'system') { systemParts.push({ text: m.content }); continue; }
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
  }
  const body = { contents, generationConfig: { maxOutputTokens: maxTokens, temperature } };
  if (systemParts.length) body.systemInstruction = { parts: systemParts };
  if (responseFormat?.json_schema?.schema) {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = cleanSchema(responseFormat.json_schema.schema);
  }

  const id = model || cfg().chatModel;
  // Gemini 2.5+ "thinking" models spend the (small) output budget on hidden reasoning before emitting any
  // text, so a short structured call (steps, classify, deadline) comes back as an empty candidate — which is
  // exactly the "/guess → no guess" failure, and silently degrades every other JSON call too. Our calls are
  // well-specified extractions that need no chain-of-thought, so turn thinking OFF. Only send the field when
  // the model looks thinking-capable (2.5+ / "thinking"); pre-2.5 models reject the unknown field with a 400.
  if (/gemini-(?:2\.5|[3-9])|thinking/i.test(id)) {
    body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  const res = await fetch(`${BASE}/models/${id}:generateContent`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT.chat),
  });
  if (!res.ok) {
    // Carry Google's own error text (e.g. "prepayment credits are depleted", an invalid-key message) onto
    // the thrown error so callers can tell the user WHY a call failed instead of a blank "couldn't help".
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* non-JSON body */ }
    const e = new Error(`Gemini HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    e.status = res.status;
    throw e;
  }
  const json = await res.json();
  // No candidate (e.g. safety block / finishReason without content) → '' so callers fall back / retry. Log
  // the reason (MAX_TOKENS, SAFETY, RECITATION…) so a silently-empty completion is diagnosable, not a mystery.
  const cand = json.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
  if (!text) {
    const reason = cand?.finishReason || json.promptFeedback?.blockReason;
    if (reason && reason !== 'STOP') console.error(`Gemini returned no text (${reason}) for model ${id}.`);
  }
  return text;
}

export async function embed(input, model) {
  const id = model || cfg().embedModel;
  const res = await fetch(`${BASE}/models/${id}:embedContent`, {
    method: 'POST', headers: headers(), signal: AbortSignal.timeout(TIMEOUT.embed),
    body: JSON.stringify({ model: `models/${id}`, content: { parts: [{ text: String(input) }] } }),
  });
  if (!res.ok) throw new Error(`Gemini embeddings HTTP ${res.status}`);
  const json = await res.json();
  return json.embedding?.values ?? null;
}
