// Link-preview module (server/services/linkpreview.js): pure extraction/parsing/SSRF guards + the fetcher
// with a stubbed globalThis.fetch. No DB/LLM. The fetcher NEVER throws — every path returns a record whose
// `status` reports the outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  URL_RE, extractUrl, decodeEntities, parseMetaFromHtml, isBlockedAddress, assertPublicHost, fetchLinkPreview,
} from '../server/services/linkpreview.js';

// ── extractUrl ──
test('extractUrl finds a bare URL and flags isBare', () => {
  assert.deepEqual(extractUrl('https://example.com/page'), { url: 'https://example.com/page', isBare: true });
  assert.deepEqual(extractUrl('  https://example.com/page  '), { url: 'https://example.com/page', isBare: true });
});

test('extractUrl finds an embedded URL (not bare) and trims trailing sentence punctuation', () => {
  assert.deepEqual(extractUrl('read this later https://example.com/a'), { url: 'https://example.com/a', isBare: false });
  assert.deepEqual(extractUrl('(see https://example.com/a).'), { url: 'https://example.com/a', isBare: false });
  assert.equal(extractUrl('go to https://example.com/a, then home').url, 'https://example.com/a');
});

test('extractUrl ignores non-http(s) and schemeless text', () => {
  assert.equal(extractUrl('call mom'), null);
  assert.equal(extractUrl('ftp://x.com/a'), null);
  assert.equal(extractUrl('email me at a@b.com'), null);
  assert.equal(extractUrl('http:// broken'), null); // scheme with no host
});

test('URL_RE is exported and matches an http(s) URL', () => {
  assert.ok(URL_RE.test('see https://x.com'));
  assert.ok(!URL_RE.test('nope'));
});

// ── decodeEntities ──
test('decodeEntities handles named + numeric forms, passes unknown through', () => {
  assert.equal(decodeEntities('Tom &amp; Jerry'), 'Tom & Jerry');
  assert.equal(decodeEntities('a &lt;b&gt; &quot;c&quot; &#39;d&#39;'), 'a <b> "c" \'d\'');
  assert.equal(decodeEntities('caf&#233;'), 'café');
  assert.equal(decodeEntities('smile &#x1F600;'), 'smile 😀');
  assert.equal(decodeEntities('&nbsp;x'), ' x');
  assert.equal(decodeEntities('&notareal;'), '&notareal;'); // unknown named entity untouched
});

// ── parseMetaFromHtml ──
test('parseMetaFromHtml prefers og:title, then twitter:title, then <title>', () => {
  const og = '<meta property="og:title" content="OG Title"><title>Tag Title</title>';
  assert.equal(parseMetaFromHtml(og, 'https://x.com').title, 'OG Title');
  const tw = '<meta name="twitter:title" content="TW Title"><title>Tag Title</title>';
  assert.equal(parseMetaFromHtml(tw, 'https://x.com').title, 'TW Title');
  const only = '<title>Tag Title</title>';
  assert.equal(parseMetaFromHtml(only, 'https://x.com').title, 'Tag Title');
});

test('parseMetaFromHtml reads reversed attribute order and either quote style', () => {
  const rev = "<meta content='Desc here' name='description'>";
  assert.equal(parseMetaFromHtml(rev, 'https://x.com').description, 'Desc here');
});

test('parseMetaFromHtml decodes entities and collapses whitespace, caps length', () => {
  const html = '<meta property="og:title" content="A &amp; B\n  spaced">';
  assert.equal(parseMetaFromHtml(html, 'https://x.com').title, 'A & B spaced');
  const long = `<meta property="og:title" content="${'x'.repeat(300)}">`;
  assert.equal(parseMetaFromHtml(long, 'https://x.com').title.length, 200);
});

test('parseMetaFromHtml falls site back to the URL hostname when og:site_name absent', () => {
  const r = parseMetaFromHtml('<title>t</title>', 'https://news.example.com/x');
  assert.equal(r.site, 'news.example.com');
  const r2 = parseMetaFromHtml('<meta property="og:site_name" content="Example News"><title>t</title>', 'https://news.example.com/x');
  assert.equal(r2.site, 'Example News');
});

test('parseMetaFromHtml returns nulls for a doc with no metadata', () => {
  const r = parseMetaFromHtml('<html><body>hi</body></html>', 'https://x.com');
  assert.equal(r.title, null);
  assert.equal(r.description, null);
  assert.equal(r.site, 'x.com');
});

