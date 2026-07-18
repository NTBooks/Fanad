// Programmatic guard on RAW USER TEXT at the point it's sent to the LLM — and only there. Stored data is
// never touched: the verbatim message is snapshotted before routing, and tasks keep `original_text` intact
// (capture §3), so what the user typed is always retrievable exactly as typed. This strips the characters
// an "illegal entry" would need to smuggle structure into a prompt (tags, braces, fences, escapes) and caps
// the length, without flattening meaning: emoji (mood detection reads them), accents, and everyday
// punctuation (@ # $ % & …) all pass through untouched. A REMOVE-list, deliberately not an allowlist.
const CONTROL_RE = new RegExp(
  '[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F'          // C0/C1 controls (\t and \n stay — they're whitespace, collapsed below)
  + '\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]', // zero-width, bidi overrides, BOM
  'g',
);
const MARKUP_RE = /[<>{}[\]`|\\~^]/g; // tag/JSON/fence/escape characters — none carry meaning in plain speech

export function sanitizeForLlm(text, { maxChars = 600 } = {}) {
  let s = String(text ?? '')
    .replace(CONTROL_RE, '')
    .replace(MARKUP_RE, ' ')
    .replace(/[^\S\n]+/g, ' ')      // collapse space/tab runs (newlines carry structure — keep them)
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (s.length > maxChars) {
    s = s.slice(0, maxChars);
    const cut = s.lastIndexOf(' ');
    if (cut > maxChars * 0.6) s = s.slice(0, cut); // prefer a word boundary, unless it costs too much
    s = s.trimEnd();
  }
  return s;
}
