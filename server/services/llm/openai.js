// OpenAI (ChatGPT) provider — optional, BYO key. Sends data off-device (opt-in).
import { getLlmConfig } from '../../settings.js';

const BASE = 'https://api.openai.com/v1';
const cfg = () => getLlmConfig().openai;
const headers = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${cfg().apiKey}` });
// Always bound the network wait (same rationale + budgets as gemini.js): a blackholed egress makes a bare
// fetch hang for the OS connect timeout (~minutes), freezing the Settings probe, the heartbeat, and every
// chat round-trip behind it. Fail fast instead.
const TIMEOUT = { status: 8000, chat: 30000, embed: 15000 };

export async function llmStatus() {
  if (!cfg().apiKey) return { reachable: false, ok: false, provider: 'openai', error: 'OPENAI_API_KEY not set' };
  try {
    const res = await fetch(`${BASE}/models`, { headers: headers(), signal: AbortSignal.timeout(TIMEOUT.status) });
    if (!res.ok) return { reachable: true, ok: false, provider: 'openai', error: `HTTP ${res.status}` };
    return { reachable: true, ok: true, provider: 'openai', model: cfg().chatModel };
  } catch (e) {
    const error = e.name === 'TimeoutError' ? 'Timed out reaching OpenAI (check the box has internet egress).' : e.message;
    return { reachable: false, ok: false, provider: 'openai', error };
  }
}

export async function chat({ messages, model, responseFormat, maxTokens = 400, temperature = 0.2 }) {
  const body = { model: model || cfg().chatModel, messages, max_tokens: maxTokens, temperature };
  if (responseFormat) body.response_format = responseFormat; // OpenAI supports { type: 'json_schema', ... }
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT.chat),
  });
  if (!res.ok) { const e = new Error(`OpenAI HTTP ${res.status}`); e.status = res.status; throw e; }
  const json = await res.json();
  return (json.choices?.[0]?.message?.content ?? '').trim();
}

export async function embed(input, model) {
  const res = await fetch(`${BASE}/embeddings`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ model: model || cfg().embedModel, input }),
    signal: AbortSignal.timeout(TIMEOUT.embed),
  });
  if (!res.ok) throw new Error(`OpenAI embeddings HTTP ${res.status}`);
  const json = await res.json();
  return json.data?.[0]?.embedding ?? null;
}
