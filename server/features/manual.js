// The Manual module (always-on — help is never gated behind an opt-in): "/manual <question>" (or the "h"
// shortcut) has the LLM answer a free-form question STRICTLY from site/manual.html. The grounding is the
// whole point: on a hosted box this must never become a general-purpose chat, so the question is sanitized
// (sanitizeForLlm), the prompt forbids anything beyond the excerpt, and off-book questions get the exact
// MANUAL_FALLBACK line. Section selection/parsing lives in services/manual.js; the prompt in prompts.js.
import { chat } from '../services/llm/index.js';
import { manualAnswerSystem, MANUAL_FALLBACK } from '../services/llm/prompts.js';
import { sanitizeForLlm } from '../services/llm/sanitize.js';
import { relevantExcerpt } from '../services/manual.js';
import { getSiteConfig } from '../settings.js';
import { clearDialogState } from '../dialog.js';
import { registerFeature } from './registry.js';

const QUESTION_MAX = 400; // one question, not an essay — also the lid on what a hosted user can inject

function manualLink() {
  const base = getSiteConfig().url;
  return `${base || ''}/docs/manual.html`;
}
const usage = () =>
  `Ask me anything about how Fanad works — “h how do I set a reminder?” · “/manual what does sleeping mean?”\n📖 The full book: ${manualLink()}`;

async function manualCommand(rest) {
  const raw = (rest || '').trim().replace(/^[,:;–—-]\s*/, '');
  if (!raw) return usage();
  const q = sanitizeForLlm(raw, { maxChars: QUESTION_MAX });
  if (!q) return usage();
  const excerpt = relevantExcerpt(q);
  if (!excerpt) return `The manual isn’t bundled with this install, so I can’t look that up — try “guide” for the built-in topic guides, or “/commands”.`;
  try {
    const answer = String(await chat({
      messages: [
        { role: 'system', content: manualAnswerSystem(excerpt) },
        { role: 'user', content: q },
      ],
      temperature: 0.2, maxTokens: 300, purpose: 'manual-qa',
    })).trim();
    if (!answer) return MANUAL_FALLBACK;
    const clipped = raw.length > QUESTION_MAX ? '\n(That was a long one — I read the first part. One short question at a time works best.)' : '';
    return `${answer}${clipped}`;
  } catch {
    // Provider down/out of credits — same graceful shape as "/guess": say so, point at the deterministic help.
    return `I couldn’t reach the model to read the manual just now — try again in a moment, or “guide” / “/commands” for the built-in help. 📖 ${manualLink()}`;
  }
}

registerFeature({
  name: 'manual',
  commands: [{
    // "/manual <question>" — and "h <question>" / bare "h", which route() expands to the slash form before
    // matching. Bare "manual" ALONE also works (usage), but "manual <words>" does not match: "manual
    // transmission lesson" must still file as a task. Always-on, so match() never consults isOn.
    match: ({ lower }) => /^\/manual(?:\s|$)/i.test(lower) || lower === 'manual',
    run: ({ userId, t }) => {
      clearDialogState(userId); // a real command escapes any open question, like every sibling
      return manualCommand(t.replace(/^\/?manual\b/i, ''));
    },
  }],
});
