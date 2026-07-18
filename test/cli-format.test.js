// Terminal ANSI formatting — pure converter, no DB/Ink. Mirrors the slack-format discipline: only the
// whitelisted wrapper tags swap (for SGR escapes), and — unlike Slack — the three entities DECODE, since
// a terminal has no markup to protect. The no-italic rule is load-bearing (Windows conhost).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToAnsi, toAnsi, stripTags } from '../shared/cli-format.js';
import { html, b, i, code, a } from '../shared/richtext.js';

test('bold maps to SGR 1/22, code to cyan, and <i> maps to DIM — never SGR 3 italic', () => {
  assert.equal(htmlToAnsi('<b>Filed</b>'), '\x1b[1mFiled\x1b[22m');
  assert.equal(htmlToAnsi('<code>/track weight</code>'), '\x1b[36m/track weight\x1b[39m');
  assert.equal(htmlToAnsi('<i>errand · low</i>'), '\x1b[2merrand · low\x1b[22m');
  assert.ok(!htmlToAnsi('<i>x</i><em>y</em>').includes('\x1b[3m'), 'italic SGR must never be emitted (conhost)');
});

test('the three HTML entities DECODE for the terminal (no markup to protect)', () => {
  const built = html`${'a & b < c > d'}`.toString();
  assert.equal(built, 'a &amp; b &lt; c &gt; d');
  assert.equal(htmlToAnsi(built), 'a & b < c > d');
});

test('a nested unit converts to sane ANSI', () => {
  const built = html`${i(html`a ${b('b')} c`)}`.toString(); // <i>a <b>b</b> c</i>
  assert.equal(htmlToAnsi(built), '\x1b[2ma \x1b[1mb\x1b[22m c\x1b[22m');
});

test('<a href> becomes an OSC-8 hyperlink; the text survives on terminals that ignore OSC-8', () => {
  const out = htmlToAnsi(a('https://x.com/a', 'Read me').toString());
  assert.equal(out, '\x1b]8;;https://x.com/a\x1b\\Read me\x1b]8;;\x1b\\');
  // attr-escaped & in the href decodes back to the real URL
  const amp = htmlToAnsi(a('https://x.com/?a=1&b=2', 't').toString());
  assert.ok(amp.includes(';;https://x.com/?a=1&b=2\x1b\\'), amp);
  // stripped of escapes, only the link text remains (what a dumb terminal shows)
  assert.equal(out.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, ''), 'Read me');
});

test('toAnsi gates on html:true and falls back to stripTags when colors are off', () => {
  assert.equal(toAnsi('<b>x</b>', true), '\x1b[1mx\x1b[22m');
  assert.equal(toAnsi('<b>x</b>', false), '<b>x</b>', 'plain reply passes through verbatim');
  assert.equal(toAnsi('<b>x</b> &amp; y', true, false), 'x & y', 'NO_COLOR/pipe → plain text, entities decoded');
});

test('stripTags is re-exported and undoes markup back to plain text', () => {
  const built = html`✓ Filed: ${b('"wash the car"')}`.toString();
  assert.equal(stripTags(built), '✓ Filed: "wash the car"');
});

test('every tag stripTags knows converts cleanly instead of leaking raw markup', () => {
  const all = '<b>a</b><strong>b</strong><i>c</i><em>d</em><u>e</u><ins>f</ins><s>g</s><strike>h</strike><del>i</del><code>j</code><pre>k</pre>';
  const out = htmlToAnsi(all);
  assert.ok(!/[<>]/.test(out), `no raw angle brackets may survive: ${JSON.stringify(out)}`);
  assert.equal(out.replace(/\x1b\[[0-9;]*m/g, ''), 'abcdefghijk', 'visible text is intact');
});

test('emoji markers stay intact through the swap', () => {
  assert.equal(htmlToAnsi(i('🔴 high').toString()), '\x1b[2m🔴 high\x1b[22m');
});