// ── isBlockedAddress ──
test('isBlockedAddress blocks loopback/private/link-local/CGN and v4-mapped v6', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.9.9', '192.168.1.50', '169.254.169.254', '100.64.0.1', '0.0.0.0', '198.18.0.1']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  assert.equal(isBlockedAddress('::1'), true);
  assert.equal(isBlockedAddress('fc00::1'), true);
  assert.equal(isBlockedAddress('fe80::1'), true);
  assert.equal(isBlockedAddress('::ffff:169.254.169.254'), true); // v4-mapped metadata endpoint
  assert.equal(isBlockedAddress('garbage'), true);               // fail closed
});

test('isBlockedAddress allows ordinary public addresses', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

// ── assertPublicHost ──
test('assertPublicHost rejects localhost and *.local without a DNS lookup', async () => {
  await assert.rejects(() => assertPublicHost('localhost'));
  await assert.rejects(() => assertPublicHost('myprinter.local'));
  await assert.rejects(() => assertPublicHost('')); // empty
});

test('assertPublicHost rejects a literal private IP host', async () => {
  await assert.rejects(() => assertPublicHost('192.168.1.50'));
  await assert.rejects(() => assertPublicHost('127.0.0.1'));
});

// ── fetchLinkPreview (stubbed fetch) ──
const realFetch = globalThis.fetch;
function stubFetch(fn) { globalThis.fetch = fn; }
function restoreFetch() { globalThis.fetch = realFetch; }

const htmlResponse = (body, headers = {}) => new Response(body, {
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
});

test('fetchLinkPreview ok path parses metadata and sets UA + manual redirect', async (t) => {
  t.after(restoreFetch);
  let seen = null;
  stubFetch(async (url, opts) => {
    seen = { url, opts };
    return htmlResponse('<meta property="og:title" content="Hello"><meta property="og:description" content="World">');
  });
  const r = await fetchLinkPreview('https://example.com/a');
  assert.equal(r.status, 'ok');
  assert.equal(r.title, 'Hello');
  assert.equal(r.description, 'World');
  assert.equal(r.finalUrl, 'https://example.com/a');
  assert.equal(seen.opts.redirect, 'manual');
  assert.match(seen.opts.headers['User-Agent'], /Fanad-LinkPreview/);
});

test('fetchLinkPreview follows a redirect but blocks one pointing at a private host', async (t) => {
  t.after(restoreFetch);
  stubFetch(async (url) => {
    if (url.includes('example.com')) {
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    }
    return htmlResponse('<title>secret</title>');
  });
  const r = await fetchLinkPreview('https://example.com/redir');
  assert.equal(r.status, 'blocked');
  assert.equal(r.title, null);
});

test('fetchLinkPreview reports timeout on an AbortError', async (t) => {
  t.after(restoreFetch);
  stubFetch(async () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; });
  const r = await fetchLinkPreview('https://example.com/slow');
  assert.equal(r.status, 'timeout');
});

test('fetchLinkPreview errors on a non-HTML content-type', async (t) => {
  t.after(restoreFetch);
  stubFetch(async () => new Response('%PDF-1.7', { status: 200, headers: { 'content-type': 'application/pdf' } }));
  const r = await fetchLinkPreview('https://example.com/file.pdf');
  assert.equal(r.status, 'error');
});

test('fetchLinkPreview errors on a non-2xx status', async (t) => {
  t.after(restoreFetch);
  stubFetch(async () => new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } }));
  const r = await fetchLinkPreview('https://example.com/missing');
  assert.equal(r.status, 'error');
});

test('fetchLinkPreview blocks a private target before any fetch', async (t) => {
  t.after(restoreFetch);
  let called = false;
  stubFetch(async () => { called = true; return htmlResponse('<title>x</title>'); });
  const r = await fetchLinkPreview('http://192.168.1.50:8123/x');
  assert.equal(r.status, 'blocked');
  assert.equal(called, false, 'must not fetch a private host');
});

test('fetchLinkPreview parses a body truncated at the byte cap', async (t) => {
  t.after(restoreFetch);
  const head = '<meta property="og:title" content="Capped">';
  const big = head + '<p>' + 'x'.repeat(200000) + '</p>';
  stubFetch(async () => htmlResponse(big));
  const r = await fetchLinkPreview('https://example.com/big', { maxBytes: 4096 });
  assert.equal(r.status, 'ok');
  assert.equal(r.title, 'Capped'); // the <head> meta survived the cap
});
