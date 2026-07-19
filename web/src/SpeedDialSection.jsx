import { useEffect, useState } from 'react';
import * as api from './api.js';

// Accounts & Speed Dial (OWNER only, Settings → Access). The Telegram whitelist as an EXPANDABLE list: every
// allowed handle (allowlist ∪ vouches ∪ pads) is a row you can open to give that person a Home Assistant
// "speed dial" — numbers 0-9, each firing one owner-authored command against the house (the guest only ever
// sends a digit, so their input is never free text to HA). Optionally LIMIT an account to speed dial only
// (no tasks/chat). Speed dial needs the HA connection (Channels tab); the form disables with a banner until then.
const SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const emptySlots = () => Object.fromEntries(SLOTS.map((n) => [n, { label: '', command: '' }]));

export default function SpeedDialSection() {
  const [data, setData] = useState(null);   // { accounts, houseConnected }
  const [open, setOpen] = useState(null);    // expanded username
  const [draft, setDraft] = useState(null);  // { speedDialOnly, slots: {n:{label,command}} }
  const [newUser, setNewUser] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.getAccounts().then(setData).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, []);

  function expand(acct) {
    if (open === acct.username) { setOpen(null); setDraft(null); return; }
    const slots = emptySlots();
    for (const s of acct.slots) slots[s.slot] = { label: s.label || '', command: s.command || '' };
    setDraft({ speedDialOnly: acct.speedDialOnly, slots });
    setOpen(acct.username);
    setMsg(null);
  }

  const setSlot = (n, p) => setDraft((d) => ({ ...d, slots: { ...d.slots, [n]: { ...d.slots[n], ...p } } }));

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
      .map((n) => ({ slot: n, label: draft.slots[n].label.trim(), command: draft.slots[n].command.trim() }))
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

  async function test(username, n) {
    setMsg(`Testing #${n}…`);
    try { const r = await api.testSlot(username, n); setMsg(r.ok ? `🏠 #${n}: ${r.speech}` : `#${n} failed: ${r.error}`); }
    catch (e) { setMsg(e.message); }
  }

  // Open a print-ready sheet of this person's numbers so the host can hand them a physical card
  // ("1 = Kitchen lights…"). Client-side — no auth/new-tab concerns; prints the SAVED pad (a.slots).
  function printSheet(a) {
    const slots = (a.slots || []).slice().sort((x, y) => x.slot - y.slot);
    if (!slots.length) return;
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const cells = slots.map((s) => `
      <div class="cell">
        <div class="num">${s.slot}</div>
        <div class="txt">
          <div class="lbl">${esc(s.label || s.command)}</div>
          ${s.label && s.command ? `<div class="cmd">${esc(s.command)}</div>` : ''}
        </div>
      </div>`).join('');
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
        .cmd{font-size:12px;color:#666;margin-top:2px}
        .foot{margin-top:24px;color:#555;font-size:13px}
        button{margin-top:18px;padding:9px 18px;font-size:14px;border:1px solid #111;border-radius:9px;background:#fff;cursor:pointer}
        @media print{body{margin:12mm} button{display:none} .foot{margin-top:16px}}
      </style></head>
      <body>
        <h1>⚡ Speed Dial</h1>
        <p class="sub">for <strong>@${esc(a.username)}</strong> — text just the number to the bot to run it.</p>
        <div class="grid">${cells}</div>
        <p class="foot">Each number runs a Home Assistant command set up for you. Text the number (for example “1”) to the bot on Telegram, or tap it if the bot shows the pad.</p>
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
  const { accounts, houseConnected } = data;

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
                Limit to speed dial only <span className="sub">— they can only use their 0-9 pad, no tasks or chat</span>
              </label>
              <div className="sd-grid">
                {SLOTS.map((n) => (
                  <div key={n} className="sd-slot">
                    <span className="sd-num">{n}</span>
                    <input className="sd-label" value={draft.slots[n].label} placeholder="label"
                      onChange={(e) => setSlot(n, { label: e.target.value })} />
                    <input className="sd-cmd" value={draft.slots[n].command} placeholder="e.g. turn off the kitchen lights"
                      onChange={(e) => setSlot(n, { command: e.target.value })} />
                    <button className="ghost" disabled={!houseConnected || !draft.slots[n].command.trim()}
                      onClick={() => test(a.username, n)}>Test</button>
                  </div>
                ))}
              </div>
              <div className="settings-foot">
                <button className="ghost danger" onClick={() => remove(a.username)} disabled={busy}>Remove pad</button>
                <button className="primary" onClick={() => save(a.username)} disabled={busy}>Save pad</button>
              </div>
            </div>
          )}
        </div>
      ))}
      {msg && <p className="ok" style={{ marginTop: '0.5rem' }}>{msg}</p>}
    </div>
  );
}
