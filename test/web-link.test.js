// /web — the chat→browser bridge: an authorized Telegram/Slack user asks the bot for a one-time link
// that opens the web UI signed in as them. Covers the three layers: the "Site URL" setting (advanced,
// env-default precedence + normalization), the one-time token store (single-use, hashed, identity-checked),
// and the command + click target (gating on Site URL / web login / root; a read-only GET interstitial so
// link previews can't spend the token, the button's POST doing the cookie mint, 410 on reuse).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-web-link-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
migrate();
const { getSiteConfig, setSiteConfig, setAuthConfig } = await import('../server/settings.js');
const { createWebLinkToken, consumeWebLinkToken, peekWebLinkToken, resolveSession, WEB_LINK_TTL_MS } = await import('../server/auth.js');
const { webLinkPageHandler, webLinkLoginHandler } = await import('../server/routes/auth.js');
const { handleMessage } = await import('../server/chat.js');
const { getOrCreateTelegramUser, ROOT_USER_ID } = await import('../server/repo.js');

const SITE = 'https://fanad.example.com';
const tgUid = getOrCreateTelegramUser(777001, 'frida');
const LINK_RE = /https:\/\/fanad\.example\.com\/web\/([A-Za-z0-9_-]+)/;

const webVia = async (userId, channel) =>
  (await handleMessage({ userId, text: '/web', channel })).reply;

// ── Site URL setting ──

test('site url: blank by default, normalized on save, cleared with blank', () => {
  assert.equal(getSiteConfig().url, '');
  assert.equal(setSiteConfig({ url: ' https://fanad.example.com// ' }).url, SITE);
  assert.equal(setSiteConfig({ url: '' }).url, '');
});

// ── One-time tokens ──

test('web-link token: redeems exactly once, for the minted user', () => {
  const token = createWebLinkToken(tgUid);
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/); // url-safe, no percent-encoding needed in the link
  assert.equal(consumeWebLinkToken(token), tgUid);
  assert.equal(consumeWebLinkToken(token), null); // single-use
});

test('web-link token: garbage and absent tokens redeem to null', () => {
  assert.equal(consumeWebLinkToken('not-a-real-token'), null);
  assert.equal(consumeWebLinkToken(null), null);
  assert.equal(consumeWebLinkToken(''), null);
});

test('web-link token: peek never consumes (the interstitial GET must be repeatable)', () => {
  const token = createWebLinkToken(tgUid);
  assert.equal(peekWebLinkToken(token), true);
  assert.equal(peekWebLinkToken(token), true); // any number of peeks…
  assert.equal(consumeWebLinkToken(token), tgUid); // …and the token still redeems
  assert.equal(peekWebLinkToken(token), false); // spent → peek agrees with consume
  assert.equal(peekWebLinkToken('not-a-real-token'), false);
  assert.equal(peekWebLinkToken(null), false);
});

test('web-link ttl is short (a link is clicked right away or not at all)', () => {
  assert.ok(WEB_LINK_TTL_MS <= 15 * 60000, `TTL ${WEB_LINK_TTL_MS}ms is longer than 15 minutes`);
});

// ── The /web command (gating in order: channel → Site URL → web login → root) ──

test('/web on the web channel points back to chat, mints nothing', async () => {
  setSiteConfig({ url: SITE });
  setAuthConfig({ mode: 'simple' });
  const r = await webVia(tgUid, 'web');
  assert.match(r, /already in the browser/i);
  assert.doesNotMatch(r, LINK_RE);
});

