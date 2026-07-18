// The ONE place Telegram-safe HTML markup is produced. Builders compose replies with the html`` tagged
// template and the role helpers; every dynamic interpolation is auto-escaped, every helper result is trusted
// as already-safe. The resulting string is sent to Telegram with parse_mode:HTML (per-message, opt-in via a
// reply's `html:true`) and to the web's safe-subset renderer (web/src/App.jsx renderRich).
//
// Telegram HTML supports NO colour and NO font-size — de-emphasis is structural only. Our vocabulary:
//   • <b>   — a title / header (bold on both surfaces)
//   • <i>   — de-emphasised secondary text: the category·difficulty·marks meta line, hints, a paraphrase,
//             the pagination footer. Italic on Telegram; the web styles it small + muted-grey too.
//   • <code>— a literal command/argument example in a guide ("/track weight 182"); monospace on Telegram,
//             a small muted pill on the web. Used sparingly — never around a tappable /command token.
//   • <a>   — a clickable link (a task title carrying a pasted URL). http(s) hrefs only, enforced by the
//             helper. Telegram renders it natively; Slack converts to <url|text>; CLI to an OSC-8 hyperlink.
// Discipline that keeps both channels (and the tests) happy: wrap WHOLE units (a whole title, a whole meta
// line), never insert a tag between an emoji marker and its word — that's what keeps "🔴 high" contiguous.

// Telegram's HTML parse_mode needs only these three escaped in text. Quotes are literal in text content.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
export function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ESC[c]);
}

// A Safe wrapper marks a string as already-valid markup, so html`` won't re-escape it. Helper results and
// nested html`` results are Safe; raw interpolations (plain strings/numbers) are escaped.
class Safe {
  constructor(s) { this.value = s; }
  toString() { return this.value; }
}
const wrapSafe = (s) => new Safe(s);
const isSafe = (x) => x instanceof Safe;
const render = (v) => (isSafe(v) ? v.toString() : Array.isArray(v) ? v.map(render).join('') : esc(v));

// html`…${x}…` — escape every interpolation unless it's already Safe (a helper result or a nested html``).
// Arrays are rendered element-wise (so `${rows}` of Safe fragments joins cleanly). The literal template parts
// are author-controlled and pass through verbatim — authors must NOT hand-write tags there; use the helpers.
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return wrapSafe(out);
}

// Role helpers: take raw text (or a nested Safe), escape it, wrap in the role's tag, return Safe.
const tag = (name, x) => wrapSafe(`<${name}>${render(x)}</${name}>`);
export const b = (x) => tag('b', x);     // a title / header
export const title = b;                   // semantic alias
export const i = (x) => tag('i', x);     // de-emphasised secondary text
export const em = i;                      // semantic alias
export const dim = i;                     // semantic alias for the category·difficulty·marks meta
export const code = (x) => tag('code', x); // a literal command/argument example (never a tappable token)

// A clickable link — the ONE attribute-bearing tag in the vocabulary (a task title that carries a pasted
// URL). The href lives in an attribute, so it needs `"` escaped on top of esc()'s three (a quote there
// would end the attribute and break Telegram's parse). Only plain http(s) hrefs become links; anything
// else (javascript:, data:, garbage) renders as the text alone — the helper is the scheme gate, so no
// caller can emit an unsafe href by accident.
const attrEsc = (s) => esc(s).replace(/"/g, '&quot;');
export const a = (href, x) => {
  const h = String(href ?? '').trim();
  if (!/^https?:\/\//i.test(h)) return wrapSafe(render(x));
  return wrapSafe(`<a href="${attrEsc(h)}">${render(x)}</a>`);
};

// A pre-trusted fragment: bare text that must NOT be escaped — command tokens (/start_N), indent padding,
// emoji-marker strings already known safe. Use deliberately; everything else should flow through esc/helpers.
export const raw = wrapSafe;

// Strip our markup back to visible text + unescape entities — for tests, length budgeting, and any plain
// fallback. Only undoes what esc()/the helpers produce (the whitelisted tags + the three entities).
export function stripTags(s) {
  return String(s ?? '')
    .replace(/<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre)>/gi, '')
    .replace(/<a\s+href="[^"]*">/gi, '').replace(/<\/a>/gi, '') // the one attribute-bearing tag (a() above)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}
