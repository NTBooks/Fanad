// Slack mrkdwn formatting — pure converter, no DB/SDK. Mirrors the discipline of shared/richtext.js: only
// the three wrapper tags change; the three HTML entities Slack also wants escaped pass through untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMrkdwn, toMrkdwn, stripTags, slashToDollar, dollarToSlash } from '../shared/slack-format.js';
import { html, b, i, code, esc, a } from '../shared/richtext.js';

test('the three richtext tags map to their mrkdwn markers', () => {
  assert.equal(htmlToMrkdwn('<b>Filed</b>'), '*Filed*');
  assert.equal(htmlToMrkdwn('<i>errand · low</i>'), '_errand · low_');
  assert.equal(htmlToMrkdwn('<code>/track weight</code>'), '`/track weight`');
});

test('HTML entities pass through untouched (Slack wants exactly & < > escaped)', () => {
  // richtext.esc turns & < > into entities; the mrkdwn converter must NOT decode them.
  const built = html`${'a & b < c > d'}`.toString();
  assert.equal(built, 'a &amp; b &lt; c &gt; d');
  assert.equal(htmlToMrkdwn(built), 'a &amp; b &lt; c &gt; d');
});

test('a contiguous emoji-marker stays intact ("🔴 high" not split)', () => {
  assert.equal(htmlToMrkdwn(i('🔴 high').toString()), '_🔴 high_');
});

test('a nested unit converts to sane mrkdwn', () => {
  const built = html`${i(html`a ${b('b')} c`)}`.toString(); // <i>a <b>b</b> c</i>
  assert.equal(htmlToMrkdwn(built), '_a *b* c_');
});

test('<a href> converts to Slack\'s native <url|text> link (not dropped like unknown tags)', () => {
  assert.equal(htmlToMrkdwn(a('https://x.com/a', 'Read me').toString()), '<https://x.com/a|Read me>');
  // a linked bold title (the task-row shape): tag swap still applies to the text half
  assert.equal(htmlToMrkdwn(b(a('https://x.com', 'T')).toString()), '*<https://x.com|T>*');
  // the attr-escaped & in the href decodes back to a working URL; a literal | is %-encoded (Slack's separator)
  assert.equal(htmlToMrkdwn(a('https://x.com/?a=1&b=2', 't').toString()), '<https://x.com/?a=1&b=2|t>');
  assert.equal(htmlToMrkdwn(a('https://x.com/a|b', 't').toString()), '<https://x.com/a%7Cb|t>');
});

test('slashToDollar leaves the URL inside a mrkdwn link alone', () => {
  assert.equal(slashToDollar('<https://x.com/foo|Read me>'), '<https://x.com/foo|Read me>');
});

test('toMrkdwn only converts when html:true', () => {
  assert.equal(toMrkdwn('<b>x</b>', true), '*x*');
  assert.equal(toMrkdwn('<b>x</b>', false), '<b>x</b>'); // plain reply passes through verbatim
});

test('stripTags is re-exported and undoes markup back to plain text', () => {
  const built = html`✓ Filed: ${b('"wash the car"')}`.toString();
  assert.equal(stripTags(built), '✓ Filed: "wash the car"');
});

test('esc + convert composes: special chars in dynamic text survive both', () => {
  const built = html`${b('a<b>&c')}`.toString(); // <b>a&lt;b&gt;&amp;c</b>
  assert.equal(htmlToMrkdwn(built), '*a&lt;b&gt;&amp;c*');
});

// ── command sigil swap ("/" ↔ "$") on the Slack edge ──
test('slashToDollar rewrites command tokens but leaves dates/paths/words alone', () => {
  assert.equal(slashToDollar('▶ /start_1 · ✓ /done_1 · 📅 /cal_1'), '▶ $start_1 · ✓ $done_1 · 📅 $cal_1');
  assert.equal(slashToDollar('`/track weight 182`'), '`$track weight 182`');   // inside a code span
  assert.equal(slashToDollar('(/cal 3)'), '($cal 3)');                         // after a paren
  assert.equal(slashToDollar('9/5 and/or http://x.com/y'), '9/5 and/or http://x.com/y'); // not commands
});

test('dollarToSlash restores the leading sigil only', () => {
  assert.equal(dollarToSlash('$forget 3'), '/forget 3');
  assert.equal(dollarToSlash('$done_1'), '/done_1');
  assert.equal(dollarToSlash('$tasks'), '/tasks');
  assert.equal(dollarToSlash('$5 to charity'), '$5 to charity');     // not a command (digit)
  assert.equal(dollarToSlash('buy milk for $5'), 'buy milk for $5'); // mid-line untouched
  assert.equal(dollarToSlash('tasks'), 'tasks');                     // no sigil
});

test('round-trips: a shown $command is accepted back as the same /command', () => {
  assert.equal(dollarToSlash(slashToDollar('/whatdo')), '/whatdo');
  assert.equal(dollarToSlash(slashToDollar('/sub_2')), '/sub_2');
});
