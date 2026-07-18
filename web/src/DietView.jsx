import { useEffect, useState } from 'react';
import * as api from './api.js';
import { ViewToggle } from './ModulesPanel.jsx';
import MetricChart from './MetricChart.jsx';

// The Diet module's web view: the report (today's calories vs target, the 30-day graph, the weight
// graph + quick entry), the daily food log (day-by-day, per-row undo), the canonical food library, and
// the recipe builder with a live cal/oz preview. The preview math mirrors shared/diet.js (unit taxonomy
// + gram factor arrive via cfg.dietUnits — never hardcoded here); the server's save recomputes
// authoritatively. The web never asks the LLM: unknown foods are taught in chat ("eat 4 oz …") or added
// to the library below.
const round1 = (n) => Math.round(n * 10) / 10;
// Day keys are pure arithmetic here — the SERVER decides what day it is (02:00 rollover on ITS clock,
// see /diet/report `today`). The browser's own date is never trusted: at 1am, or with the server in a
// different timezone, the two disagree and the log would point at a day the server can't serve.
const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shiftDay = (key, delta) => {
  const [y, m, d] = key.split('-').map(Number);
  return keyOf(new Date(y, m - 1, d + delta));
};

// An eaten/ingredient quantity in the food's own units (mirror of shared/diet.js toFoodUnits).
// countTypes (piece, serving) arrives via cfg.dietUnits like the rest of the taxonomy — never hardcoded.
function toFoodUnits(food, qty, unit, gramsPerOz, countTypes) {
  const n = Number(qty);
  if (!(n > 0)) return null;
  const u = unit || null;
  if (countTypes.includes(food.unit_type)) return u == null || u === 'piece' ? n : null;
  if (u === 'piece') return null;
  const oz = u === 'g' ? n / gramsPerOz : u === 'lb' ? n * 16 : n;
  if (u == null && food.unit_type === 'gram') return n;
  return food.unit_type === 'gram' ? oz * gramsPerOz : oz;
}

