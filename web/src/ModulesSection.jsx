import { useEffect, useState } from 'react';
import * as api from './api.js';

// The per-user module opt-ins, shared by the owner Settings' Modules tab and the non-owner "Your
// modules" panel (UserConfig). Self-contained: loads its own state and saves through the same
// per-user endpoints the chat `optin` / `optout` commands write to.
// `filterDisabled` (set by the non-owner UserConfig) hides modules the owner has disabled system-wide —
// they're invisible to non-owners, so a checkbox for one would just bounce back. The owner's own Settings
// leaves it off so they still see every module (including "dark" ones) to preview.
// `compact` (the gutter panel) drops the heading/hint/blurbs to bare checkbox + name; `onChange` fires
// after each SUCCESSFUL save so the host can re-pull features (legend rows + header icons update live).
export default function ModulesSection({ filterDisabled = false, compact = false, onChange = null }) {
  const [features, setFeatures] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [sysMods, setSysMods] = useState(null); // system-wide availability map, only fetched when filtering
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getFeatureSettings().then(setFeatures).catch((e) => setError(`Modules failed to load: ${e.message}`));
    api.getMetricsSettings().then(setMetrics).catch((e) => setError(`Metrics failed to load: ${e.message}`));
    if (filterDisabled) api.getConfig().then((c) => setSysMods(c.systemModules || {})).catch(() => setSysMods({}));
  }, [filterDisabled]);

  // Show a module unless we're filtering AND the system-wide map (once loaded) marks it disabled.
  const avail = (key) => !filterDisabled || !sysMods || sysMods[key] !== false;

  async function toggleFeature(key, enabled) {
    setFeatures((f) => ({ ...f, [key]: enabled }));
    setSaved(false); setError(null);
    try { setFeatures(await api.saveFeatureSettings({ [key]: enabled })); setSaved(true); onChange?.(); }
    catch (e) { setFeatures((f) => ({ ...f, [key]: !enabled })); setError(e.message); } // revert the optimistic flip — the checkbox must show the persisted state
  }

  async function toggleMetrics(enabled) {
    setMetrics((mtr) => ({ ...mtr, enabled }));
    setSaved(false); setError(null);
    try { setMetrics(await api.saveMetricsSettings({ enabled })); setSaved(true); onChange?.(); }
    catch (e) { setMetrics((mtr) => ({ ...mtr, enabled: !enabled })); setError(e.message); }
  }

  if (!features) return error ? <p className="err">⚠ {error}</p> : <p className="hint">Loading…</p>;
  return (
    // compact hides the heading/hint/per-module blurbs via CSS (index.css) — same rows, quieter chrome.
    <div className={compact ? 'tg-section compact' : 'tg-section'}>
      <h3>Modules</h3>
      <p className="hint">Each optional surface is <strong>off until you switch it on</strong> — you start
        with just <strong>Tasks</strong> (always on), and add the rest when you want them. In chat you can
        also say <code>modules</code>, or <code>optin lists</code> / <code>optout lists</code>.</p>
      {avail('notes') && (
        <label className="check">
          <input type="checkbox" checked={features.notes === true} onChange={(e) => toggleFeature('notes', e.target.checked)} />
          Notes <span className="sub">— the <code>note</code> / <code>recall</code> / <code>/notes</code> inbox</span>
        </label>
      )}
      {avail('lists') && (
        <label className="check">
          <input type="checkbox" checked={features.lists === true} onChange={(e) => toggleFeature('lists', e.target.checked)} />
          Lists <span className="sub">— nestable <code>/lists</code></span>
        </label>
      )}
      {metrics && avail('metrics') && (
        <label className="check">
          <input type="checkbox" checked={!!metrics.enabled} onChange={(e) => toggleMetrics(e.target.checked)} />
          Metrics &amp; food log <span className="sub">— <code>track</code> / <code>measure</code> / <code>tally</code> / <code>eat</code> / <code>chart</code></span>
        </label>
      )}
      {avail('notebook') && (
        <label className="check">
          <input type="checkbox" checked={features.notebook === true} onChange={(e) => toggleFeature('notebook', e.target.checked)} />
          Notebooks <span className="sub">— separate, private spaces (<code>notebook &lt;name&gt;</code>); a switcher appears up top</span>
        </label>
      )}
      {avail('timer') && (
        <label className="check">
          <input type="checkbox" checked={features.timer === true} onChange={(e) => toggleFeature('timer', e.target.checked)} />
          Timer <span className="sub">— a one-shot ding (<code>timer 10 minutes</code>); nothing lands on your list</span>
        </label>
      )}
      {avail('journal') && (
        <label className="check">
          <input type="checkbox" checked={features.journal === true} onChange={(e) => toggleFeature('journal', e.target.checked)} />
          Journal <span className="sub">— a daily checklist + note with AI summaries &amp; trend spotting (<code>journal new food</code>, <code>entry</code>)</span>
        </label>
      )}
      {avail('batches') && (
        <label className="check">
          <input type="checkbox" checked={features.batches === true} onChange={(e) => toggleFeature('batches', e.target.checked)} />
          Batches <span className="sub">— one checklist + dated log per run of a process (<code>batch new sourdough</code>, <code>batch log …</code>)</span>
        </label>
      )}
      {avail('homeassistant') && (
        <label className="check">
          <input type="checkbox" checked={features.homeassistant === true} onChange={(e) => toggleFeature('homeassistant', e.target.checked)} />
          Home Assistant <span className="sub">— your timers &amp; reminders ring the house; <code>ha &lt;command&gt;</code> talks to HA</span>
        </label>
      )}
      {saved && <span className="ok">Saved ✓</span>}
      {error && <p className="err">⚠ {error}</p>}
    </div>
  );
}
