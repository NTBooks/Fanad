import { useEffect, useState } from 'react';
import * as api from './api.js';

// The GLOBAL module switches (OWNER only): enable/disable each module for the WHOLE deployment — release
// features over time, or gate one. This is the layer ABOVE each person's opt-in (ModulesSection below): a
// module disabled here is off AND invisible for every non-owner, while the owner keeps access to preview it
// before releasing. Writes the same global `system_modules` blob the bot's "system enable|disable <mod>"
// command flips; the server bumps the web config version so open browsers refresh their available list.
// Labels mirror the bot's MODULE_LABEL (server/chat.js); order mirrors OPTIN_FEATURES (server/settings.js).
const MODULES = [
  ['notes', 'Notes'], ['lists', 'Lists'], ['metrics', 'Metrics'], ['diet', 'Diet'], ['vouch', 'Vouch'],
  ['notebook', 'Notebooks'], ['timer', 'Timer'], ['journal', 'Journal'], ['batches', 'Batches'],
  ['homeassistant', 'Home Assistant'],
];

export default function SystemModulesSection() {
  const [sys, setSys] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getSystemModules().then(setSys).catch((e) => setError(`System modules failed to load: ${e.message}`));
  }, []);

  async function toggle(key, enabled) {
    setSys((s) => ({ ...s, [key]: enabled }));
    setSaved(false); setError(null);
    try { setSys(await api.saveSystemModules({ [key]: enabled })); setSaved(true); }
    catch (e) { setSys((s) => ({ ...s, [key]: !enabled })); setError(e.message); } // revert the optimistic flip
  }

  if (!sys) return error ? <p className="err">⚠ {error}</p> : <p className="hint">Loading…</p>;
  return (
    <div className="tg-section">
      <h3>System modules (all users)</h3>
      <p className="hint">Enable or disable a module for the <strong>whole deployment</strong> — release features
        over time, or gate one. A disabled module is hidden and unavailable for <strong>everyone but you</strong>,
        so you can preview it before releasing. This is separate from your own on/off below. In chat you can also
        say <code>system</code> or <code>system disable journal</code>.</p>
      {MODULES.map(([key, label]) => (
        <label className="check" key={key}>
          <input type="checkbox" checked={sys[key] === true} onChange={(e) => toggle(key, e.target.checked)} />
          {label} <span className="sub">— {sys[key] === true ? 'available to everyone' : 'disabled system-wide'}</span>
        </label>
      ))}
      {saved && <span className="ok">Saved ✓</span>}
      {error && <p className="err">⚠ {error}</p>}
    </div>
  );
}
