// Classify a short note into { category, effort_level, summary, detail, mood } via the configured LLM.
// "Trap more, not less" (the local LLM is slow/expensive, so capture richly in one call): the caller keeps
// the user's verbatim text separately; here the model ALSO returns a short actionable `summary` for lists,
// a fuller one-paragraph `detail` for later, and an inferred `mood` emoji. Resilient: strict JSON, retry,
// safe fallback. §3.
import { chat } from './index.js';
import { classifyTaskSystem } from './prompts.js';
import { sanitizeForLlm } from './sanitize.js';
import { CATEGORIES, EFFORT_LEVELS } from '../../../shared/categories.js';
import { extractEmojis } from '../../../shared/state.js';

// Built fresh per call (below) so a category added at runtime — see registerCategory in shared/categories.js
// — is offered to the model in BOTH the strict enum and the guide. (A module-level snapshot would freeze the
// taxonomy at import and silently exclude every later custom category.)
function buildSchema() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'fanad_classification',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'effort_level', 'summary', 'detail', 'mood'],
        properties: {
          category: { type: 'string', enum: CATEGORIES },
          effort_level: { type: 'string', enum: EFFORT_LEVELS },
          summary: { type: 'string' },   // short imperative task label for lists
          detail: { type: 'string' },    // one fuller paragraph kept for later
          mood: { type: 'string' },       // a single emoji for any feeling expressed, or ''
        },
      },
    },
  };
}

function coerce(obj) {
  return {
    category: CATEGORIES.includes(obj?.category) ? obj.category : 'other',
    effort_level: EFFORT_LEVELS.includes(obj?.effort_level) ? obj.effort_level : 'medium',
    summary: String(obj?.summary || '').trim(),
    detail: String(obj?.detail || '').trim(),
    mood: extractEmojis(String(obj?.mood || '')), // keep only emoji, drop any stray words the model adds
  };
}
const EMPTY = { category: 'other', effort_level: 'medium', summary: '', detail: '', mood: '' };
const stripFences = (s) => String(s).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

export async function classify(text) {
  // The MODEL sees the sanitized text (structure-smuggling characters out, length capped); the caller keeps
  // and stores the user's verbatim words separately — sanitizing here never touches what's retrievable.
  const messages = [{ role: 'system', content: classifyTaskSystem() }, { role: 'user', content: sanitizeForLlm(text) }];
  const schema = buildSchema();
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return coerce(JSON.parse(stripFences(await chat({ messages, responseFormat: schema, temperature: 0.1, maxTokens: 220, purpose: 'classify-task' }))));
    } catch (err) {
      lastErr = err; // bad JSON / model error — retry once, then fall through
    }
  }
  // Falling through means this capture is filed with default metadata — leave a trace so an LLM outage is
  // diagnosable (SyntaxError is the demo/mock provider's expected unparseable output; stay quiet for it).
  if (lastErr && !(lastErr instanceof SyntaxError)) console.error('classify failed — filing with default metadata:', lastErr.message);
  return { ...EMPTY };
}