export default function DietView({ cfg }) {
  const units = cfg?.dietUnits || { types: ['ounce', 'gram', 'piece'], labels: { ounce: 'oz', gram: 'g', piece: 'piece' }, gramsPerOz: 28.35 };
  const countTypes = units.countTypes || ['piece']; // pre-refresh cached config safety
  const [view, setView] = useState('gui');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);
  const [charts, setCharts] = useState({});      // calories/weight → chart-data payload | null
  const [date, setDate] = useState(null); // YYYY-MM-DD, null until the server's first log reply names its day
  const [log, setLog] = useState(null);
  const [foods, setFoods] = useState(null);
  const [editing, setEditing] = useState(null);  // food id being edited inline
  const [editingEntry, setEditingEntry] = useState(null); // { id, label, calories } — one log row at a time
  const [recipes, setRecipes] = useState(null);
  const [openRecipe, setOpenRecipe] = useState(null); // { recipe, items, ... } expanded
  const [rows, setRows] = useState([{ name: '', quantity: '', unit: '' }]); // builder ingredient rows
  const [cooked, setCooked] = useState('');      // builder cooked-weight (controlled for the live preview)
  const [weightLog, setWeightLog] = useState(null);        // full weight history (sparse — no pagination)
  const [editingWeight, setEditingWeight] = useState(null); // { id, value, date } — one row at a time
  const [notebook, setNotebook] = useState(null);          // current notebook name when NOT in Main

  const loadReport = async () => {
    const r = await api.getDietReport(30);
    setReport(r);
    const [cal, w] = await Promise.all([
      api.getDietChartData('calories').catch(() => null),
      api.getDietChartData('weight').catch(() => null),
    ]);
    setCharts({ calories: cal, weight: w });
  };
  // No date (first load) → the server picks ITS today and the reply's `date` becomes ours.
  const loadLog = async (d = date) => {
    const l = await api.getDietLog(d);
    setLog(l);
    setDate(l.date);
  };
  const navDay = (delta) => loadLog(shiftDay(date, delta)).catch((e) => setError(e.message));
  // Toggle the currently-viewed day as "eat whatever" (off the record): the graph tints it and the
  // average skips it. Reloading the report re-pulls the charts, so the band appears immediately.
  const toggleWhatever = () => {
    if (!log) return;
    run(async () => {
      await api.setDietWhatever(!log.whatever, log.date);
      await Promise.all([loadLog(), loadReport()]);
    });
  };
  const loadFoods = async () => setFoods((await api.getFoods()).foods);
  const loadRecipes = async () => setRecipes((await api.getRecipes()).recipes);
  const loadWeightLog = async () => setWeightLog(await api.getDietWeightLog());
  // Diet stats belong in the MAIN space — if a notebook is active, everything on this page reads/writes
  // the notebook's own (usually empty) record. Surface that as a warning bar instead of a silent mislog.
  const loadNotebook = async () => {
    try {
      const nb = await api.getNotebooks();
      const cur = nb?.enabled && nb.currentId != null ? nb.notebooks.find((n) => n.id === nb.currentId) : null;
      setNotebook(cur ? cur.name : null);
    } catch { setNotebook(null); } // notebooks module off → no bar
  };
  const loadAll = async () => {
    try { await Promise.all([loadReport(), loadLog(), loadFoods(), loadRecipes(), loadWeightLog(), loadNotebook()]); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => { loadAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const run = async (fn) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const logPortion = (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const name = f.name.value.trim();
    if (!name) return;
    run(async () => {
      await api.logDiet(name, f.qty.value.trim() || null, f.unit.value || null);
      e.target.reset();
      await Promise.all([loadLog(), loadReport()]);
    });
  };

  const saveEntry = () => {
    if (!editingEntry) return;
    const calories = Number(editingEntry.calories);
    const label = editingEntry.label.trim();
    if (!Number.isFinite(calories) || !(calories > 0)) { setError('calories must be a positive number'); return; }
    if (!label) { setError('label required'); return; }
    run(async () => {
      await api.patchDietLog(editingEntry.id, { label, calories });
      setEditingEntry(null);
      await Promise.all([loadLog(), loadReport()]);
    });
  };
  const deleteEntry = (id) => {
    if (!window.confirm('Delete this entry?')) return;
    run(async () => {
      await api.deleteDietLog(id);
      await Promise.all([loadLog(), loadReport()]);
    });
  };
  const onEntryKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveEntry(); }
    else if (e.key === 'Escape') setEditingEntry(null);
  };

  const saveWeight = () => {
    if (!editingWeight) return;
    const value = Number(editingWeight.value);
    if (!Number.isFinite(value) || !(value > 0)) { setError('weight must be a positive number'); return; }
    if (!editingWeight.date) { setError('date required'); return; }
    run(async () => {
      await api.patchDietWeight(editingWeight.id, { value, at: editingWeight.date });
      setEditingWeight(null);
      await Promise.all([loadWeightLog(), loadReport()]);
    });
  };
  const deleteWeight = (id) => {
    if (!window.confirm('Delete this weight entry?')) return;
    run(async () => {
      await api.deleteDietWeight(id);
      await Promise.all([loadWeightLog(), loadReport()]);
    });
  };
  const onWeightKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveWeight(); }
    else if (e.key === 'Escape') setEditingWeight(null);
  };
  const addWeight = (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const v = Number(f.w.value);
    if (!(v > 0)) return;
    const at = f.wdate.value && f.wdate.value !== report.today ? f.wdate.value : null; // today → "now"
    run(async () => {
      await api.logDietWeight(v, at);
      e.target.reset();
      await Promise.all([loadWeightLog(), loadReport()]);
    });
  };

  const addFood = (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const name = f.name.value.trim();
    const cal = Number(f.cal.value);
    if (!name || !(cal > 0)) return;
    run(async () => { await api.createFood({ name, calPerUnit: cal, unitType: f.unit.value }); e.target.reset(); await loadFoods(); });
  };

  const saveFood = (food, e) => {
    e.preventDefault();
    const f = e.target.elements;
    run(async () => {
      await api.updateFood(food.id, { name: f.name.value.trim(), calPerUnit: Number(f.cal.value), unitType: f.unit.value });
      setEditing(null);
      await loadFoods();
    });
  };

  // Live builder preview: resolve each row against the library, mirror the server math.
  const foodByName = (name) => (foods || []).find((f) => f.name.toLowerCase() === name.trim().toLowerCase());
  const previewRows = rows.map((r) => {
    if (!r.name.trim() || !(Number(r.quantity) > 0)) return { ...r, state: 'blank' };
    const food = foodByName(r.name);
    if (!food) return { ...r, state: 'unknown' };
    const inUnits = toFoodUnits(food, r.quantity, r.unit || null, units.gramsPerOz, countTypes);
    if (inUnits == null) return { ...r, state: 'mismatch', food };
    return { ...r, state: 'ok', food, calories: Math.round(food.cal_per_unit * inUnits) };
  });
  const previewTotal = previewRows.filter((r) => r.state === 'ok').reduce((s, r) => s + r.calories, 0);

  const saveRecipe = (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const name = f.rname.value.trim();
    const cookedOz = Number(cooked);
    const items = previewRows.filter((r) => r.state === 'ok')
      .map((r) => ({ name: r.food.name, quantity: Number(r.quantity), unit: r.unit || null }));
    if (!name || !(cookedOz > 0) || !items.length) return;
    run(async () => {
      await api.saveRecipe({ name, cookedWeightOz: cookedOz, items });
      f.rname.value = '';
      setCooked('');
      setRows([{ name: '', quantity: '', unit: '' }]);
      await loadRecipes();
    });
  };

  const setRow = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  if (error && !report) return <p className="err">⚠ {error}</p>;
  if (!report || !foods || !recipes) return <p className="hint">Loading…</p>;

  const pct = report.target ? Math.min(100, Math.round((report.todayTotal / report.target) * 100)) : null;
  const lastWeight = report.weight.length ? report.weight[report.weight.length - 1] : null;

  // Day boundaries follow the SERVER's clock — if the deployment runs in a different timezone than this
  // browser, days flip at the wrong wall-clock hour. Surface it (fix: set TZ on the server).
  const tzMismatch = report.tz != null && report.tz.offsetMinutes !== new Date().getTimezoneOffset();
  const utcLabel = (mins) => { // getTimezoneOffset is minutes WEST of UTC, so flip the sign for display
    const s = -mins;
    const abs = Math.abs(s);
    return `UTC${s < 0 ? '−' : '+'}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
  };

  const textMirror = [
    `Today: ${report.todayTotal}${report.target ? ` / ${report.target}` : ''} kcal`,
    report.average != null ? `Average: ${report.average} kcal (${report.averageDays} tracked day${report.averageDays === 1 ? '' : 's'}, eat-whatever days excluded)` : null,
    lastWeight ? `Weight: ${lastWeight.value} ${report.weightUnit} (${lastWeight.date})` : null,
    '',
    '🥗 Foods:',
    ...(foods.length ? foods.map((f, i) => `${i + 1}. ${f.name} — ${round1(f.cal_per_unit)} cal/${units.labels[f.unit_type]}${f.description ? ` · ${f.description}` : ''}`) : ['(none yet)']),
    '',
    '🍲 Recipes:',
    ...(recipes.length ? recipes.map((r, i) => `${i + 1}. ${r.name} — ${r.calPerOz != null ? `${r.calPerOz} cal/oz` : 'draft'}`) : ['(none yet)']),
    '',
    `Log ${log?.date || date}:${log?.whatever ? ' 🍕 eat-whatever day (off the record)' : ''}`,
    ...((log?.entries || []).map((e) => `• ${e.label}: ${Math.round(e.calories)} cal`)),
    log ? `Total: ${log.total} cal` : null,
  ].filter((l) => l != null).join('\n');

  return (
    <div className="module-view">
      {notebook && (
        <div className="nb-warn">
          <span>⚠️ You're in 📓 <b>{notebook}</b> — anything logged here lands in that notebook, not your Main diet record.</span>
          <button disabled={busy} onClick={() => run(async () => { await api.switchNotebook(null); window.location.reload(); })}>
            Switch to Main
          </button>
        </div>
      )}
      {tzMismatch && (
        <div className="nb-warn">
          <span>
            ⚠️ The server's clock is <b>{report.tz.name} ({utcLabel(report.tz.offsetMinutes)})</b> but this device is {utcLabel(new Date().getTimezoneOffset())} —
            days roll over on the server's time, so late-evening logs can land on the wrong day.
            Set your location in Settings → Weather (the server adopts its timezone), or set the <code>TZ</code> env var.
          </span>
        </div>
      )}
      <div className="module-bar">
        <div className="range-tabs">
          <button className="on" disabled>30d</button>
        </div>
        <ViewToggle view={view} onView={setView} />
      </div>
      {error && <p className="err">⚠ {error}</p>}

      {view === 'text' ? (
        <pre className="text-mirror">{textMirror}</pre>
      ) : (
        <>
          {/* ── Report ── */}
          <div className="metric-card">
            <div className="metric-head">
              <b>Today</b>
              <span className="chip">{report.todayTotal}{report.target ? ` / ${report.target}` : ''} kcal</span>
              {pct != null && <span className="chip">{pct}%</span>}
              {report.average != null && <span className="chip" title={`average of ${report.averageDays} tracked day${report.averageDays === 1 ? '' : 's'} (eat-whatever days excluded)`}>avg {report.average} kcal</span>}
              {lastWeight && <span className="chip">⚖️ {lastWeight.value} {report.weightUnit}</span>}
            </div>
            {report.target != null && (
              <div className="diet-progress" style={{ background: 'var(--panel-2, #eee)', borderRadius: 6, height: 10, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: report.todayTotal > report.target ? '#d9534f' : '#5cb85c' }} />
              </div>
            )}
            {charts.calories && charts.calories.points > 0
              ? <MetricChart data={charts.calories} />
              : <div className="metric-chart empty">No calorie data yet — log something below.</div>}
            {charts.weight && charts.weight.points > 0
              ? <MetricChart data={charts.weight} />
              : <div className="metric-chart empty">No weight readings yet.</div>}
            <form className="add-row" onSubmit={(e) => { e.preventDefault(); const v = Number(e.target.elements.t.value); if (Number.isInteger(v) && v > 0) run(async () => { await api.setDietTarget(v); e.target.reset(); await loadReport(); }); }}>
              <input name="t" type="number" step="1" min="1" placeholder={`daily target (now ${report.target ?? '—'} kcal)…`} />
              <button type="submit" disabled={busy}>Set target</button>
            </form>
          </div>

          {/* ── Weight log (add / edit / delete — the chart above is a real time axis, so dates matter) ── */}
          <div className="metric-card">
            <div className="metric-head">
              <b>Weight log</b>
              {weightLog && <span className="chip">{weightLog.entries.length} entr{weightLog.entries.length === 1 ? 'y' : 'ies'}</span>}
              {lastWeight && <span className="chip">latest {lastWeight.value} {report.weightUnit}</span>}
            </div>
            <div className="metric-table-wrap">
              <table className="data-table">
                <thead><tr><th>date</th><th>{report.weightUnit}</th><th /></tr></thead>
                <tbody>
                  {[...(weightLog?.entries || [])].reverse().map((w) => {
                    const isEditing = editingWeight?.id === w.id;
                    return (
                      <tr key={w.id}>
                        {isEditing ? (
                          <>
                            <td><input type="date" value={editingWeight.date}
                              onChange={(ev) => setEditingWeight((s) => ({ ...s, date: ev.target.value }))}
                              onKeyDown={onWeightKey} /></td>
                            <td><input autoFocus type="number" step="any" value={editingWeight.value}
                              onChange={(ev) => setEditingWeight((s) => ({ ...s, value: ev.target.value }))}
                              onKeyDown={onWeightKey} /></td>
                          </>
                        ) : (
                          <>
                            <td>{w.date}</td>
                            <td>{round1(w.value)}</td>
                          </>
                        )}
                        <td className="row-actions">
                          {isEditing ? (
                            <>
                              <button className="link" disabled={busy} onClick={saveWeight}>Save</button>
                              <button className="link" disabled={busy} onClick={() => setEditingWeight(null)}>Cancel</button>
                            </>
                          ) : (
                            <>
                              <button className="link" title="Edit" disabled={busy}
                                onClick={() => setEditingWeight({ id: w.id, value: String(w.value), date: w.date })}>✎</button>
                              <button className="link danger" title="Delete" disabled={busy}
                                onClick={() => deleteWeight(w.id)}>🗑</button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {(weightLog?.entries || []).length === 0 && <tr><td colSpan={3} className="hint">No weight readings yet — log one below (pick a date to backfill).</td></tr>}
                </tbody>
              </table>
            </div>
            <form className="add-row" onSubmit={addWeight}>
              <input name="w" type="number" step="any" placeholder={`weight (${report.weightUnit})…`} required />
              <input name="wdate" type="date" defaultValue={report.today} max={report.today} />
              <button type="submit" disabled={busy}>Log weight</button>
            </form>
          </div>

          {/* ── Daily food log ── */}
          <div className="metric-card">
            <div className="metric-head">
              <b>Food log</b>
              <span className="chip">
                <button onClick={() => navDay(-1)} disabled={!date} aria-label="Previous day">‹</button>
                {' '}{log?.date || date || '…'}{' '}
                <button onClick={() => navDay(1)} disabled={!date || date >= report.today} aria-label="Next day">›</button>
              </span>
              {log && <span className="chip">{log.total} cal</span>}
              {log && (
                <button className="link" disabled={busy} onClick={toggleWhatever}
                  title="An 'eat whatever' day is off the record — tinted on the graph and left out of your average.">
                  {log.whatever ? '🍕 eat-whatever ✓ (undo)' : '🍕 mark eat-whatever'}
                </button>
              )}
            </div>
            <div className="metric-table-wrap">
              <table className="data-table">
                <thead><tr><th>portion</th><th>calories</th><th /></tr></thead>
                <tbody>
                  {(log?.entries || []).map((e) => {
                    const isEditing = editingEntry?.id === e.id;
                    return (
                      <tr key={e.id}>
                        {isEditing ? (
                          <>
                            <td><input autoFocus value={editingEntry.label}
                              onChange={(ev) => setEditingEntry((s) => ({ ...s, label: ev.target.value }))}
                              onKeyDown={onEntryKey} /></td>
                            <td><input type="number" step="any" value={editingEntry.calories}
                              onChange={(ev) => setEditingEntry((s) => ({ ...s, calories: ev.target.value }))}
                              onKeyDown={onEntryKey} /></td>
                          </>
                        ) : (
                          <>
                            <td>{e.label}</td>
                            <td>{Math.round(e.calories)}</td>
                          </>
                        )}
                        <td className="row-actions">
                          {isEditing ? (
                            <>
                              <button className="link" disabled={busy} onClick={saveEntry}>Save</button>
                              <button className="link" disabled={busy} onClick={() => setEditingEntry(null)}>Cancel</button>
                            </>
                          ) : (
                            <>
                              <button className="link" title="Edit" disabled={busy}
                                onClick={() => setEditingEntry({ id: e.id, label: e.label, calories: String(e.calories) })}>✎</button>
                              <button className="link danger" title="Delete" disabled={busy}
                                onClick={() => deleteEntry(e.id)}>🗑</button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {(log?.entries || []).length === 0 && <tr><td colSpan={3} className="hint">Nothing logged this day.</td></tr>}
                </tbody>
              </table>
            </div>
            <form className="add-row" onSubmit={logPortion}>
              <input name="name" list="diet-lookup" placeholder="food or recipe…" required />
              <input name="qty" type="number" step="any" placeholder="amount" />
              <select name="unit" defaultValue="oz">
                <option value="oz">oz</option><option value="g">g</option><option value="lb">lb</option><option value="piece">piece</option>
              </select>
              <button type="submit" disabled={busy}>Log</button>
            </form>
            <datalist id="diet-lookup">
              {foods.map((f) => <option key={`f${f.id}`} value={f.name} />)}
              {recipes.filter((r) => r.calPerOz != null).map((r) => <option key={`r${r.id}`} value={r.name} />)}
            </datalist>
          </div>

          {/* ── Food library ── */}
          <div className="metric-card">
            <div className="metric-head"><b>Foods</b><span className="chip">{foods.length}</span></div>
            <div className="metric-table-wrap">
              <table className="data-table">
                <thead><tr><th>name</th><th>calories</th><th>per</th><th /></tr></thead>
                <tbody>
                  {foods.map((f) => (editing === f.id ? (
                    <tr key={f.id}>
                      <td colSpan={4}>
                        <form className="add-row" onSubmit={(e) => saveFood(f, e)}>
                          <input name="name" defaultValue={f.name} required />
                          <input name="cal" type="number" step="any" defaultValue={f.cal_per_unit} required />
                          <select name="unit" defaultValue={f.unit_type}>
                            {units.types.map((u) => <option key={u} value={u}>{units.labels[u]}</option>)}
                          </select>
                          <button type="submit" disabled={busy}>Save</button>
                          <button type="button" onClick={() => setEditing(null)}>Cancel</button>
                        </form>
                      </td>
                    </tr>
                  ) : (
                    <tr key={f.id}>
                      <td title={f.description || undefined}>{f.name}{f.description ? ' *' : ''}</td>
                      <td>{round1(f.cal_per_unit)}</td>
                      <td>{units.labels[f.unit_type]}</td>
                      <td className="row-actions">
                        <button className="link" onClick={() => setEditing(f.id)} disabled={busy} title="Edit">✎</button>
                        <button className="link danger" onClick={() => run(async () => { await api.deleteFood(f.id); await loadFoods(); })} disabled={busy} title="Delete">🗑</button>
                      </td>
                    </tr>
                  )))}
                  {foods.length === 0 && <tr><td colSpan={4} className="hint">No foods yet — add one below, or teach me in chat: “eat 4 oz chicken breast”.</td></tr>}
                </tbody>
              </table>
            </div>
            <form className="add-row" onSubmit={addFood}>
              <input name="name" placeholder="food name…" required />
              <input name="cal" type="number" step="any" placeholder="calories" required />
              <select name="unit" defaultValue="ounce">
                {units.types.map((u) => <option key={u} value={u}>per {units.labels[u]}</option>)}
              </select>
              <button type="submit" disabled={busy}>Add</button>
            </form>
          </div>

          {/* ── Recipes ── */}
          <div className="metric-card">
            <div className="metric-head"><b>Recipes</b><span className="chip">{recipes.length}</span></div>
            <div className="metric-table-wrap">
              <table className="data-table">
                <thead><tr><th>name</th><th>cal/oz</th><th>cooked</th><th /></tr></thead>
                <tbody>
                  {recipes.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <button className="link" onClick={() => run(async () => setOpenRecipe(openRecipe?.recipe?.id === r.id ? null : await api.getRecipe(r.id)))}>
                          {r.name}
                        </button>
                      </td>
                      <td>{r.calPerOz != null ? r.calPerOz : 'draft'}</td>
                      <td>{r.cooked_weight_oz ? `${r.cooked_weight_oz} oz` : '—'}</td>
                      <td className="row-actions"><button className="link danger" onClick={() => run(async () => { await api.deleteRecipe(r.id); setOpenRecipe(null); await loadRecipes(); })} disabled={busy} title="Delete">🗑</button></td>
                    </tr>
                  ))}
                  {recipes.length === 0 && <tr><td colSpan={4} className="hint">No recipes yet — build one below.</td></tr>}
                </tbody>
              </table>
            </div>
            {openRecipe && (
              <div className="metric-table-wrap">
                <table className="data-table">
                  <thead><tr><th colSpan={3}>{openRecipe.recipe.name} — {openRecipe.totalCalories} cal ÷ {openRecipe.recipe.cooked_weight_oz} oz = {openRecipe.calPerOz} cal/oz</th></tr></thead>
                  <tbody>
                    {openRecipe.items.map((it) => (
                      <tr key={it.id}>
                        <td>{it.name}</td>
                        <td>{round1(it.quantity)} {units.labels[it.unit_type]}</td>
                        <td>{Math.round(it.cal_per_unit * it.quantity)} cal</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <form className="metric-add" onSubmit={saveRecipe}>
              <div className="fld-label">Build a recipe (from your foods — teach unknown ones first)</div>
              {previewRows.map((r, i) => (
                <div className="metric-add-row" key={i}>
                  <input list="diet-foods" placeholder="ingredient…" value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} />
                  <input type="number" step="any" placeholder="amount" value={r.quantity} onChange={(e) => setRow(i, { quantity: e.target.value })} />
                  <select value={r.unit} onChange={(e) => setRow(i, { unit: e.target.value })}>
                    <option value="">{r.food ? units.labels[r.food.unit_type] : 'unit'}</option>
                    <option value="oz">oz</option><option value="g">g</option><option value="lb">lb</option><option value="piece">piece</option>
                  </select>
                  <span className="chip">
                    {r.state === 'ok' && `${r.calories} cal`}
                    {r.state === 'unknown' && '⚠ not in your foods'}
                    {r.state === 'mismatch' && `⚠ per-${units.labels[r.food.unit_type]} food`}
                  </span>
                  <button type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} disabled={rows.length === 1}>✕</button>
                </div>
              ))}
              <div className="metric-add-row">
                <button type="button" onClick={() => setRows((rs) => [...rs, { name: '', quantity: '', unit: '' }])}>+ ingredient</button>
                <input name="rname" placeholder="recipe name…" required />
                <input type="number" step="any" placeholder="cooked weight (oz)" value={cooked} onChange={(e) => setCooked(e.target.value)} required />
                <span className="chip">{previewTotal} cal{Number(cooked) > 0 ? ` → ${round1(previewTotal / Number(cooked))} cal/oz` : ''}</span>
                <button type="submit" disabled={busy}>Save recipe</button>
              </div>
              <datalist id="diet-foods">{foods.map((f) => <option key={f.id} value={f.name} />)}</datalist>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
