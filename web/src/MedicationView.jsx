import { useEffect, useMemo, useState } from 'react';
import * as api from './api.js';
import { ViewToggle } from './ModulesPanel.jsx';
import MetricChart from './MetricChart.jsx';

// The Medication module's web view: today's adherence (☑/☐ by template, tap to tick), the med catalog
// (add / delete, with a freeform dose note), the template editor (members + an optional daily reminder
// time), and a per-med adherence chart. It logs only what you tick — it NEVER asks the LLM and never
// suggests a dose. Med data belongs in the MAIN space, so a notebook shows a warning bar (like Diet).
const HHMM = (min) => (min == null ? '' : `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`);
const toMinute = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? h * 60 + mi : null;
};

export default function MedicationView() {
  const [view, setView] = useState('gui');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [today, setToday] = useState(null);       // { templates, loose, disclaimer }
  const [meds, setMeds] = useState(null);          // catalog [{id,name,dose,taken}]
  const [templates, setTemplates] = useState(null);
  const [notebook, setNotebook] = useState(null);
  const [newMed, setNewMed] = useState({ name: '', dose: '' });
  const [newTpl, setNewTpl] = useState({ name: '', meds: '', time: '' });
  const [chartMed, setChartMed] = useState('');    // med name whose adherence chart is open
  const [chartData, setChartData] = useState(null);

  const load = async () => {
    try {
      const [t, m, tp] = await Promise.all([api.getMedToday(), api.getMeds(), api.getMedTemplates()]);
      setToday(t); setMeds(m.meds); setTemplates(tp.templates); setError(null);
      try {
        const nb = await api.getNotebooks();
        const cur = nb?.enabled && nb.currentId != null ? nb.notebooks.find((n) => n.id === nb.currentId) : null;
        setNotebook(cur ? cur.name : null);
      } catch { setNotebook(null); }
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const guard = async (fn) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const toggle = (name, taken) => guard(async () => { setToday(await api.toggleMed(name, taken)); await refreshCatalog(); });
  const logAll = () => guard(async () => { setToday(await api.logAllMeds()); await refreshCatalog(); });
  const refreshCatalog = async () => { try { const m = await api.getMeds(); setMeds(m.meds); } catch { /* non-fatal */ } };

  const addMed = () => guard(async () => {
    if (!newMed.name.trim()) return;
    await api.addMed(newMed.name.trim(), newMed.dose.trim() || null);
    setNewMed({ name: '', dose: '' });
    await load();
  });
  const delMed = (name) => guard(async () => { await api.deleteMed(name); await load(); });

  const saveTpl = () => guard(async () => {
    const list = newTpl.meds.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!newTpl.name.trim() || !list.length) return;
    await api.saveMedTemplate(newTpl.name.trim(), list);
    const minute = toMinute(newTpl.time);
    if (minute != null) await api.setMedReminder(newTpl.name.trim(), minute);
    setNewTpl({ name: '', meds: '', time: '' });
    await load();
  });
  const delTpl = (name) => guard(async () => { await api.deleteMedTemplate(name); await load(); });
  const setReminder = (name, hhmm) => guard(async () => { await api.setMedReminder(name, toMinute(hhmm)); await load(); });

  const openChart = (name) => guard(async () => {
    if (chartMed === name) { setChartMed(''); setChartData(null); return; }
    setChartMed(name);
    setChartData(await api.getMedChartData(name).catch(() => null));
  });

  const textView = useMemo(() => {
    if (!today) return '';
    const lines = ['💊 Today'];
    for (const t of today.templates) {
      lines.push(`\n${t.name}${t.remindLabel && t.reminderEnabled ? ` — 🔔 ${t.remindLabel}` : ''}`);
      for (const md of t.meds) lines.push(`  ${md.taken ? '☑' : '☐'} ${md.name}${md.dose ? ` (${md.dose})` : ''}`);
    }
    if (today.loose.length) { lines.push('\nother meds'); for (const md of today.loose) lines.push(`  ${md.taken ? '☑' : '☐'} ${md.name}${md.dose ? ` (${md.dose})` : ''}`); }
    return lines.join('\n');
  }, [today]);

  if (error && !today) return <p className="err">⚠ {error}</p>;
  if (!today) return <p className="hint">Loading…</p>;

  const MedRow = ({ md }) => (
    <label className="check med-row">
      <input type="checkbox" checked={md.taken} disabled={busy} onChange={(e) => toggle(md.name, e.target.checked)} />
      <span className="med-name">{md.name}</span>
      {md.dose && <span className="sub">— {md.dose}</span>}
    </label>
  );

  return (
    <div className="med-view">
      <div className="mv-head">
        <ViewToggle view={view} onView={setView} />
      </div>

      {notebook && (
        <div className="nb-warn">
          <span>⚠️ You're in 📓 <b>{notebook}</b> — meds ticked here land in that notebook, not your Main record.</span>
        </div>
      )}
      {error && <p className="err">⚠ {error}</p>}

      {view === 'text' ? (
        <pre className="med-text">{textView}</pre>
      ) : (
        <>
          {/* Today's adherence */}
          <section className="mv-section">
            <div className="mv-section-head">
              <h3>Today</h3>
              <button className="ghost" disabled={busy} onClick={logAll}>Log all remaining</button>
            </div>
            {today.templates.length === 0 && today.loose.length === 0 && (
              <p className="hint">No meds yet. Add one below, then group them into a template.</p>
            )}
            {today.templates.map((t) => (
              <div key={t.id} className="med-template">
                <div className="med-template-head">
                  <b>{t.name}</b>
                  {t.reminderEnabled && t.remindLabel && <span className="med-remind">🔔 {t.remindLabel}</span>}
                </div>
                {t.meds.map((md) => <MedRow key={md.name} md={md} />)}
              </div>
            ))}
            {today.loose.length > 0 && (
              <div className="med-template">
                <div className="med-template-head"><b>other meds</b></div>
                {today.loose.map((md) => <MedRow key={md.name} md={md} />)}
              </div>
            )}
          </section>

          {/* Catalog */}
          <section className="mv-section">
            <h3>Your meds</h3>
            {meds && meds.map((md) => (
              <div key={md.id} className="med-catalog-row">
                <button className="link" onClick={() => openChart(md.name)} title="Adherence chart">{md.name}</button>
                {md.dose && <span className="sub"> — {md.dose}</span>}
                <button className="x-inline" disabled={busy} onClick={() => delMed(md.name)} aria-label={`Remove ${md.name}`}>✕</button>
                {chartMed === md.name && (
                  <div className="med-chart">{chartData ? <MetricChart data={chartData} height={200} /> : <p className="hint">No doses logged yet.</p>}</div>
                )}
              </div>
            ))}
            <div className="med-add">
              <input placeholder="medication name" value={newMed.name} onChange={(e) => setNewMed({ ...newMed, name: e.target.value })} />
              <input placeholder="dose (e.g. 5mg)" value={newMed.dose} onChange={(e) => setNewMed({ ...newMed, dose: e.target.value })} />
              <button disabled={busy || !newMed.name.trim()} onClick={addMed}>Add</button>
            </div>
          </section>

          {/* Templates */}
          <section className="mv-section">
            <h3>Templates</h3>
            {templates && templates.map((t) => (
              <div key={t.id} className="med-tpl-row">
                <b>{t.name}</b> <span className="sub">{t.meds.join(', ')}</span>
                <label className="med-tpl-time">
                  🔔 <input type="time" defaultValue={t.reminderEnabled ? HHMM(t.remindMinute) : ''}
                    onChange={(e) => setReminder(t.name, e.target.value)} disabled={busy} />
                </label>
                <button className="x-inline" disabled={busy} onClick={() => delTpl(t.name)} aria-label={`Delete ${t.name}`}>✕</button>
              </div>
            ))}
            <div className="med-add med-tpl-add">
              <input placeholder="template name (e.g. morning)" value={newTpl.name} onChange={(e) => setNewTpl({ ...newTpl, name: e.target.value })} />
              <input placeholder="meds, comma-separated" value={newTpl.meds} onChange={(e) => setNewTpl({ ...newTpl, meds: e.target.value })} />
              <input type="time" title="daily reminder (optional)" value={newTpl.time} onChange={(e) => setNewTpl({ ...newTpl, time: e.target.value })} />
              <button disabled={busy || !newTpl.name.trim() || !newTpl.meds.trim()} onClick={saveTpl}>Save</button>
            </div>
          </section>
        </>
      )}

      <p className="med-disclaimer">{today.disclaimer}</p>
    </div>
  );
}