test('/web without a Site URL: the owner gets the Settings hint, a guest falls through', async () => {
  setSiteConfig({ url: '' });
  setAuthConfig({ mode: 'simple' });
  const r = await webVia(ROOT_USER_ID, 'telegram');
  assert.match(r, /Site URL/);
  assert.doesNotMatch(r, /\/web\/[A-Za-z0-9_-]+/);
  // Admin-settings hints are owner-only: for a guest the word behaves as if the surface didn't exist —
  // bare "web" files as a task, "/web" lands on the unknown-command hub.
  const bare = (await handleMessage({ userId: tgUid, text: 'web', channel: 'telegram' })).reply;
  assert.doesNotMatch(String(bare), /Site URL/);
  assert.match(String(bare), /Filed/i);
  const slash = await webVia(tgUid, 'telegram');
  assert.doesNotMatch(String(slash), /Site URL/);
  assert.match(String(slash), /don't know that one/i);
});

test('/web with web login off: the owner gets the Settings hint, a guest falls through', async () => {
  setSiteConfig({ url: SITE });
  setAuthConfig({ mode: 'none' });
  const r = await webVia(ROOT_USER_ID, 'telegram');
  assert.match(r, /login is off/i);
  assert.doesNotMatch(r, LINK_RE);
  const bare = (await handleMessage({ userId: tgUid, text: 'web', channel: 'telegram' })).reply;
  assert.doesNotMatch(String(bare), /login is off/i);
  assert.match(String(bare), /Filed/i);
});

test('/web refuses root (2FA must not be bypassable from chat)', async () => {
  setSiteConfig({ url: SITE });
  setAuthConfig({ mode: 'simple' });
  const r = await webVia(ROOT_USER_ID, 'telegram');
  assert.match(r, /root operator/i);
  assert.doesNotMatch(r, LINK_RE);
});

test('/web mints a working link for a Telegram user (and Slack gets the same path)', async () => {
  setSiteConfig({ url: SITE });
  setAuthConfig({ mode: 'simple' });
  const r = await webVia(tgUid, 'telegram');
  const m = LINK_RE.exec(r);
  assert.ok(m, `no link in reply: ${r}`);
  assert.equal(consumeWebLinkToken(m[1]), tgUid); // the link's token belongs to the asker

  const slack = await webVia(tgUid, 'slack');
  assert.ok(LINK_RE.test(slack), `no link in slack reply: ${slack}`);
});

test('/web replies carry a ✕ dismiss (the link shouldn’t linger in the chat once spent)', async () => {
  setSiteConfig({ url: SITE });
  setAuthConfig({ mode: 'simple' });
  const hasClose = (out) => (out.buttons || []).flat().some((b) => b.data === 'm:hide:x');
  assert.ok(hasClose(await handleMessage({ userId: tgUid, text: '/web', channel: 'telegram' })), 'link message has a ✕');
  setAuthConfig({ mode: 'none' }); // the "can't do it" notes are one-shot informational too (owner-only now)
  assert.ok(hasClose(await handleMessage({ userId: ROOT_USER_ID, text: '/web', channel: 'telegram' })), 'login-off note has a ✕');
  setAuthConfig({ mode: 'simple' });
});

// ── The click target: GET (interstitial, read-only) + POST (the exchange) on /web/:token ──

function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: null, redirectedTo: null,
    status(c) { this.statusCode = c; return this; },
    type() { return this; },
    send(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    redirect(url) { this.redirectedTo = url; },
  };
}
const fakeReq = (token) => ({ params: { token }, ip: '127.0.0.1', headers: {}, secure: false });

test('interstitial: GET serves a self-posting button page and never spends the token', () => {
  const token = createWebLinkToken(tgUid);
  for (let i = 0; i < 3; i++) { // a link preview may fetch the URL several times before the real tap
    const res = fakeRes();
    webLinkPageHandler(fakeReq(token), res);
    assert.equal(res.statusCode, 200);
    assert.match(String(res.body), /<form method="post">/i); // no action attr → posts back to the same URL
    assert.match(String(res.body), /location\.replace\('\/'\)/); // JS path replaces this page in back-history
    assert.match(String(res.body), /visibilityState === 'visible'/); // auto-proceeds, but only once actually looked at
    assert.doesNotMatch(String(res.body), new RegExp(token)); // the token never appears in the page body
    assert.equal(res.headers['Set-Cookie'], undefined); // reading the page signs nothing in
  }
  assert.equal(consumeWebLinkToken(token), tgUid); // still redeemable after all those GETs
});

test('interstitial: a spent or unknown token gets a plain 410', () => {
  const token = createWebLinkToken(tgUid);
  consumeWebLinkToken(token);
  for (const bad of [token, 'not-a-real-token']) {
    const res = fakeRes();
    webLinkPageHandler(fakeReq(bad), res);
    assert.equal(res.statusCode, 410);
    assert.match(String(res.body), /expired or was already used/i);
  }
});

test('exchange: a fresh token sets an ACTIVE session cookie for the chat user and redirects home', () => {
  const res = fakeRes();
  webLinkLoginHandler(fakeReq(createWebLinkToken(tgUid)), res);
  assert.equal(res.redirectedTo, '/');
  const cookie = /fanad_session=([^;]+)/.exec(res.headers['Set-Cookie'] || '');
  assert.ok(cookie, 'no session cookie set');
  const s = resolveSession(decodeURIComponent(cookie[1]));
  assert.equal(s.userId, tgUid);
  assert.equal(s.state, 'active');
});

test('exchange: a reused or unknown token gets a plain 410, no cookie', () => {
  const token = createWebLinkToken(tgUid);
  webLinkLoginHandler(fakeReq(token), fakeRes()); // first click spends it
  const res = fakeRes();
  webLinkLoginHandler(fakeReq(token), res); // second click
  assert.equal(res.statusCode, 410);
  assert.match(String(res.body), /expired or was already used/i);
  assert.equal(res.headers['Set-Cookie'], undefined);
  assert.equal(res.redirectedTo, null);
});
