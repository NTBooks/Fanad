// The Telegram-safe HTML rich-text layer (shared/richtext.js): escaping, the html`` template, role helpers,
// and stripTags. Pure module — no DB/LLM/Telegram.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, html, b, title, i, em, dim, code, raw, a, stripTags } from '../shared/richtext.js';

test('esc() escapes only the three HTML specials, not quotes', () => {
  assert.equal(esc('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
  assert.equal(esc('say “hi” and \'bye\' and "q"'), 'say “hi” and \'bye\' and "q"'); // quotes are literal in HTML text
  assert.equal(esc(null), '');
  assert.equal(esc(42), '42');
});

test('html`` escapes interpolations by default but trusts Safe fragments', () => {
  assert.equal(html`hi ${'<script>'}`.toString(), 'hi &lt;script&gt;');
  assert.equal(html`${'a & b'}`.toString(), 'a &amp; b');
  assert.equal(html`${b('x')} and ${'<y>'}`.toString(), '<b>x</b> and &lt;y&gt;'); // nested helper not re-escaped
});

test('role helpers escape their content and wrap in the right tag', () => {
  assert.equal(b('wash & dry').toString(), '<b>wash &amp; dry</b>');
  assert.equal(title('t').toString(), '<b>t</b>');         // title is an alias of b
  assert.equal(i('soft').toString(), '<i>soft</i>');
  assert.equal(em('soft').toString(), '<i>soft</i>');       // em + dim alias i
  assert.equal(dim('Home · low').toString(), '<i>Home · low</i>');
  assert.equal(code('/track weight 182').toString(), '<code>/track weight 182</code>');
});

test('helpers nest without double-escaping', () => {
  assert.equal(b(em('x & y')).toString(), '<b><i>x &amp; y</i></b>');
});

test('html`` renders an array of Safe fragments by joining them', () => {
  const rows = ['a', 'b'].map((x) => b(x));
  assert.equal(html`${rows}`.toString(), '<b>a</b><b>b</b>');
});

test('raw() passes a trusted fragment through unescaped (for command tokens / indent)', () => {
  assert.equal(html`${raw('  ')}${'1'}. ${title('t')} ${raw('/start_1')}`.toString(), '  1. <b>t</b> /start_1');
});

test('a whole meta unit keeps an emoji+word marker contiguous (the test-survival invariant)', () => {
  const s = dim('Admin · high · 🔴 high').toString();
  assert.match(s, /🔴 high/); // no tag inserted between 🔴 and its word
});

test('stripTags removes whitelisted tags and unescapes entities — round-trips visible text', () => {
  assert.equal(stripTags('<b>wash</b> · <i>Home · low</i>'), 'wash · Home · low');
  assert.equal(stripTags(esc('renew by <when> & go')), 'renew by <when> & go');
  assert.equal(stripTags(html`✓ Filed: ${title('“buy milk”')} · ${dim('Shop · low')}`.toString()), '✓ Filed: “buy milk” · Shop · low');
});

test('a() wraps text in a link with an attribute-escaped href', () => {
  assert.equal(a('https://x.com/a', 'Read me').toString(), '<a href="https://x.com/a">Read me</a>');
  // href attr escaping: & and " must be entities or the attribute (and Telegram's parse) breaks
  assert.equal(
    a('https://x.com/?q=1&r="2"', 'q').toString(),
    '<a href="https://x.com/?q=1&amp;r=&quot;2&quot;">q</a>',
  );
  assert.equal(a('https://x.com', 'a & b').toString(), '<a href="https://x.com">a &amp; b</a>'); // text still esc'd
  assert.equal(a('https://x.com', b('t')).toString(), '<a href="https://x.com"><b>t</b></a>');   // nests Safe
});

test('a() refuses non-http(s) hrefs — the text renders, no link', () => {
  assert.equal(a('javascript:alert(1)', 'click').toString(), 'click');
  assert.equal(a('data:text/html,x', 'click').toString(), 'click');
  assert.equal(a('', 'click').toString(), 'click');
  assert.equal(a(null, '<x>').toString(), '&lt;x&gt;'); // fallback text is still escaped
});

test('stripTags removes <a> (the one attribute-bearing tag) and keeps its text', () => {
  assert.equal(stripTags(b(a('https://x.com/a?b=1&c=2', 'Page title')).toString()), 'Page title');
  assert.equal(stripTags(html`1. ${b(a('https://x.com', 'T'))} rest`.toString()), '1. T rest');
});
