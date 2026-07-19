// The public /demo signup page — the one place a stranger can put THEMSELVES on the guest list. It exists
// for public-demo deployments: the owner opens it with the `demoSignupOpen` guard switch ("demo signup on"
// in chat, or Settings → Security), shares {siteUrl}/demo, and a visitor types their Telegram handle to be
// vouched in BY THE DEMO SERVICE ACCOUNT (repo getOrCreateDemoServiceUserId). That keeps the vouch tree
// honest: self-signups all show as "vouched by @demo", the owner is notified of each one, and cascade-
// revoking "demo" in the admin sweeps the whole cohort. The v31 identity pinning still applies — a signup
// admits the HANDLE once; the first account to message the bot as it gets pinned, exactly like a chat vouch.
//
// Deliberately NOT under /api: the page must render (and the OK button must work) for a logged-out visitor
// in auth mode `simple`, so both routes mount before apiAuthGate — like /web/:token (see index.js). The GET
// carries Open Graph/Twitter tags so the shared link unfurls with a title, blurb, and icon in chat apps;
// unlike the /web interstitial there is no one-time token here, so prefetching crawlers are harmless and
// the page is safe to leave indexable.
import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { getAuthConfig, getGuardConfig, getSiteConfig, getTelegramConfig } from '../settings.js';
import {
  isVouched, countActiveVouches, addVouch, getOrCreateDemoServiceUserId, DEMO_VOUCHER_NAME,
} from '../repo.js';
import { vouchHandle } from '../chat.js';
import { getBotIdentity } from '../botStatus.js';
import { notifyOwner } from '../notifyOwner.js';
import { normalizeIp } from '../ipGate.js';
import { createSignupThrottle } from '../signupThrottle.js';

