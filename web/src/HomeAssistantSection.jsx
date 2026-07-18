import { useEffect, useState } from 'react';
import * as api from './api.js';

// Home Assistant connection panel (OWNER only, Settings → Channels): the base URL + long-lived token
// (stored encrypted server-side; never echoed back — hasToken drives the placeholder, same as Telegram),
// the ring outputs (Voice PE announce · script hook · notify push) that fire when a timer/reminder goes
// off, the Assist agent for "ha <command>", and the Local Calendar entity for "to HA calendar" pushes.
// "Load choices" pulls the pickable entities/services from HA so nothing has to be typed from memory.
export default function HomeAssistantSection() {
  const [ha, setHa] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [choices, setChoices] = useState(null); // { satellites, calendars, scripts, notifyServices }

  useEffect(() => {
    api.getHomeAssistantSettings().then((s) => setHa({ ...s, token: '' }))
      .catch((e) => setError(`Home Assistant failed to load: ${e.message}`));
  }, []);

  const patch = (p) => setHa((h) => ({ ...h, ...p }));
  const patchGroup = (g, p) => setHa((h) => ({ ...h, [g]: { ...h[g], ...p } }));

  async function save() {
    setBusy(true); setSaved(false); setError(null); setTestResult(null);
    try {
      const s = await api.saveHomeAssistantSettings(ha);
      setHa({ ...s, token: '' });
      setSaved(true);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function test() {
    setBusy(true); setError(null); setTestResult(null);
    try {
      // Save first so the test runs against what's on screen, then ring everything that's enabled.
      const s = await api.saveHomeAssistantSettings(ha);
      setHa({ ...s, token: '' });
      setTestResult(await api.testHomeAssistant());
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function discover() {
    setBusy(true); setError(null);
    try {
      const s = await api.saveHomeAssistantSettings(ha); // the URL/token on screen must reach the server first
      setHa({ ...s, token: '' });
      setChoices(await api.discoverHomeAssistant());
    } catch (e) { setError(`Couldn’t list HA entities: ${e.message}`); } finally { setBusy(false); }
  }

  // A picker when discovery ran (choose from what exists), a plain input otherwise.
  const entityInput = (value, onChange, options, placeholder) => (
    options && options.length
      ? (
        <select className="ha-pick" value={value || ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">— none —</option>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
          {value && !options.includes(value) && <option value={value}>{value}</option>}
        </select>
      )
      : <input value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
  );

  if (!ha) return error ? <p className="err">⚠ {error}</p> : null;
  return (
    <div className="tg-section">
      <h3>Home Assistant (optional)</h3>
      <p className="hint">Ring the house when a timer or reminder fires, talk to HA with <code>ha turn off
        the kitchen light</code>, and push dated tasks onto a house calendar. In HA, open your profile →
        <strong> Security</strong> and create a <em>long-lived access token</em>, then paste it here.
        (The Home Assistant <em>module</em> also has to be on — see Modules.)</p>
      <label>Base URL <span className="sub">— e.g. http://192.168.1.50:8123</span>
        <input value={ha.baseUrl || ''} onChange={(e) => patch({ baseUrl: e.target.value })} placeholder="http://homeassistant.local:8123" />
      </label>
      <label>Access token
        <input type="password" value={ha.token} onChange={(e) => patch({ token: e.target.value })}
          placeholder={ha.hasToken ? '•••••• (saved — leave blank to keep)' : 'paste the long-lived access token'} />
      </label>
      <label className="check">
        <input type="checkbox" checked={ha.enabled === true} onChange={(e) => patch({ enabled: e.target.checked })} />
        Enable Home Assistant
      </label>

      <h4>Ring outputs <span className="sub">— what happens in the house when a timer or reminder fires</span></h4>
      <label className="check">
        <input type="checkbox" checked={ha.announce?.enabled === true} onChange={(e) => patchGroup('announce', { enabled: e.target.checked })} />
        Announce on a voice satellite <span className="sub">— speaks “Timer done: pasta.”</span>
      </label>
      {ha.announce?.enabled && (
        <label>Satellite entities <span className="sub">— comma-separated assist_satellite.* ids</span>
          {choices?.satellites?.length
            ? (
              <select multiple className="ha-pick" value={ha.announce.entities || []}
                onChange={(e) => patchGroup('announce', { entities: Array.from(e.target.selectedOptions).map((o) => o.value) })}>
                {choices.satellites.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            )
            : (
              <input value={(ha.announce.entities || []).join(', ')}
                onChange={(e) => patchGroup('announce', { entities: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                placeholder="assist_satellite.kitchen_assist_satellite" />
            )}
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={ha.script?.enabled === true} onChange={(e) => patchGroup('script', { enabled: e.target.checked })} />
        Run a script <span className="sub">— wire a siren, lights, anything; it gets <code>kind</code> + <code>title</code> variables</span>
      </label>
      {ha.script?.enabled && (
        <label>Script entity
          {entityInput(ha.script.entity, (v) => patchGroup('script', { entity: v }), choices?.scripts, 'script.fanad_alarm')}
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={ha.notify?.enabled === true} onChange={(e) => patchGroup('notify', { enabled: e.target.checked })} />
        Push to phones <span className="sub">— HA companion-app notify services</span>
      </label>
      {ha.notify?.enabled && (
        <label>Notify services <span className="sub">— comma-separated, without the “notify.” prefix</span>
          {choices?.notifyServices?.length
            ? (
              <select multiple className="ha-pick" value={ha.notify.services || []}
                onChange={(e) => patchGroup('notify', { services: Array.from(e.target.selectedOptions).map((o) => o.value) })}>
                {choices.notifyServices.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            )
            : (
              <input value={(ha.notify.services || []).join(', ')}
                onChange={(e) => patchGroup('notify', { services: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                placeholder="mobile_app_your_phone" />
            )}
        </label>
      )}

      <h4>Calendar &amp; chat <span className="sub">— optional extras</span></h4>
      <label>House calendar <span className="sub">— a Local Calendar entity; enables the “to HA calendar” push on dated tasks</span>
        {entityInput(ha.calendar?.entity, (v) => patch({ calendar: { entity: v } }), choices?.calendars, 'calendar.house')}
      </label>
      <label>Assist agent id <span className="sub">— optional; blank uses HA’s default agent for “ha &lt;command&gt;”</span>
        <input value={ha.agentId || ''} onChange={(e) => patch({ agentId: e.target.value })} placeholder="(default agent)" />
      </label>

      <div className="settings-foot">
        {saved && <span className="ok">Saved ✓</span>}
        <button className="ghost" onClick={discover} disabled={busy}>Load choices</button>
        <button className="ghost" onClick={test} disabled={busy}>Save &amp; test</button>
        <button className="primary" onClick={save} disabled={busy}>Save Home Assistant</button>
      </div>
      {testResult && (
        <p className="hint">
          {testResult.connection?.ok
            ? <span className="ok">Connected ✓ — HA {testResult.connection.version}{testResult.connection.locationName ? ` · ${testResult.connection.locationName}` : ''}. </span>
            : <span className="bad">Connection failed. </span>}
          {testResult.outputs?.ok && <span className="ok">All enabled outputs rang ✓</span>}
          {testResult.outputs && !testResult.outputs.ok && !testResult.outputs.failed?.length
            && <span className="sub">No ring outputs enabled yet.</span>}
          {testResult.outputs?.failed?.map((f) => <span className="bad" key={f.output}> ✗ {f.output}: {f.error}</span>)}
        </p>
      )}
      {error && <p className="err">⚠ {error}</p>}
    </div>
  );
}
