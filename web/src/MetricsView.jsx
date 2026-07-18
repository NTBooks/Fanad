import { useEffect, useState } from 'react';
import * as api from './api.js';
import { ViewToggle } from './ModulesPanel.jsx';
import MetricChart from './MetricChart.jsx';

const RANGES = [{ key: '7d', days: 7 }, { key: '30d', days: 30 }, { key: '90d', days: 90 }];
const AGGS = ['sum', 'avg', 'last', 'max', 'min'];
const round = (n) => Math.round(n * 10) / 10;
const when = (ms) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const agg = (vals, a) => {
  if (!vals.length) return 0;
  const n = vals.map((v) => v.value);
  if (a === 'avg') return n.reduce((x, y) => x + y, 0) / n.length;
  if (a === 'last') return n[n.length - 1];
  if (a === 'max') return Math.max(...n);
  if (a === 'min') return Math.min(...n);
  return n.reduce((x, y) => x + y, 0);
};

// Each metric as a table of recent values + its graph (drawn client-side from /chart-data — interactive
// and theme-aware; chat/Telegram keep the server-rendered PNG). A log-value form per metric, an add-metric
// form, and a range selector shared across all cards. Text tab mirrors the tally.
export default function MetricsView() {
  const [metrics, setMetrics] = useState(null);
  const [data, setData] = useState({});      // name → { values, image }
  const [range, setRange] = useState('30d');
  const [view, setView] = useState('gui');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // { id, value, note } — one row at a time

  const rangeDays = RANGES.find((r) => r.key === range).days;
  const since = () => Date.now() - rangeDays * 86400000;

  const loadOne = async (name) => {
    const [v, c] = await Promise.all([
      api.getMetricValues(name, since()),
      api.getMetricChartData(name, range).catch(() => null),
    ]);
    setData((d) => ({ ...d, [name]: { values: v.values, chart: c } }));
  };
  const loadAll = async () => {
    try {
      const r = await api.getMetrics(); setMetrics(r.metrics); setError(null);
      await Promise.all(r.metrics.map((m) => loadOne(m.name)));
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { loadAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [range]);

  const addMetric = async (e) => {
    e.preventDefault();
    if (busy) return;
    const f = e.target.elements;
    const name = f.name.value.trim();
    if (!name) return;
    setBusy(true); setError(null);
    try {
      await api.createMetric({
        name, unit: f.unit.value.trim() || null, aggregation: f.aggregation.value,
        target: f.target.value.trim() ? Number(f.target.value) : null,
        measurementType: f.mtype.value,
      });
      e.target.reset();
      await loadAll();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const logValue = async (name, e) => {
    e.preventDefault();
    if (busy) return;
    const f = e.target.elements;
    const value = Number(f.value.value);
    if (!Number.isFinite(value)) return;
    setBusy(true); setError(null);
    try { await api.logMetricValue(name, value, f.note.value.trim() || null); e.target.reset(); await loadOne(name); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const saveEdit = async (name) => {
    if (busy || !editing) return;
    const value = Number(editing.value);
    if (!Number.isFinite(value)) { setError('value must be a number'); return; }
    setBusy(true); setError(null);
    try { await api.patchMetricValue(name, editing.id, { value, note: editing.note.trim() || null }); setEditing(null); await loadOne(name); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const deleteValue = async (name, id) => {
    if (busy || !window.confirm('Delete this value?')) return;
    setBusy(true); setError(null);
    try { await api.deleteMetricValue(name, id); await loadOne(name); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const onEditKey = (e, name) => {
    if (e.key === 'Enter') { e.preventDefault(); saveEdit(name); }
    else if (e.key === 'Escape') setEditing(null);
  };

  if (error && !metrics) return <p className="err">⚠ {error}</p>;
  if (!metrics) return <p className="hint">Loading…</p>;

  return (
    <div className="module-view">
      <div className="module-bar">
        <div className="range-tabs">
          {RANGES.map((r) => <button key={r.key} className={r.key === range ? 'on' : ''} onClick={() => setRange(r.key)}>{r.key}</button>)}
        </div>
        <ViewToggle view={view} onView={setView} />
      </div>
      {error && <p className="err">⚠ {error}</p>}

      {view === 'text' ? (
        <pre className="text-mirror">{metrics.length === 0 ? 'No metrics yet.' : (() => {
          const lines = metrics.map((m) => {
            const vals = data[m.name]?.values || [];
            const unit = m.unit ? ` ${m.unit}` : '';
            const val = round(agg(vals, m.aggregation));
            if (val === 0) return null;   // skip metrics with nothing to show (mirrors server tally)
            const tgt = m.target != null ? ` / ${round(m.target)}${unit}` : unit;
            return `• ${m.name}: ${val}${tgt}  (${m.aggregation} over ${range}, ${vals.length} pts)`;
          }).filter(Boolean);
          return lines.length ? lines.join('\n') : 'Nothing logged in this range.';
        })()}</pre>
      ) : (
        <>
          {metrics.length === 0 && <p className="hint">No metrics yet — add one below.</p>}
          {metrics.map((m) => {
            const d = data[m.name] || { values: [], chart: null };
            const unit = m.unit ? ` ${m.unit}` : '';
            return (
              <div key={m.id} className="metric-card">
                <div className="metric-head">
                  <b>{m.name}</b>
                  <span className="chip">{m.aggregation}</span>
                  {m.unit && <span className="chip">{m.unit}</span>}
                  {m.target != null && <span className="chip">🎯 {round(m.target)}{unit}</span>}
                  <span className="chip">{m.measurement_type}</span>
                </div>
                <MetricChart data={d.chart} />
                <div className="metric-table-wrap">
                  <table className="data-table">
                    <thead><tr><th>when</th><th>value</th><th>note</th><th aria-label="actions" /></tr></thead>
                    <tbody>
                      {[...d.values].reverse().slice(0, 12).map((v) => {
                        const isEditing = editing?.id === v.id;
                        return (
                          <tr key={v.id}>
                            <td>{when(v.recorded_at)}</td>
                            {isEditing ? (
                              <>
                                <td><input type="number" step="any" autoFocus value={editing.value}
                                  onChange={(e) => setEditing((s) => ({ ...s, value: e.target.value }))}
                                  onKeyDown={(e) => onEditKey(e, m.name)} /></td>
                                <td><input value={editing.note} placeholder="note"
                                  onChange={(e) => setEditing((s) => ({ ...s, note: e.target.value }))}
                                  onKeyDown={(e) => onEditKey(e, m.name)} /></td>
                              </>
                            ) : (
                              <>
                                <td>{round(v.value)}{unit}</td>
                                <td>{v.note || '—'}</td>
                              </>
                            )}
                            <td className="row-actions">
                              {isEditing ? (
                                <>
                                  <button className="link" disabled={busy} onClick={() => saveEdit(m.name)}>Save</button>
                                  <button className="link" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
                                </>
                              ) : (
                                <>
                                  <button className="link" title="Edit" disabled={busy}
                                    onClick={() => setEditing({ id: v.id, value: String(v.value), note: v.note || '' })}>✎</button>
                                  <button className="link danger" title="Delete" disabled={busy}
                                    onClick={() => deleteValue(m.name, v.id)}>🗑</button>
                                </>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      {d.values.length === 0 && <tr><td colSpan={4} className="hint">No values in this range.</td></tr>}
                    </tbody>
                  </table>
                </div>
                <form className="add-row" onSubmit={(e) => logValue(m.name, e)}>
                  <input name="value" type="number" step="any" placeholder={`log ${m.name}…`} />
                  <input name="note" placeholder="note (optional)" />
                  <button type="submit" disabled={busy}>Log</button>
                </form>
              </div>
            );
          })}

          <form className="metric-add" onSubmit={addMetric}>
            <div className="fld-label">Add a metric</div>
            <div className="metric-add-row">
              <input name="name" placeholder="name (e.g. water)" required />
              <input name="unit" placeholder="unit (e.g. g)" />
              <select name="aggregation" defaultValue="sum">{AGGS.map((a) => <option key={a} value={a}>{a}</option>)}</select>
              <input name="target" type="number" step="any" placeholder="target" />
              <select name="mtype" defaultValue="tallied"><option value="tallied">tallied</option><option value="point">point</option></select>
              <button type="submit" disabled={busy}>Add</button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
