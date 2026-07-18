// Slack output formatting — the mrkdwn sibling of shared/richtext.js. ALL Slack-specific knowledge lives
// here (never in richtext.js), so Telegram's test-frozen HTML output can never regress because of Slack.
//
// The brain builds replies as Telegram-safe HTML via richtext.js: it emits only <b>/<i>/<code> and escapes
// exactly the three chars `& < >` to entities. Slack mrkdwn happens to require the IDENTICAL three-entity
// escaping — so richtext's escaping is already correct for Slack, and converting to mrkdwn is purely a matter
// of swapping the three wrapper tags for their mrkdwn markers. Entities (&amp; &lt; &gt;) pass through
// untouched. (See "Formatting message text" — Slack uses &, <, > as control chars.)
import { stripTags } from './richtext.js';

export { stripTags };

// Tag → mrkdwn marker. In mrkdwn the OPEN and CLOSE marker are the same char (*bold*, _italic_, `code`), so
// both <b> and </b> map to '*'. We cover the full whitelist stripTags knows (not just b/i/code the builders
// use today) so any tag richtext could ever emit converts cleanly instead of leaking a raw "<tag>".
// Slack has no underline/strikethrough-vs-italic distinction beyond _italic_ and ~strike~, so u/ins fold into
// italic and s/strike/del into strike — the closest faithful rendering.
const TAG_MARK = {
  b: '*', strong: '*',
  i: '_', em: '_', u: '_', ins: '_',
  s: '~', strike: '~', del: '~',
  code: '`', pre: '`',
};

// Convert a richtext.js HTML string to Slack mrkdwn. Only the wrapper tags change; the three HTML entities
// stay escaped (which is what Slack wants). Whole-unit wrapping in richtext means a simple per-tag swap is
// correct even when a unit nests (e.g. <i>a <b>b</b></i> → _a *b*_, which Slack renders sensibly).
export function htmlToMrkdwn(s) {
  // Links first: richtext's <a href="url">text</a> becomes Slack's native <url|text>. The href arrives
  // attribute-escaped (&amp; &quot;) — decode &amp; so the URL works, but keep the mrkdwn control chars of
  // the TEXT half exactly as richtext escaped them. Must run before the tag swap below, whose fallback
  // drops unknown tags (an unhandled <a> would silently lose the link).
  const linked = String(s ?? '').replace(
    /<a\s+href="([^"]*)">([\s\S]*?)<\/a>/gi,
    (_m, href, text) => `<${href.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\|/g, '%7C')}|${text}>`,
  );
  return linked.replace(
    /<(\/?)(b|strong|i|em|u|ins|s|strike|del|code|pre)>/gi,
    (_m, _slash, tag) => TAG_MARK[tag.toLowerCase()] || '',
  );
}

// One call site for "render a reply for Slack": HTML replies (html:true) convert to mrkdwn; plain replies
// pass through verbatim. Mirrors how the Telegram adapter gates on the reply's `html` flag.
export function toMrkdwn(text, isHtml) {
  return isHtml ? htmlToMrkdwn(text) : String(text ?? '');
}

// ── command sigil: "/" on Telegram, "$" on Slack ──
// Slack RESERVES a leading "/" (it's swallowed client-side as a slash command), and the bot's own "/command"
// hints lead users to type something Slack eats. So on Slack ONLY we swap the sigil to "$": the bot SHOWS
// "$tasks"/"$done_1" (slashToDollar, on outgoing text) and ACCEPTS "$forget 3" (dollarToSlash, on an incoming
// line — restoring the "/" the brain's command patterns expect). The brain, Telegram, and web are untouched;
// this is a display/input skin on the Slack edge only. "$" is NOT reserved by Slack, so "$command" is delivered.

// Outgoing: rewrite a command token "/verb" → "$verb". Only a "/" that STARTS a token is touched — it must not
// be preceded by an alphanumeric or another "/" and must be followed by a lowercase letter — so "9/5", "and/or",
// and "http://…" are left alone, while "/done_1", "`/track …`", and "(/cal 3)" become "$…".
export function slashToDollar(s) {
  return String(s ?? '').replace(/(?<![A-Za-z0-9/])\/(?=[a-z])/g, () => '$');
}

// Incoming: if a (trimmed) line starts with the "$<letter>" command sigil, restore the leading "/" so the brain
// parses it exactly like a Telegram "/command". Only the leading sigil is touched — a "$5" or a mid-line "$" is
// left alone, so "buy milk for $5" still files as a task.
export function dollarToSlash(s) {
  return String(s ?? '').replace(/^\$(?=[a-zA-Z])/, '/');
}
