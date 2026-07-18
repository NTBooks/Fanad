// Terminal (ANSI) output formatting — the CLI sibling of shared/slack-format.js. ALL terminal-specific
// knowledge lives here (never in richtext.js), so Telegram's test-frozen HTML output can never regress
// because of the CLI.
//
// The brain builds replies as Telegram-safe HTML via richtext.js: only whitelisted wrapper tags, and
// exactly `& < >` escaped to entities. Converting for a terminal is: swap each tag for an SGR escape,
// and (unlike Slack, which keeps them) DECODE the three entities — a terminal has no markup to protect,
// the user should read `a & b`, not `a &amp; b`.
//
// Style choices: NO italic ever — Windows conhost can't render it, and legacy terminals
// show garbage — so <i>/<em> (richtext's "de-emphasised secondary text") map to DIM, which is exactly
// the visual role richtext gives them. <code>/<pre> go cyan (a readable "literal" color everywhere).
// Strikethrough keeps SGR 9 (poorly-supported terminals simply ignore it — harmless).
import { stripTags } from './richtext.js';

export { stripTags };

const SGR = {
  b: ['\x1b[1m', '\x1b[22m'], strong: ['\x1b[1m', '\x1b[22m'],
  i: ['\x1b[2m', '\x1b[22m'], em: ['\x1b[2m', '\x1b[22m'],
  u: ['\x1b[2m', '\x1b[22m'], ins: ['\x1b[2m', '\x1b[22m'],
  s: ['\x1b[9m', '\x1b[29m'], strike: ['\x1b[9m', '\x1b[29m'], del: ['\x1b[9m', '\x1b[29m'],
  code: ['\x1b[36m', '\x1b[39m'], pre: ['\x1b[36m', '\x1b[39m'],
};

const decodeEntities = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// richtext HTML → ANSI-styled plain text. Tags swap for SGR pairs; entities decode to their characters.
// <a href> becomes an OSC-8 hyperlink (Windows Terminal, iTerm2, kitty…): terminals that don't speak OSC-8
// ignore the escape and just show the text — nothing is lost, the URL simply isn't tappable there.
export function htmlToAnsi(s) {
  const linked = String(s ?? '').replace(
    /<a\s+href="([^"]*)">([\s\S]*?)<\/a>/gi,
    (_m, href, text) => `\x1b]8;;${decodeEntities(href.replace(/&quot;/g, '"'))}\x1b\\${text}\x1b]8;;\x1b\\`,
  );
  const swapped = linked.replace(
    /<(\/?)(b|strong|i|em|u|ins|s|strike|del|code|pre)>/gi,
    (_m, slash, tag) => (SGR[tag.toLowerCase()] || ['', ''])[slash ? 1 : 0],
  );
  return decodeEntities(swapped);
}

// One call site for "render a reply for the terminal": HTML replies (html:true) convert to ANSI (or,
// with colors off — NO_COLOR, pipes, dumb terminals — strip to plain text); plain replies pass through
// verbatim either way. Mirrors slack-format's toMrkdwn gate on the reply's `html` flag.
export function toAnsi(text, isHtml, colors = true) {
  if (!isHtml) return String(text ?? '');
  return colors ? htmlToAnsi(text) : stripTags(text);
}
