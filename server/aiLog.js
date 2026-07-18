// In-memory ring buffer of recent AI (LLM) calls — the data behind the optional "AI activity log" the
// operator flips on in Settings to SEE what the model is actually doing: each call's purpose, the prompt
// sent, the raw reply (including any <think> reasoning), how long it took, and whether it succeeded or fell
// back. It also records a structured "suggest" event for /whatdo (candidate scores + decided-vs-fallback),
// which is what answers "why is the recommendation random?".
//
// Unlike debugLog.js (a dev-only console tee gated by the DEBUG_LOG env var), this is gated by a LIVE DB
// setting (settings.js ai_log) so it can be toggled without a restart. It keeps a strictly bounded amount of
// data — capped entry COUNT and per-field SIZE — so it never grows without limit. It stores prompt/response
// content (your task text) and is served over the app's existing (unauthenticated) local API, so it's OFF by
// default — same privacy caveat as DEBUG_LOG.
import { getAiLogConfig } from './settings.js';

const MAX = 150;        // ring-buffer size; oldest entries drop off
const FIELD_CAP = 4000; // max chars kept per text field (prompt/response/reasoning) — keeps the log small

const buffer = [];
let seq = 0;

export function isAiLogOn() {
  try { return getAiLogConfig().enabled === true; } catch { return false; }
}

const cap = (s) => {
  if (s == null || s === '') return '';
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str.length > FIELD_CAP ? `${str.slice(0, FIELD_CAP)}… [+${str.length - FIELD_CAP} more chars]` : str;
};

// Flatten a chat `messages` array into a compact, readable transcript for the log.
function promptText(prompt) {
  if (Array.isArray(prompt)) return prompt.map((m) => `[${m.role}] ${m.content}`).join('\n\n');
  return prompt == null ? '' : String(prompt);
}

function push(entry) {
  buffer.push({ seq: ++seq, t: Date.now(), ...entry });
  if (buffer.length > MAX) buffer.shift();
}

// Record one LLM call. No-op unless the operator turned the log on. Never throws — logging must never break
// the LLM call path.
export function recordAiCall({
  kind = 'chat', purpose = '', provider = '', model = '', ms = 0,
  ok = true, error = null, prompt = '', response = '', reasoning = '', meta = null,
} = {}) {
  if (!isAiLogOn()) return;
  try {
    push({
      kind,
      purpose,
      provider,
      model,
      ms: Math.round(ms),
      ok,
      error: error ? String(error.message || error) : null,
      prompt: cap(promptText(prompt)),
      response: cap(response),
      reasoning: cap(reasoning),
      meta,
    });
  } catch { /* never let capture break logging */ }
}

// Record a structured non-chat event (e.g. the recommendation decision: candidate scores + whether the LLM
// chose or we fell back). Stored under `meta` so the viewer can pretty-print it.
export function recordAiEvent(kind, data = {}) {
  if (!isAiLogOn()) return;
  try {
    push({ kind, purpose: kind, provider: '', model: '', ms: 0, ok: true, error: null, prompt: '', response: '', reasoning: '', meta: data });
  } catch { /* ignore */ }
}

// Return entries newer than `since` (a seq), plus the latest seq so the client can poll incrementally.
export function getAiLog(since = 0) {
  return { logs: buffer.filter((e) => e.seq > since), seq };
}

export function clearAiLog() {
  buffer.length = 0;
  return { ok: true, seq };
}
