// The public "remote control" page — the no-login guest surface for a Home Assistant speed-dial pad. Speed
// dial is for the GUESTS of whoever runs Fanad: the host texts a guest a link ({siteUrl}/r/<fsd1_ token>) and
// the guest taps a few house buttons with no Telegram account and no login. A link is scoped to ONE pad, only
// fires its owner-authored slots (never free text to HA), expires, and is revocable — so a leaked link is
// bounded. The token lives only in the URL; the DB keeps its sha256 (see speeddial.js / repo.js / db.js v44).
//
// Deliberately NOT under /api: the page must render and the buttons must fire for a logged-out stranger in
// auth mode `simple`, so both routes mount before apiAuthGate — exactly like /web/:token and /demo (index.js).
// The GET is strictly side-effect-free (chat apps prefetch links to build previews; only the POST fires), and
// it's noindex/no-store because a shareable house-control link should never be cached or crawled into search.
import { resolveShare, shareRemoteData, fireShareSlot } from '../speeddial.js';
import { createSignupThrottle } from '../signupThrottle.js';
import { getAuthConfig } from '../settings.js';

// Bound how fast one link can fire the house — an unauthenticated POST must not be a hold-down flood. Keyed
// by the raw token (per-link); in-memory, resets on restart. The real backstops are the expiry + revoke.
const fireThrottle = createSignupThrottle({ windowMs: 60 * 1000, max: 30 });

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const noStore = (res) => { res.set('X-Robots-Tag', 'noindex, nofollow'); res.set('Cache-Control', 'no-store'); };

// A share link's whole premise is "only these buttons — everything ELSE on this origin is locked". That only
// holds while web login is on, so share links FAIL CLOSED at request time, not just at mint: if the operator
// drops the box back to open (auth mode 'none' — where /api is unauthenticated and USER_IMPERSONATION, if set,
// lets any caller act as any user), a live link stops working until login is back on. Checked on EVERY render
// and fire, so a link minted under login can never be used after login is turned off.
const loginOn = () => getAuthConfig().mode === 'simple';

// A minimal standalone notice page (expired / unavailable) — same chrome as the remote, no pad, no @handle.
const noticePage = (heading, body) => `<!doctype html><html lang="en"><head>${HEAD}<title>${esc(heading)}</title></head>
<body><main><header><h1>${esc(heading)}</h1></header>
<p class="banner">${esc(body)}</p>
</main></body></html>`;

