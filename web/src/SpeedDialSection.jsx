import { useEffect, useState } from 'react';
import * as api from './api.js';

// Accounts & Speed Dial (OWNER only, Settings → Access). The Telegram whitelist as an EXPANDABLE list: every
// allowed handle (allowlist ∪ vouches ∪ pads) is a row you can open to give that person a Home Assistant
// "speed dial" — numbers 1-9, each firing one owner-authored command against the house (the guest only ever
// sends a digit, so their input is never free text to HA). 0 is NOT a firable button — it's the reserved
// "show my pad" key — so the editor lists 1-9 only. Optionally LIMIT an account to speed dial only (no
// tasks/chat). Speed dial needs the HA connection (Channels tab); the form disables with a banner until then.
const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const emptySlots = () => Object.fromEntries(SLOTS.map((n) => [n, { label: '', command: '', commandOff: '' }]));

export default function SpeedDialSection() {
  const [data, setData] = useState(null);   // { accounts, houseConnected }
  const [open, setOpen] = useState(null);    // expanded username
  const [draft, setDraft] = useState(null);  // { speedDialOnly, slots: {n:{label,command}} }
  const [newUser, setNewUser] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [shareTtl, setShareTtl] = useState(7);   // 1 | 7 | 30 days (no non-expiring link)
  const [shareLabel, setShareLabel] = useState('');
  const [minted, setMinted] = useState(null);    // { url, expiresAt, hadSiteUrl } — shown ONCE after generating
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(() => new Set()); // slot numbers whose editor is open (rows start compact)

  const load = () => api.getAccounts().then(setData).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, []);

  function expand(acct) {
    if (open === acct.username) { setOpen(null); setDraft(null); return; }
    const slots = emptySlots();
    let moved = null;
    for (const s of acct.slots) {
      let n = s.slot;
      if (n === 0) {
        // Slot 0 was retired from the editor (it's the reserved "show my pad" key, not a firable button).
        // Relocate any saved command to the first free 1-9 so it isn't silently lost on the next Save.
        const free = SLOTS.find((k) => !acct.slots.some((x) => x.slot === k) && !slots[k].command);
        if (free == null) continue;
        n = free; moved = free;
      }
      slots[n] = { label: s.label || '', command: s.command || '', commandOff: s.commandOff || '' };
    }
    setDraft({ speedDialOnly: acct.speedDialOnly, slots });
    setEditing(new Set(moved != null ? [moved] : []));
    setOpen(acct.username);
    setMsg(moved != null ? `Moved your old #0 to #${moved} — number 0 just shows the pad now. Save to keep it.` : null);
    setMinted(null); setShareLabel(''); setShareTtl(7); setCopied(false);
  }

  const setSlot = (n, p) => setDraft((d) => ({ ...d, slots: { ...d.slots, [n]: { ...d.slots[n], ...p } } }));
  const toggleEdit = (n) => setEditing((s) => { const next = new Set(s); if (next.has(n)) next.delete(n); else next.add(n); return next; });

  async function addAccount() {
    const u = newUser.trim().replace(/^@+/, '');
    if (!u) return;
    setBusy(true); setMsg(null);
    try { await api.addAccount(u); setNewUser(''); await load(); setMsg(`@${u} added — they can reach the bot.`); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }

  async function save(username) {
    setBusy(true); setMsg(null);
    const slots = SLOTS
      .map((n) => ({ slot: n, label: draft.slots[n].label.trim(), command: draft.slots[n].command.trim(), commandOff: draft.slots[n].commandOff.trim() }))
      .filter((s) => s.command);
    try {
      const res = await api.savePad(username, { speedDialOnly: draft.speedDialOnly, slots });
      setData(res); setMsg(`Saved @${username}.`); setOpen(null); setDraft(null);
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }

  async function remove(username) {
    if (!window.confirm(`Remove @${username}'s speed-dial pad? Their bot access is unchanged (revoke that below).`)) return;
    setBusy(true); setMsg(null);
    try { const res = await api.removePad(username); setData(res); setOpen(null); setDraft(null); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }

  // Fire the command TYPED in the row right now (not the saved slot), so the owner can try a row — ON or OFF —
  // before saving. `which` picks the on/off field of a toggle; the tag only shows for a toggle to avoid noise.
  async function test(username, n, which = 'on') {
    const s = draft?.slots?.[n] || {};
    const command = ((which === 'off' ? s.commandOff : s.command) || '').trim();
    const tag = (s.commandOff || '').trim() ? ` ${which}` : '';
    setMsg(`Testing #${n}${tag}…`);
    try { const r = await api.testSlot(username, n, command); setMsg(r.ok ? `🏠 #${n}${tag}: ${r.speech}` : `#${n}${tag} failed: ${r.error}`); }
    catch (e) { setMsg(e.message); }
  }

  // Mint a no-login "remote control" link for this saved pad. The raw URL is shown ONCE (the server keeps only
  // its hash), so we surface it with a copy button; the refreshed accounts carry the active-link list.
  async function generateShare(username) {
    setBusy(true); setMsg(null); setMinted(null); setCopied(false);
    try {
      const res = await api.mintShareLink(username, { ttlDays: shareTtl, label: shareLabel.trim() });
      setData(res);
      setMinted({ url: res.url || (window.location.origin + res.path), expiresAt: res.expiresAt, hadSiteUrl: !!res.url });
      setShareLabel('');
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }

  async function copyLink() {
    if (!minted) return;
    try { await navigator.clipboard.writeText(minted.url); setCopied(true); }
    catch { setMsg('Copy failed — select the link and copy it manually.'); }
  }

  async function revokeShare(username, id) {
    if (!window.confirm('Turn off this link? Anyone holding it loses access immediately.')) return;
    setBusy(true); setMsg(null);
    try { const res = await api.revokeShareLink(username, id); setData(res); if (minted) setMinted(null); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }

  const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  // Open a print-ready sheet of this person's numbers so the host can hand them a physical card
  // ("1 = Kitchen lights…"). Client-side — no auth/new-tab concerns; prints the SAVED pad (a.slots).
  function printSheet(a) {
    const slots = (a.slots || []).slice().sort((x, y) => x.slot - y.slot);
    if (!slots.length) return;
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const bot = data?.botUsername || null; // the Telegram bot to add + message (onboards the guest); null if unknown
    const cells = slots.map((s) => {
      const toggle = !!(s.commandOff && s.commandOff.trim());
      return `
      <div class="cell">
        <div class="num">${s.slot}</div>
        <div class="txt">
          <div class="lbl">${esc(s.label || s.command)}${toggle ? ' <span class="tog">on / off</span>' : ''}</div>
          ${!toggle && s.label && s.command ? `<div class="cmd">${esc(s.command)}</div>` : ''}
        </div>
      </div>`;
    }).join('');
    const doc = `<!doctype html><html><head><meta charset="utf-8">
      <title>Speed Dial — @${esc(a.username)}</title>
      <style>
        *{box-sizing:border-box}
        body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;margin:32px}
        h1{margin:0;font-size:26px}
        .sub{color:#555;margin:2px 0 20px;font-size:15px}
        .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
        .cell{display:flex;align-items:center;gap:16px;border:2px solid #111;border-radius:14px;padding:14px 18px}
        .num{font-size:44px;font-weight:800;line-height:1;width:56px;text-align:center;flex:0 0 auto}
        .lbl{font-size:20px;font-weight:700}
        .tog{font-size:12px;font-weight:700;color:#0f766e;border:1px solid #0f766e;border-radius:999px;padding:1px 8px;margin-left:8px;vertical-align:middle}
        .cmd{font-size:12px;color:#666;margin-top:2px}
        .start{margin-top:22px;padding:14px 16px;border:2px dashed #0f766e;border-radius:12px;font-size:15px;line-height:1.5;color:#222}
        .start .bot{font-weight:800;color:#0f766e;white-space:nowrap}
        .start .note{display:block;margin-top:6px;font-size:12px;color:#666}
        .foot{margin-top:20px;color:#555;font-size:13px}
        button{margin-top:18px;padding:9px 18px;font-size:14px;border:1px solid #111;border-radius:9px;background:#fff;cursor:pointer}
        @media print{body{margin:12mm} button{display:none} .foot{margin-top:16px}}
      </style></head>
      <body>
        <h1>⚡ Speed Dial</h1>
        <p class="sub">for <strong>@${esc(a.username)}</strong>${bot ? ` — message <strong>@${esc(bot)}</strong> on Telegram, then text it a number` : ' — text just the number to the bot to run it'}.</p>
        <div class="grid">${cells}</div>
        <div class="start">${bot
          ? `<strong>First time?</strong> Open Telegram, search for <span class="bot">@${esc(bot)}</span>, tap <em>Start</em>, and send it a quick “hi”. It’ll reply with your buttons. After that, just text a number (like <strong>1</strong>) any time — or tap the button it shows.<span class="note">Set a @username in your Telegram settings first, so the bot recognizes you.</span>`
          : `<strong>First time?</strong> On Telegram, open the bot your host set up for you, tap <em>Start</em>, and send it a quick “hi”. It’ll reply with your buttons. Then just text a number (like <strong>1</strong>) any time — or tap the button it shows.`}</div>
        <p class="foot">Each number runs one Home Assistant command your host set up. A number marked “on / off” switches that device — press it again to turn it back.</p>
        <button onclick="window.print()">Print</button>
        <script>window.onload=function(){setTimeout(function(){try{window.print()}catch(e){}},150)}<\/script>
      </body></html>`;
    const w = window.open('', '_blank');
    if (!w) { setMsg('Allow pop-ups to print the sheet.'); return; }
    w.document.write(doc);
    w.document.close();
    w.focus();
  }

  if (!data) return <p className="hint">Loading…</p>;
  const { accounts, houseConnected, loginOn } = data;

  const sourceLabel = (a) => {
    if (a.sources.includes('allowlist')) return 'allowlisted';
    if (a.voucher) return `vouched by ${a.voucher === 'owner' ? 'owner' : `@${a.voucher}`}`;
    return 'speed dial';
  };

  return (
    <div className="tg-section">
      <h3>Accounts &amp; speed dial</h3>
      <p className="hint">Everyone allowed to use the Telegram bot. Expand a person to give them a
        <strong> Home Assistant speed dial</strong> — numbers 0-9, each firing one command you set. You can also
        limit an account to speed dial only (no tasks or chat).</p>
      {!houseConnected && (
        <p className="bad">Home Assistant isn't connected — set the URL &amp; token in the Channels tab to use speed dial.</p>
      )}
      <div className="sd-add">
        <input value={newUser} onChange={(e) => setNewUser(e.target.value)} placeholder="@username"
          onKeyDown={(e) => { if (e.key === 'Enter') addAccount(); }} />
        <button className="primary" onClick={addAccount} disabled={busy || !newUser.trim()}>Add account</button>
      </div>
      {accounts.length === 0 && <p className="sub">No accounts yet — add one above.</p>}
      {accounts.map((a) => (
        <div key={a.username} className="sd-account">
          <div className="sd-head" onClick={() => expand(a)} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') expand(a); }}>
            <span className="sd-chevron">{open === a.username ? '▾' : '▸'}</span>
            <span className="vouch-who">@{a.username}</span>
            <span className="sub">{sourceLabel(a)} · {a.linked ? 'active' : 'not messaged yet'}</span>
            <span className="sd-badges">
              {a.slots.length > 0 && <span className="sd-badge">⚡{a.slots.length}</span>}
              {a.speedDialOnly && <span className="sd-badge" title="limited to speed dial">🔒</span>}
              {a.slots.length > 0 && (
                <button className="sd-print" title="Printable sheet to hand out"
                  onClick={(e) => { e.stopPropagation(); printSheet(a); }}>🖨 Sheet</button>
              )}
            </span>
          </div>
          {open === a.username && draft && (
            <div className="sd-body">
              <label className="check">
                <input type="checkbox" checked={draft.speedDialOnly}
                  onChange={(e) => setDraft({ ...draft, speedDialOnly: e.target.checked })} />
                Limit to speed dial only <span className="sub">— they can only use their pad, no tasks or chat</span>
              </label>
              <div className="sd-grid">
                {SLOTS.map((n) => {
                  const slot = draft.slots[n];
                  const isToggle = !!slot.commandOff.trim();
                  const isOpen = editing.has(n);
                  const filled = !!slot.command.trim();
                  const preview = slot.label.trim() || slot.command.trim();
                  return (
                    <div key={n} className={`sd-slot${isToggle ? ' toggle' : ''}${isOpen ? ' editing' : ''}`}>
                      <div className="sd-slot-head" role="button" tabIndex={0}
                        onClick={() => toggleEdit(n)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleEdit(n); } }}>
                        <span className="sd-num">{n}</span>
                        {isOpen
                          ? <span className="sd-preview editing">Editing…</span>
                          : (<>
                              <span className={`sd-preview${filled ? '' : ' empty'}`}>{filled ? preview : 'empty'}</span>
                              {isToggle && <span className="sd-tog-badge">on / off</span>}
                            </>)}
                        <span className="sd-edit-btn">{isOpen ? 'Done' : (filled ? 'Edit' : 'Set')}</span>
                      </div>
                      {isOpen && (
                        <div className="sd-slot-fields">
                          <input className="sd-label" value={slot.label} placeholder="label (e.g. King Boo)"
                            onChange={(e) => setSlot(n, { label: e.target.value })} />
                          <input className="sd-cmd" value={slot.command}
                            placeholder={isToggle ? 'ON command — e.g. turn on king boo' : 'command — e.g. turn off the kitchen lights'}
                            onChange={(e) => setSlot(n, { command: e.target.value })} />
                          <input className="sd-cmd sd-cmd-off" value={slot.commandOff}
                            placeholder="OFF command (optional) — makes it a toggle"
                            onChange={(e) => setSlot(n, { commandOff: e.target.value })} />
                          <div className="sd-slot-actions">
                            <button className="ghost" disabled={!houseConnected || !slot.command.trim()}
                              onClick={() => test(a.username, n, 'on')}>Test</button>
                            <button className="ghost sd-test-off" disabled={!houseConnected || !slot.commandOff.trim()}
                              onClick={() => test(a.username, n, 'off')} title="Test the OFF command">Test off</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="settings-foot">
                <button className="ghost danger" onClick={() => remove(a.username)} disabled={busy}>Remove pad</button>
                <button className="primary" onClick={() => save(a.username)} disabled={busy}>Save pad</button>
              </div>

              <div className="sd-remote">
                <h4>Share a remote-control link</h4>
                <p className="sub">Text a guest a link to just these buttons — no login, no Telegram account.
                  {' '}The link controls only this pad and expires on its own.</p>
                {!loginOn && (
                  <p className="bad">Turn on <strong>web login</strong> (Settings → Security) before sharing a link.
                    {' '}Without it, anyone who can reach this address can use the whole app, not just these buttons.</p>
                )}
                {a.slots.length === 0 ? (
                  <p className="sub">Save at least one number above before you can share it.</p>
                ) : (
                  <>
                    <div className="sd-remote-form">
                      <input className="sd-remote-label" value={shareLabel} placeholder="who's it for? (optional)"
                        maxLength={80} disabled={!loginOn} onChange={(e) => setShareLabel(e.target.value)} />
                      <select value={shareTtl} disabled={!loginOn} onChange={(e) => setShareTtl(Number(e.target.value))}>
                        <option value={1}>Expires in 1 day</option>
                        <option value={7}>Expires in 7 days</option>
                        <option value={30}>Expires in 30 days</option>
                      </select>
                      <button className="primary" onClick={() => generateShare(a.username)} disabled={busy || !loginOn}>Generate link</button>
                    </div>
                    {minted && (
                      <div className="sd-minted">
                        <p className="sub">Here's the link — copy it now, it won't be shown again. Expires {fmtDate(minted.expiresAt)}.</p>
                        <div className="sd-minted-row">
                          <input readOnly value={minted.url} onFocus={(e) => e.target.select()} />
                          <button className="ghost" onClick={copyLink}>{copied ? 'Copied ✓' : 'Copy'}</button>
                        </div>
                        {!minted.hadSiteUrl && (
                          <p className="sub">Tip: set a <strong>Site URL</strong> in Security so this link works away from your network.</p>
                        )}
                      </div>
                    )}
                    {a.shares && a.shares.length > 0 && (
                      <ul className="sd-remotes">
                        {a.shares.map((s) => (
                          <li key={s.id}>
                            <span className="sd-remote-name">{s.label || 'Remote link'}</span>
                            <span className="sub">{s.expiresAt ? `expires ${fmtDate(s.expiresAt)}` : 'never expires'}</span>
                            <button className="ghost danger" onClick={() => revokeShare(a.username, s.id)} disabled={busy}>Revoke</button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      ))}
      {msg && <p className="ok" style={{ marginTop: '0.5rem' }}>{msg}</p>}
    </div>
  );
}
