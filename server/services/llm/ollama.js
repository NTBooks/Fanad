// Ollama — a local provider for running models on the same computer (https://ollama.com). Ollama exposes
// an OpenAI-compatible API at http://127.0.0.1:11434/v1, wire-identical to LM Studio, so chat + embeddings
// reuse that client over the shared local config (baseUrl/chatModel/embedModel). Only the label and the
// default base URL differ. Local → not gated by LLM_ALLOW_CLOUD. Pull an embedding model (e.g.
// `ollama pull nomic-embed-text`) for RAG; chat needs any pulled chat model.
import { getLlmConfig } from '../../settings.js';

export { chat, embed } from './lmstudio.js';

export async function llmStatus() {
  const base = getLlmConfig().baseUrl.replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/models`); // Ollama needs no auth
    if (!res.ok) return { reachable: true, ok: false, provider: 'ollama', baseUrl: base, error: `HTTP ${res.status}` };
    const data = await res.json();
    const models = (data.data || []).map((m) => ({ id: m.id, type: m.type || null }));
    return { reachable: true, ok: true, provider: 'ollama', baseUrl: base, models };
  } catch (err) {
    return { reachable: false, ok: false, provider: 'ollama', baseUrl: base, error: err.message };
  }
}
