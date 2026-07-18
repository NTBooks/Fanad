// Anthropic (Claude) provider — optional, BYO key. STUB: uses the Messages API (/v1/messages);
// structured output is done via tool-use.
//
// NOTE: Anthropic has NO embeddings API. This module intentionally exports no embed(); set
// EMBED_PROVIDER to lmstudio / openai / gemini (or wire up Voyage) when LLM_PROVIDER=anthropic.
import { getLlmConfig } from '../../settings.js';
const cfg = () => getLlmConfig().anthropic;

export async function llmStatus() {
  return {
    reachable: false, ok: false, provider: 'anthropic',
    error: cfg().apiKey ? 'anthropic provider not yet implemented' : 'ANTHROPIC_API_KEY not set',
  };
}

export async function chat() {
  throw new Error('Anthropic provider not yet implemented (TODO: POST /v1/messages; JSON output via tool-use).');
}