// Shared <head> + look: mobile-first (a guest opens this on a phone), theme-aware light/dark, big tap targets.
const HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#0f766e">
<style>
  :root { --bg:#f2f5f7; --card:#fff; --ink:#12222b; --sub:#5b7280; --line:#d6e0e6; --accent:#0f766e; --accentink:#fff; --shadow:0 10px 30px rgba(0,0,0,.10); }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#08101a; --card:#12202a; --ink:#e4eef3; --sub:#9db4c0; --line:#254050; --accent:#1d8a86; --accentink:#fff; --shadow:0 16px 46px rgba(0,0,0,.5); }
  }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin:0; min-height:100vh; background:var(--bg); color:var(--ink);
         display:flex; flex-direction:column; align-items:center; padding:24px 16px 40px; }
  main { width:100%; max-width:26rem; }
  header { text-align:center; margin:8px 0 20px; }
  h1 { font-size:1.4rem; margin:0 0 4px; }
  .sub { color:var(--sub); font-size:.95rem; margin:0; line-height:1.45; }
  .pad { display:flex; flex-direction:column; gap:12px; }
  .key { display:flex; align-items:center; gap:16px; width:100%; text-align:left; cursor:pointer;
         background:var(--card); color:var(--ink); border:1px solid var(--line); border-radius:16px;
         padding:18px 20px; font-size:1.1rem; box-shadow:var(--shadow); transition:transform .06s ease, filter .15s ease; }
  .key:hover { filter:brightness(1.03); }
  .key:active { transform:scale(.98); }
  .key:disabled { opacity:.55; cursor:default; box-shadow:none; }
  .num { flex:0 0 auto; width:44px; height:44px; border-radius:12px; background:var(--accent); color:var(--accentink);
         display:flex; align-items:center; justify-content:center; font-size:1.5rem; font-weight:800; }
  .lbl { font-weight:650; }
  .state { margin-left:auto; flex:0 0 auto; font-size:.8rem; font-weight:700; padding:4px 11px; border-radius:999px; border:1px solid var(--line); color:var(--sub); }
  .state.on { background:var(--accent); color:var(--accentink); border-color:transparent; }
  .empty, .banner { text-align:center; color:var(--sub); background:var(--card); border:1px solid var(--line);
                    border-radius:14px; padding:20px; box-shadow:var(--shadow); line-height:1.5; }
  .banner.warn { color:#8a5a00; }
  @media (prefers-color-scheme: dark) { .banner.warn { color:#dfc07c; } }
  #say { position:fixed; left:50%; bottom:22px; transform:translateX(-50%) translateY(20px); opacity:0; pointer-events:none;
         max-width:calc(100vw - 32px); background:var(--ink); color:var(--bg); padding:12px 18px; border-radius:12px;
         font-size:.98rem; box-shadow:0 12px 30px rgba(0,0,0,.35); transition:opacity .2s ease, transform .2s ease; }
  #say.show { opacity:1; transform:translateX(-50%) translateY(0); }
  #say.bad { background:#b23b32; color:#fff; }
  footer { margin-top:26px; color:var(--sub); font-size:.8rem; text-align:center; }
  a { color:var(--accent); }
</style>`;

// GET /r/:token — the remote itself. Unknown/expired/revoked → a plain "link's done" page (200, so a preview
// crawler never sees a scary 404 and a real guest gets a clear message). No @handle is ever shown.
export function remotePageHandler(req, res) {
  noStore(res);
  // Fail closed: while the box isn't in login mode, serve no pad at all (see loginOn above).
  if (!loginOn()) {
    return res.type('html').send(noticePage('This remote is unavailable right now', 'Ask whoever shared it with you to try again shortly.'));
  }
  const share = resolveShare(req.params.token);
  if (!share) {
    return res.type('html').send(noticePage("This remote link isn't active", 'The link you followed has expired or was turned off. Ask whoever shared it with you for a fresh one.'));
  }
  const token = String(req.params.token);
  const { slots, houseConnected } = shareRemoteData(share.username);

  const body = !slots.length
    ? '<p class="empty">There are no buttons on this remote yet. Ask whoever shared it to set some up.</p>'
    : `<div class="pad">${slots.map((s) => `
        <button class="key" data-slot="${s.slot}"${s.toggle ? ' data-toggle="1"' : ''}${houseConnected ? '' : ' disabled'}>
          <span class="num">${s.slot}</span><span class="lbl">${esc(s.name)}</span>${s.toggle ? `<span class="state ${s.on ? 'on' : 'off'}">${s.on ? 'On' : 'Off'}</span>` : ''}
        </button>`).join('')}</div>`;

  const houseBanner = houseConnected ? '' : '<p class="banner warn" style="margin-bottom:16px">The house isn’t reachable right now — buttons are disabled. Try again later.</p>';

  res.type('html').send(`<!doctype html>
<html lang="en">
<head>${HEAD}
<title>Remote control</title>
</head>
<body>
<main>
  <header>
    <h1>⚡ Remote control</h1>
    <p class="sub">Tap a button to run it in the house. No account needed.</p>
  </header>
  ${houseBanner}
  ${body}
  <footer>Powered by Fanad · this link only reaches these buttons.</footer>
</main>
<div id="say" role="status" aria-live="polite"></div>
<script>
  var token = ${JSON.stringify(token)};
  var say = document.getElementById('say'), t;
  function toast(msg, bad) {
    say.textContent = msg; say.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(t); t = setTimeout(function () { say.className = say.className.replace('show', '').trim(); }, 4200);
  }
  document.querySelectorAll('.key').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      if (btn.disabled) return;
      var slot = Number(btn.getAttribute('data-slot'));
      btn.disabled = true; toast('Sending…');
      try {
        var r = await fetch('/r/' + encodeURIComponent(token) + '/fire', {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ slot: slot }),
        });
        var d = await r.json().catch(function () { return {}; });
        if (!r.ok || !d.ok) toast(d.error || 'That didn’t go through — try again.', true);
        else {
          if (btn.getAttribute('data-toggle') && typeof d.on === 'boolean') {
            var pill = btn.querySelector('.state');
            if (pill) { pill.textContent = d.on ? 'On' : 'Off'; pill.className = 'state ' + (d.on ? 'on' : 'off'); }
          }
          toast('🏠 ' + (d.speech || 'Done.'));
        }
      } catch (e) { toast('Couldn’t reach the house — check your connection.', true); }
      finally { btn.disabled = false; }
    });
  });
</script>
</body>
</html>`);
}

// POST /r/:token/fire — run one slot. JSON in ({ slot }), JSON out ({ ok, speech } | { error }). Resolves the
// token every time (no trust in the page), rate-limits per link, and only ever runs a predefined slot.
export async function remoteFireHandler(req, res) {
  noStore(res);
  if (!loginOn()) return res.status(403).json({ error: 'This remote is unavailable right now.' });
  const token = String(req.params.token || '');
  const share = resolveShare(token);
  if (!share) return res.status(403).json({ error: 'This link is no longer active.' });
  if (fireThrottle.over(token)) return res.status(429).json({ error: 'Too fast — give it a moment and try again.' });
  fireThrottle.record(token);
  const slot = Number(req.body?.slot);
  if (!Number.isInteger(slot) || slot < 0 || slot > 9) return res.status(400).json({ error: 'Pick a button.' });
  try {
    const r = await fireShareSlot(share.username, slot);
    if (!r.ok) return res.status(502).json({ error: r.text || 'The house didn’t answer.' });
    return res.json({ ok: true, speech: r.speech, name: r.name, slot: r.slot, on: r.on });
  } catch (err) {
    return res.status(502).json({ error: `Couldn’t reach the house: ${err.message}` });
  }
}
