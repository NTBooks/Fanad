// Server-side LM Studio client (OpenAI-compatible). The browser never calls LM Studio directly
// (CORS is off). Config comes from the live DB-backed settings (no .env needed).
import { getLlmConfig } from '../../settings.js';

const cfg = () => getLlmConfig();
const base = () => cfg().baseUrl.replace(/\/$/, '');
const authHeaders = () => (cfg().apiKey ? { Authorization: `Bearer ${cfg().apiKey}` } : {});

// Use whatever model is currently loaded in LM Studio rather than a hand-picked id (picking one here was
// unreliable — LM Studio serves the loaded model regardless). We read /v1/models (cached briefly) and
// pick a chat or embedding model from it; an explicit per-call model still wins, and the configured id is
// only a last-resort fallback if the probe fails.
let modelCache = { at: 0, list: [] };
async function loadedModels() {
  const now = Date.now();
  if (now - modelCache.at < 30000 && modelCache.list.length) return modelCache.list;
  try {
    const res = await fetch(`${base()}/models`, { headers: authHeaders() });
    if (res.ok) modelCache = { at: now, list: (await res.json()).data || [] };
  } catch { /* keep any stale list */ }
  return modelCache.list;
}
const isEmbed = (m) => m.type === 'embeddings' || /embed/i.test(m.id || '');
async function resolveModel(kind, explicit) {
  if (explicit) return explicit;
  const list = await loadedModels();
  if (list.length) {
    const pick = kind === 'embed' ? (list.find(isEmbed) || list[0]) : (list.find((m) => !isEmbed(m)) || list[0]);
    return pick.id;
  }
  return kind === 'embed' ? cfg().embedModel : cfg().chatModel; // probe failed → configured (may be blank)
}

// Health probe + model enumeration (used by the Settings screen to populate model dropdowns).
export async function llmStatus() {
  try {
    const res = await fetch(`${base()}/models`, { headers: authHeaders() });
    if (!res.ok) return { reachable: true, ok: false, provider: 'lmstudio', error: `HTTP ${res.status}` };
    const data = await res.json();
    const models = (data.data || []).map((m) => ({ id: m.id, type: m.type || null }));
    return { reachable: true, ok: true, provider: 'lmstudio', baseUrl: base(), models };
  } catch (err) {
    return { reachable: false, ok: false, provider: 'lmstudio', baseUrl: base(), error: err.message };
  }
}

// Non-streaming chat completion. Pass responseFormat for strict JSON classification.
export async function chat({ messages, model, responseFormat, maxTokens = 400, temperature = 0.2 }) {
  const body = {
    model: await resolveModel('chat', model),
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: false,
    frequency_penalty: 0.3,
    presence_penalty: 0.3,
  };
  if (responseFormat) body.response_format = responseFormat;

  const res = await fetch(`${base()}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`LM Studio returned HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  // Return the model's content verbatim. <think>…</think> stripping (and capture for the AI activity log)
  // is centralized in services/llm/index.js, so the raw reasoning can be logged before it's removed.
  return String(json.choices?.[0]?.message?.content ?? '');
}

// Embeddings for RAG. Load an embedding model alongside the chat model in LM Studio.
export async function embed(input, model) {
  const res = await fetch(`${base()}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ model: await resolveModel('embed', model), input }),
  });
  if (!res.ok) throw new Error(`LM Studio embeddings HTTP ${res.status}`);
  const json = await res.json();
  return json.data?.[0]?.embedding ?? null;
}
