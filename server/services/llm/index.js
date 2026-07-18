// LLM provider factory. Chat and embeddings may use DIFFERENT providers.
// Local (private): lmstudio (default) | ollama. Optional cloud (BYO key): openai | gemini | anthropic.
import { getLlmConfig } from '../../settings.js';
import { config } from '../../config.js';
import { recordAiCall } from '../../aiLog.js';
import { takeBudget } from '../../llmBudget.js';
import { currentLlmUserId } from './context.js';
import { acquire, release } from './limiter.js';
import * as lmstudio from './lmstudio.js';
import * as ollama from './ollama.js';
import * as openai from './openai.js';
import * as gemini from './gemini.js';
import * as anthropic from './anthropic.js';
import * as mock from './mock.js';

const providers = { lmstudio, ollama, openai, gemini, anthropic, mock };
const CLOUD = new Set(['openai', 'gemini', 'anthropic']); // send data off-device; gated by LLM_ALLOW_CLOUD

// Hard block: when cloud is disabled, cloud providers can't run at all — even if the DB or env selects one.
// This is the real privacy boundary; the Settings UI/write-path checks are just the friendly front for it.
function guardCloud(name) {
  if (CLOUD.has(name) && !config.llm.cloudEnabled) {
    throw new Error(`Cloud LLM provider '${name}' is disabled (set LLM_ALLOW_CLOUD to enable it).`);
  }
}

function pick(name, role) {
  const p = providers[name];
  if (!p) throw new Error(`Unknown ${role}: '${name}' (use lmstudio | ollama | openai | gemini | anthropic).`);
  return p;
}

// Reasoning models wrap their chain-of-thought in <think>…</think>. We strip it here — centrally, for ALL
// providers — instead of inside each provider, so the AI activity log can capture the reasoning BEFORE it's
// removed. Callers still receive only the clean, visible answer (unchanged contract). Providers that don't
// emit <think> (openai/gemini/mock) just pass through with a trim.
const THINK_RE = /<think>([\s\S]*?)<\/think>/gi;
export function splitThink(text) {
  const s = String(text ?? '');
  const reasoning = [];
  let m;
  THINK_RE.lastIndex = 0;
  while ((m = THINK_RE.exec(s)) !== null) reasoning.push(m[1].trim());
  return { visible: s.replace(THINK_RE, '').trim(), reasoning: reasoning.join('\n\n') };
}

// Chat → the configured chat provider. `opts.purpose` is an optional label (intent / classify / suggest …)
// for the AI activity log; it's stripped before reaching the provider. Returns the visible answer (think
// reasoning removed). The call is timed and recorded to the AI log when the operator has it on.
// guardCloud runs SYNCHRONOUSLY (not async) so the cloud hard-block throws at the factory, before any work.
export function chat(opts = {}) {
  const name = getLlmConfig().provider;
  guardCloud(name);
  // Per-user daily budget — same sync throw-at-the-factory contract as guardCloud, so an over-budget call
  // costs nothing (no provider work, no queue slot). Identity comes from the ALS seam (context.js).
  takeBudget(currentLlmUserId(), opts.purpose || 'chat');
  return chatLogged(name, opts);
}
async function chatLogged(name, opts) {
  const { purpose = '', ...rest } = opts;
  const model = rest.model || getLlmConfig().chatModel || '';
  const started = Date.now();
  try {
    // Global concurrency gate: excess calls FIFO-queue here (the ms timing then includes the wait — that's
    // the latency the user actually felt). An LLM_BUSY overflow throws BEFORE a slot is held, so release()
    // only runs after a successful acquire.
    const raw = await acquire().then(async () => {
      try { return await pick(name, 'LLM provider').chat(rest); } finally { release(); }
    });
    const { visible, reasoning } = splitThink(raw);
    recordAiCall({ kind: 'chat', purpose, provider: name, model, ms: Date.now() - started, ok: true, prompt: rest.messages, response: visible, reasoning });
    return visible;
  } catch (err) {
    recordAiCall({ kind: 'chat', purpose, provider: name, model, ms: Date.now() - started, ok: false, error: err, prompt: rest.messages });
    throw err;
  }
}

// Embeddings → the configured embed provider. Anthropic exposes no embed() (no embeddings API). Logged too
// (lightweight) so the AI log reveals whether embeddings actually fire — the suspected-dead similarity term.
// guardCloud + the no-embed-support check stay SYNCHRONOUS (the runtime hard-block contract; see test).
export function embed(input, model) {
  const name = getLlmConfig().embedProvider;
  guardCloud(name);
  const p = pick(name, 'embedding provider');
  if (typeof p.embed !== 'function') {
    throw new Error(`Embedding provider '${name}' has no embeddings support (Anthropic has none) — use lmstudio, ollama, openai, or gemini.`);
  }
  takeBudget(currentLlmUserId(), 'embedding'); // same budget pool as chat — an embed is a provider call too
  return embedLogged(name, p, input, model);
}
async function embedLogged(name, p, input, model) {
  const usedModel = model || getLlmConfig().embedModel || '';
  const started = Date.now();
  try {
    const vec = await acquire().then(async () => {
      try { return await p.embed(input, model); } finally { release(); }
    });
    recordAiCall({
      kind: 'embed', purpose: 'embedding', provider: name, model: usedModel, ms: Date.now() - started, ok: true,
      prompt: typeof input === 'string' ? input : '', response: vec ? `vector[${vec.length}]` : 'null',
      meta: { dims: vec?.length || 0 },
    });
    return vec;
  } catch (err) {
    recordAiCall({ kind: 'embed', purpose: 'embedding', provider: name, model: usedModel, ms: Date.now() - started, ok: false, error: err, prompt: typeof input === 'string' ? input : '' });
    throw err;
  }
}

export function llmStatus() {
  const name = getLlmConfig().provider;
  // Report (don't throw) so /health and the Settings probe stay informative when cloud is off.
  if (CLOUD.has(name) && !config.llm.cloudEnabled) {
    return { reachable: false, ok: false, provider: name, error: 'Cloud providers are disabled (set LLM_ALLOW_CLOUD to enable).' };
  }
  return pick(name, 'LLM provider').llmStatus();
}