// ── Per-IP abuse controls (in-memory; the shared server/signupThrottle.js primitives). A public
// unauthenticated POST must not be a free handle-enumeration or whitelist-stuffing loop.
//  · reqThrottle bounds request RATE — every request counts (including rejected ones): over(ip) ? reject :
//    record(ip). Restart resets it; the real backstops are MAX_VOUCHED_USERS and the signup switch itself.
//  · seats bounds how many seats one address may actually CLAIM — only a SUCCESSFUL new signup records (a
//    rejected or already-in submission costs nothing), so a patient abuser can't trickle junk handles in and
//    burn the whole MAX_VOUCHED_USERS guest list one at a time. 24h rolling window forgives an honest visitor
//    over time; the live cap is guard.demoSignupsPerIp (0 = off), and the scheduler reclaims no-show seats
//    within a couple hours regardless. ──
const reqThrottle = createSignupThrottle({ windowMs: 10 * 60 * 1000, max: 5 });
const seats = createSignupThrottle({ windowMs: 24 * 60 * 60 * 1000 });

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The page's backdrop is the SAME day/night ocean the web app's 🌊 theme runs (the first thing a
// demo visitor sees should look like the product). shared/oceanSim.js is written to be dual-use:
// an ES module for the web bundle, and — with its `export ` keywords stripped — a classic inline
// <script> here. Read once at module load; the file only changes on deploy (= a restart).
// The escape matters: inside a classic script element the parser ends the script at the first
// literal close sequence, comments and strings included — one in a code comment once truncated this
// page mid-file. `<\/script` is identical to the parser-safe form in JS strings and inert in comments.
const OCEAN_SRC = readFileSync(new URL('../../shared/oceanSim.js', import.meta.url), 'utf8')
  .replace(/^export /gm, '')
  .replace(/<\/script/gi, '<\\/script');

// The connected bot's Telegram @username (botStatus.js) — the "now message the bot" CTA. Null when the
// Telegram adapter is down or the deployment is Slack-only; the page falls back to generic wording.
function botUsername() {
  const id = getBotIdentity();
  return id?.platform === 'telegram' && id.username ? id.username : null;
}

// GET /demo — always renders (closed state included) so a shared link never 404s and its preview stays
// intact; only the POST actually grants anything. No user input reaches this HTML, and the only
// interpolated values (site URL, escaped anyway) are owner-set.
export function demoPageHandler(_req, res) {
  const g = getGuardConfig();
  const open = g.demoSignupOpen && !g.demoPaused;
  // Browser signup: offered whenever the portal has web registration on (auth mode simple + allowRegistration).
  // Shown in BOTH states — beside the Telegram form when open, and as the "you can still get in" path when the
  // Telegram door is closed. The link just points at the SPA (/), whose "Create an account" button appears on
  // the same allowRegistration signal. While demo mode is on that signup is TOTP-free (routes/auth.js).
  const authCfg = getAuthConfig();
  const webSignup = authCfg.mode === 'simple' && authCfg.allowRegistration;
  const siteUrl = getSiteConfig().url;
  // Link-preview tags: og:url/og:image need ABSOLUTE URLs, so they only render once the owner has set the
  // Site URL (Settings → Security → Advanced). The icon is the PWA touch icon Vite copies into web/dist.
  const preview = [
    '<meta property="og:site_name" content="Fanad">',
    '<meta property="og:title" content="Try Fanad — get it out of your head">',
    '<meta property="og:description" content="Fanad is an assignment pad for your head, living in a Telegram bot. Enter your Telegram username to join the demo.">',
    '<meta property="og:type" content="website">',
    siteUrl ? `<meta property="og:url" content="${esc(siteUrl)}/demo">` : null,
    siteUrl ? `<meta property="og:image" content="${esc(siteUrl)}/apple-touch-icon.png">` : null,
    siteUrl ? '<meta property="og:image:width" content="180">' : null,
    siteUrl ? '<meta property="og:image:height" content="180">' : null,
    '<meta name="twitter:card" content="summary">',
    '<meta name="description" content="Fanad is an assignment pad for your head, living in a Telegram bot. Enter your Telegram username to join the demo.">',
  ].filter(Boolean).join('\n');
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#08101a">
<title>Try Fanad — demo access</title>
${preview}
<style>
  /* The web app's 🌊 Ocean look, hand-rolled (this page ships no bundle): the shared day/night sea
     on a centered ≤720px column (square-ish retro pixels, fixed cost — same as the app), a dark
     glass card over it. Colors mirror the [data-theme="bokeh"] tokens in web/src/index.css. */
  body { font-family: system-ui, sans-serif; display: flex; min-height: 100vh; margin: 0; align-items: center; justify-content: center; background: #08101a; color: #e4eef3; }
  #sea { position: fixed; top: 0; bottom: 0; left: 50%; transform: translateX(-50%); width: min(100%, 720px); z-index: -1; border-inline: 1px solid rgba(130,180,210,.10); }
  #sea canvas { width: 100%; height: 100%; display: block; image-rendering: pixelated; }
  main { text-align: center; padding: 2rem; max-width: 26rem; margin: 1rem;
         background: rgba(18,32,42,.85); border: 1px solid rgba(130,180,210,.22); border-radius: 16px;
         box-shadow: inset 0 1px 0 rgba(255,255,255,.06), 0 20px 60px rgba(0,0,0,.45); }
  h1 { margin: 0 0 0.5rem; color: #d3e6f0; }
  p { color: #9db4c0; line-height: 1.5; }
  form { display: flex; gap: 0.5rem; justify-content: center; margin: 1.25rem 0 0.5rem; }
  input { font-size: 1.05rem; padding: 0.7rem 0.9rem; border: 1px solid rgba(130,180,210,.22); border-radius: 0.5rem; width: 12rem; background: rgba(27,46,60,.8); color: #e4eef3; }
  input::placeholder { color: #7e93a0; }
  input:focus { outline: 2px solid #5fb5d6; border-color: transparent; }
  button { font-size: 1.05rem; padding: 0.7rem 1.5rem; border: 0; border-radius: 0.5rem; background: #1d6b86; color: #fff; cursor: pointer; }
  button:hover { background: #2a7f9d; box-shadow: 0 0 18px rgba(95,181,214,.35); }
  button:disabled { opacity: 0.6; cursor: default; }
  .err { color: #e8a196; min-height: 1.3em; margin: 0.25rem 0 0; }
  .fine { font-size: 0.85rem; color: #7e93a0; }
  ol { text-align: left; color: #c6d5dd; line-height: 1.7; }
  a { color: #5fb5d6; }
  .beta { text-align: left; font-size: 0.85rem; color: #dfc07c; background: rgba(60,50,26,.6); border: 1px solid #6b5a2e; border-radius: 0.5rem; padding: 0.75rem 1rem; margin-top: 1.5rem; line-height: 1.5; }
  .beta code { background: rgba(60,50,26,.9); padding: 0 0.25rem; border-radius: 0.25rem; }
  .links { font-size: 0.9rem; color: #7e93a0; margin-top: 1.25rem; }
  .browser { font-size: 0.95rem; margin-top: 1.1rem; padding-top: 1.1rem; border-top: 1px solid rgba(130,180,210,.14); }
</style>
</head>
<body>
<div id="sea" aria-hidden="true"><canvas width="96" height="160"></canvas></div>
<main>
${open ? `
  <h1>Try Fanad</h1>
  <p>Fanad is an assignment pad for your head — a Telegram bot you hand your open loops to. Enter your Telegram username and you're on the guest list.</p>
  <form id="f">
    <input id="h" placeholder="@username" autocomplete="off" spellcheck="false" maxlength="33" autofocus>
    <button type="submit">OK</button>
  </form>
  <p class="err" id="e"></p>
  <p class="fine">Double-check that it&rsquo;s your username — whoever messages the bot with it first gets the access.</p>
  <div class="beta">🚧 <strong>This is a beta, and the fine print isn't written yet</strong> — there's no terms of service or privacy policy to show you, because none exist. What you tell the bot is stored on the demo server and sent to an AI model to be sorted, so keep anything sensitive out, and expect demo data to be wiped from time to time. Send the bot <code>/requestdeletion</code> whenever you want everything you've given it erased.</div>
  ${webSignup ? '<p class="browser">No Telegram?<br><a href="/">Sign up to use Fanad right here in your browser&nbsp;&rarr;</a></p>' : ''}
  <p class="links">Curious what it can do? Read the <a href="/docs/">guide</a> or the full <a href="/docs/manual.html">manual</a>.</p>
` : `
  <h1>The demo is closed</h1>
  <p>Fanad's demo isn't taking signups right now. Check back later — or ask whoever sent you this link to vouch you in directly.</p>
  ${webSignup ? '<p class="browser">You can still <a href="/">sign up to use Fanad in your browser&nbsp;&rarr;</a></p>' : ''}
  <p class="links">Meanwhile, you can read the <a href="/docs/">guide</a> or the full <a href="/docs/manual.html">manual</a>.</p>
`}
</main>
<script>
${OCEAN_SRC}
mountOcean(document.querySelector('#sea canvas'));
</script>
${open ? `<script>
const f = document.getElementById('f'), h = document.getElementById('h'), e = document.getElementById('e');
const main = document.querySelector('main');
f.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const handle = h.value.trim().replace(/^@+/, '');
  if (!/^[a-z][a-z0-9_]{2,31}$/i.test(handle)) { e.textContent = 'That doesn\\u2019t look like a Telegram username (letters, numbers, underscores).'; return; }
  const btn = f.querySelector('button');
  btn.disabled = true; e.textContent = '';
  try {
    const res = await fetch('/demo', { method: 'post', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { e.textContent = data.error || 'Something went wrong — try again in a bit.'; btn.disabled = false; return; }
    const at = '@' + data.handle;
    const bot = data.bot
      ? '<a href="https://t.me/' + data.bot + '" rel="noopener">@' + data.bot + '</a>'
      : 'the bot (ask whoever sent you this link for its @name)';
    main.innerHTML = '<h1>' + (data.already ? at + ' is already in \\uD83D\\uDC4D' : 'You\\u2019re in, ' + at + '! \\uD83C\\uDF9F\\uFE0F') + '</h1>'
      + '<ol><li>Open Telegram.</li><li>Start a chat with ' + bot + '.</li>'
      + '<li>Send it anything on your mind — try \\u201Cbuy milk tomorrow\\u201D.</li></ol>'
      + '<p class="fine">Your first message locks the access to your account.</p>'
      + '<p class="links">While you wait, the <a href="/docs/manual.html">manual</a> covers everything it can do.</p>';
  } catch {
    e.textContent = 'That didn\\u2019t go through — check your connection and try again.';
    btn.disabled = false;
  }
});
</script>` : ''}
</body>
</html>`);
}

// POST /demo — the actual grant: validate the handle, run the SAME public-safety gates the chat vouch
// command applies to non-owners (freeze switch, global seat cap — the per-user cap and depth rules don't
// translate: the service account isn't a guest spending invites, and the owner opted into this door
// explicitly), then vouch the handle in as the demo service account and tell the owner. Idempotent:
// a handle that's already in (seed allowlist or active vouch) gets the success instructions again
// rather than an error — retrying the form must never strand a real user.
export function demoRequestHandler(req, res) {
  const g = getGuardConfig();
  if (!g.demoSignupOpen || g.demoPaused) {
    return res.status(403).json({ error: 'Demo signups are closed right now.' });
  }
  const ip = normalizeIp(req.ip);
  if (reqThrottle.over(ip)) {
    return res.status(429).json({ error: 'Too many requests from your address — try again in a few minutes.' });
  }
  reqThrottle.record(ip); // every request that reaches here counts against the rate window
  const handle = vouchHandle(req.body?.handle);
  if (!handle) {
    return res.status(400).json({ error: 'That doesn’t look like a Telegram username (letters, numbers, underscores; starts with a letter).' });
  }
  const seeds = (getTelegramConfig().allowedUsername || '').toLowerCase().split(/[,\s]+/).map((u) => u.replace(/^@/, '')).filter(Boolean);
  if (seeds.includes(handle) || isVouched(handle)) {
    return res.json({ ok: true, already: true, handle, bot: botUsername() });
  }
  if (g.vouchFrozen) {
    return res.status(403).json({ error: 'New invites are paused right now — try again later.' });
  }
  const { maxVouchedUsers } = config.limits;
  if (maxVouchedUsers && countActiveVouches('telegram') >= maxVouchedUsers) {
    return res.status(403).json({ error: 'The guest list is full — try again another day.' });
  }
  // Per-address seat cap: only genuine new signups count against it (we're past the already-in short-circuit),
  // so an honest visitor can fix a typo but nobody can quietly hoard the guest list from one address. The
  // limit is owner-tunable live in Settings → Security (guard blob), defaulting to the DEMO_SIGNUPS_PER_IP env.
  if (g.demoSignupsPerIp && seats.count(ip) >= g.demoSignupsPerIp) {
    return res.status(429).json({ error: "You've added a few usernames from here already — message the bot to activate one, or try again later." });
  }
  addVouch({ username: handle, platform: 'telegram', voucherUserId: getOrCreateDemoServiceUserId(), voucherUsername: DEMO_VOUCHER_NAME });
  seats.record(ip);
  const seatsUsed = countActiveVouches('telegram');
  notifyOwner(`🎟️ Demo signup: @${handle} vouched themselves in via /demo — ${seatsUsed}${maxVouchedUsers ? `/${maxVouchedUsers}` : ''} seats used.`);
  return res.json({ ok: true, handle, bot: botUsername() });
}
