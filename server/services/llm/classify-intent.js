// Route free text by the organizing rule: ASK A QUESTION → run a command; MAKE A STATEMENT → file a
// task (or answer Fanad's open question). Returns { kind: 'question'|'statement', intent, confidence, args }.
// Resilient like classify.js: strict JSON, retry, then a deterministic heuristic — which is ALSO the only
// path the mock provider ever takes (mock.js returns classification JSON, never this schema), keeping
// tests and offline use deterministic.
import { chat } from './index.js';
import { intentRouterSystem } from './prompts.js';
import { sanitizeForLlm } from './sanitize.js';
import { isSuggestRequest } from '../../../shared/intent.js';

// The command intents a QUESTION can map to — mirrors the slash commands the router already handles.
// NOTE: 'help' is deliberately NOT here. It's a fixed, argument-free keyword the router catches
// deterministically (route()), so the LLM can't mistake an actionable task like "look up how to clear
// tasks" for a help request and silently swallow it.
export const INTENTS = ['whatdo', 'done', 'start', 'summary', 'tasks', 'notes', 'recall', 'mood_set'];

// Flat, all-required, primitive fields (like classify.js's SCHEMA) so strict JSON stays provider-safe.
const SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'fanad_router', strict: true,
    schema: {
      type: 'object', additionalProperties: false,
      required: ['kind', 'intent', 'confidence', 'text', 'timeframe', 'emoji'],
      properties: {
        kind: { type: 'string', enum: ['question', 'statement'] },
        intent: { type: 'string' },     // '' for a statement; else one of INTENTS
        confidence: { type: 'number' },
        text: { type: 'string' },       // residual query/reference, verbatim
        timeframe: { type: 'string' },  // for summary
        emoji: { type: 'string' },      // for mood_set
      },
    },
  },
};

const SYSTEM = intentRouterSystem(INTENTS); // text lives in prompts.js with its siblings

const stripFences = (s) => String(s).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

export function coerce(o, text = '') {
  const kind = o?.kind === 'question' ? 'question' : 'statement';
  const intent = kind === 'question' && INTENTS.includes(o?.intent) ? o.intent : null;
  const args = {};
  for (const k of ['text', 'timeframe', 'emoji']) {
    if (o?.[k] && String(o[k]).trim()) args[k] = String(o[k]).trim();
  }
  const confidence = typeof o?.confidence === 'number' ? o.confidence : (intent ? 0.7 : 0.5);
  return { kind, intent, confidence, args };
}

// Deterministic fallback — also the ONLY path the mock provider takes (its JSON has no `kind`).
export function heuristicKind(text) {
  const s = (text || '').trim();
  const low = s.toLowerCase();
  if (isSuggestRequest(s)) return { kind: 'question', intent: 'whatdo', confidence: 0.9, args: {} };
  if (/\bsummary\b/.test(low) || /^what (did|have) i\b.*\b(do|done|get|accomplish|finish)/.test(low)) {
    return { kind: 'question', intent: 'summary', confidence: 0.7, args: { timeframe: low } };
  }
  if (/^(recall\b|notes? about\b|where (is|are|did|can)\b|did i note\b)/.test(low)) {
    return { kind: 'question', intent: 'recall', confidence: 0.7, args: { text: s } };
  }
  // ("help" and friends are handled deterministically by route() before the classifier is reached.)
  if (/^(what'?s on my|what are my|show|list|see)\b[\s\S]*\b(tasks?|to.?dos?|plate|list)\b/.test(low) || /^tasks?\??$/.test(low)) {
    return { kind: 'question', intent: 'tasks', confidence: 0.75, args: {} };
  }
  if (s.endsWith('?')) return { kind: 'question', intent: 'whatdo', confidence: 0.55, args: {} };
  return { kind: 'statement', intent: null, confidence: 1, args: {} };
}

// A dead/slow model can't stall a request: race the call against a timer (unref'd so it never holds tests open).
function withTimeout(promise, ms = 8000) {
  return Promise.race([
    promise,
    new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('llm timeout')), ms); t.unref?.(); }),
  ]);
}

export async function classifyIntent(text, _ctx = {}) {
  const fallback = heuristicKind(text); // computed first → always available
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await withTimeout(chat({
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: sanitizeForLlm(text) }],
        responseFormat: SCHEMA, temperature: 0.1, maxTokens: 80, purpose: 'intent',
      }));
      const o = JSON.parse(stripFences(raw));
      if (o && (o.kind === 'question' || o.kind === 'statement')) return coerce(o, text);
    } catch (err) { lastErr = err; /* bad/foreign JSON (mock!) / error / timeout → retry, then heuristic */ }
  }
  // The heuristic downgrade is by design, but an LLM outage causing it should be diagnosable (SyntaxError
  // is the mock's expected unparseable output — stay quiet for it, or demo mode logs on every message).
  if (lastErr && !(lastErr instanceof SyntaxError)) console.error('intent classify failed — using the keyword heuristic:', lastErr.message);
  return fallback;
}
