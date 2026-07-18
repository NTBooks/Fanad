import { useEffect, useState } from 'react';
import * as api from './api.js';
import { ViewToggle } from './ModulesPanel.jsx';

// The Batches module's web view: pick a process, work the active run's checklist (tick / add / edit / remove
// steps while it's open) + dated log, close it with an outcome, and graduate the tweaked steps into a new
// recipe version. The Recipe-versions panel shows the family lineage and lets a bad version be rejected out
// (reversibly). Same data + engine as the chat's "batch …" commands. No AI — a batch is raw record-keeping.
const shortDate = (ts) => new Date(ts).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });

export default function BatchesView() {
  const [processes, setProcesses] = useState(null); // [{name,total,open,last_opened_at}]
  const [active, setActive] = useState(null);       // process (family) name
  const [runs, setRuns] = useState([]);             // all runs of the active process, newest first
  const [versions, setVersions] = useState([]);     // recipe-version lineage of the active process
  const [openRun, setOpenRun] = useState(null);     // the run id whose card is expanded
  const [editing, setEditing] = useState(null);     // { batchId, pos, text } — a step being retexted inline
  const [templates, setTemplates] = useState([]);
  const [view, setView] = useState('gui');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadProcesses = async () => {
    try {
      const r = await api.getBatchProcesses();
      setProcesses(r.processes); setError(null);
      if (r.processes.length && !r.processes.some((p) => p.name === active)) setActive(r.processes[0].name);
    } catch (e) { setError(e.message); }
  };
  const loadRuns = async (name) => {
    if (!name) { setRuns([]); setVersions([]); setOpenRun(null); return; }
    try {
      const [r, v] = await Promise.all([api.getBatchRuns(name), api.getBatchVersions(name).catch(() => ({ versions: [] }))]);
      setRuns(r.runs); setVersions(v.versions || []);
      const open = r.runs.find((b) => b.status === 'open');
      setOpenRun((cur) => (r.runs.some((b) => b.id === cur) ? cur : (open || r.runs[0])?.id ?? null));
    } catch (e) { setError(e.message); }
  };
  const reloadTemplates = () => api.getTemplates().then((r) => setTemplates(r.templates)).catch(() => {});

  useEffect(() => { loadProcesses(); reloadTemplates(); }, []);
  useEffect(() => { setNotice(null); loadRuns(active); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [active]);

  const act = async (fn) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const refreshRun = (batch) => setRuns((rs) => rs.map((b) => (b.id === batch.id ? batch : b)));

  const startRun = (e) => {
    const name = e.target.value;
    if (!name) return;
    act(async () => {
      const r = await api.openNewBatch(name);
      await loadProcesses(); setActive(r.batch.name); await loadRuns(r.batch.name); setOpenRun(r.batch.id);
    });
  };
  const toggle = (batch, pos) => act(async () => { const r = await api.checkBatchItems(batch.id, [pos]); refreshRun(r.batch); });
  const addStep = (batch) => (e) => {
    e.preventDefault();
    const text = e.target.elements.step.value.trim();
    if (!text) return;
    act(async () => { const r = await api.addBatchStep(batch.id, text); refreshRun(r.batch); e.target.reset(); });
  };
  const saveEdit = (batch) => {
    if (!editing) return;
    const text = editing.text.trim();
    if (!text) { setEditing(null); return; }
    act(async () => { const r = await api.editBatchStep(batch.id, editing.pos, text); refreshRun(r.batch); setEditing(null); });
  };
  const removeStep = (batch, pos) => {
    if (!window.confirm(`Remove step ${pos}?`)) return;
    act(async () => { const r = await api.removeBatchStep(batch.id, pos); refreshRun(r.batch); });
  };
  const addLog = (batch) => (e) => {
    e.preventDefault();
    const text = e.target.elements.line.value.trim();
    if (!text) return;
    act(async () => { const r = await api.addBatchLog(batch.id, text); refreshRun(r.batch); e.target.reset(); });
  };
  const saveVersion = (batch) => act(async () => {
    const r = await api.saveBatchVersion(batch.id);
    setNotice(`🌱 Saved as new version “${r.versionName}” — “batch new ${r.base}” now starts from it.`);
    await Promise.all([loadProcesses(), reloadTemplates()]);
    const v = await api.getBatchVersions(active); setVersions(v.versions || []);
  });
  const close = (batch) => {
    const outcome = window.prompt(`Close “${batch.name}” #${batch.batch_no} — how did it turn out? (blank is fine)`);
    if (outcome === null) return;
    act(async () => { const r = await api.closeBatchRun(batch.id, outcome.trim()); refreshRun(r.batch); await loadProcesses(); });
  };
  const reject = (n, on) => act(async () => {
    const r = on ? await api.rejectBatchVersion(active, n) : await api.unrejectBatchVersion(active, n);
    setVersions(r.versions || []); await loadProcesses();
    if (on && r.emptied) setNotice('⚠️ That was the last active version — “batch new” has nothing to start from until you restore one or save a new version.');
    else setNotice(null);
  });
  const removeProcess = () => {
    if (!window.confirm(`Delete “${active}” — every run and its logs? This can’t be undone.`)) return;
    act(async () => { await api.deleteBatchProcess(active); setActive(null); await loadProcesses(); });
  };

  if (error && !processes) return <p className="err">⚠ {error}</p>;
  if (!processes) return <p className="hint">Loading…</p>;

  // The chat-equivalent text (the "Text" half of the GUI/Text toggle): lineage + history + expanded run.
  const textMirror = () => {
    if (!active) return 'No batches yet. Start one with: batch new <name>   (named after one of your /templates)';
    const cur = runs.find((b) => b.id === openRun);
    const hist = runs.map((b) => {
      const span = b.status === 'closed' ? `${shortDate(b.opened_at)}→${shortDate(b.closed_at)}` : `opened ${shortDate(b.opened_at)}`;
      const done = (b.checklist || []).filter((i) => i.done).length;
      return [`#${b.batch_no}`, span, b.checklist?.length ? `${done}/${b.checklist.length} steps` : null,
        b.status === 'open' ? 'still open' : (b.outcome ? `🏁 ${b.outcome}` : 'closed')].filter(Boolean).join(' · ');
    });
    const lineage = versions.length
      ? `🌱 versions: ${versions.map((v) => `#${v.n}${v.original ? ' (original)' : ''}${v.rejected ? ' ✗' : ''}${v.latest ? ' ← latest' : ''}`).join(' · ')}`
      : null;
    return [
      `🗂 ${active} — ${runs.length} run${runs.length === 1 ? '' : 's'}:`,
      ...hist,
      lineage,
      cur ? `\n🧪 ${cur.name} — batch #${cur.batch_no}` : null,
      cur?.checklist?.length ? cur.checklist.map((it, i) => `${i + 1}. ${it.done ? '☑' : '☐'} ${it.text}`).join('\n') : null,
      cur?.log?.length ? `📓 Log:\n${cur.log.map((l) => `${shortDate(l.created_at)} — ${l.text}`).join('\n')}` : null,
    ].filter(Boolean).join('\n');
  };

  return (
    <div className="module-view">
      <div className="module-bar">
        <div className="range-tabs">
          {processes.map((p) => (
            <button key={p.name} className={p.name === active ? 'on' : ''} onClick={() => setActive(p.name)}>
              🧪 {p.name}{p.open ? ` (${p.open} open)` : ''}
            </button>
          ))}
        </div>
        <ViewToggle view={view} onView={setView} />
      </div>
      {error && <p className="err">⚠ {error}</p>}
      {notice && <p className="hint" style={{ color: 'var(--ok, #2e7d32)' }}>{notice}</p>}

      {view === 'text' ? (
        <pre className="text-mirror">{textMirror()}</pre>
      ) : (
        <>
          {runs.map((b) => {
            const items = b.checklist || [];
            const done = items.filter((i) => i.done).length;
            const expanded = b.id === openRun;
            const closed = b.status === 'closed';
            return (
              <div key={b.id} className="metric-card">
                <div className="metric-head" style={{ cursor: 'pointer' }} onClick={() => setOpenRun(expanded ? null : b.id)}>
                  <b>#{b.batch_no} · {closed ? `${shortDate(b.opened_at)}→${shortDate(b.closed_at)}` : `opened ${shortDate(b.opened_at)}`}</b>
                  {items.length > 0 && <span className="chip">{done}/{items.length} steps</span>}
                  <span className="chip">{closed ? (b.outcome ? `🏁 ${b.outcome}` : 'closed') : '🟢 open'}</span>
                </div>
                {expanded && (
                  <>
                    <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0' }}>
                      {items.map((it, i) => {
                        const isEditing = editing && editing.batchId === b.id && editing.pos === i + 1;
                        return (
                          <li key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            {isEditing ? (
                              <>
                                <input autoFocus value={editing.text} style={{ flex: 1 }}
                                  onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                                  onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(b); if (e.key === 'Escape') setEditing(null); }} />
                                <button className="link" onClick={() => saveEdit(b)} disabled={busy}>Save</button>
                                <button className="link" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
                              </>
                            ) : (
                              <>
                                <label style={{ cursor: closed ? 'default' : 'pointer', flex: 1 }}>
                                  <input type="checkbox" checked={!!it.done} disabled={busy || closed} onChange={() => toggle(b, i + 1)} /> {it.text}
                                </label>
                                {!closed && <button className="link" title="Edit" disabled={busy} onClick={() => setEditing({ batchId: b.id, pos: i + 1, text: it.text })}>✎</button>}
                                {!closed && <button className="link" title="Remove" disabled={busy} onClick={() => removeStep(b, i + 1)}>×</button>}
                              </>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    {!closed && (
                      <form className="add-row" onSubmit={addStep(b)}>
                        <input name="step" placeholder="add a step…" />
                        <button type="submit" disabled={busy}>➕ Step</button>
                      </form>
                    )}
                    {(b.log || []).length > 0 && (
                      <pre className="text-mirror" style={{ margin: '4px 0' }}>
                        {b.log.map((l) => `${shortDate(l.created_at)} — ${l.text}`).join('\n')}
                      </pre>
                    )}
                    {!closed && (
                      <>
                        <form className="add-row" onSubmit={addLog(b)}>
                          <input name="line" placeholder="add a dated log line (fed the starter, smells lively…)" />
                          <button type="submit" disabled={busy}>Add line</button>
                        </form>
                        <div className="add-row" style={{ marginTop: 4 }}>
                          <button onClick={() => saveVersion(b)} disabled={busy || !items.length}>💾 Save as new version</button>
                          <button onClick={() => close(b)} disabled={busy}>🏁 Close batch</button>
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            );
          })}

          {versions.length > 0 && (
            <div className="metric-card">
              <div className="metric-head"><b>🌱 Recipe versions</b><span className="chip">{versions.filter((v) => !v.rejected).length} active</span></div>
              <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0' }}>
                {versions.map((v) => (
                  <li key={v.n} style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: v.rejected ? 0.55 : 1 }}>
                    <span style={{ flex: 1, textDecoration: v.rejected ? 'line-through' : 'none' }}>
                      #{v.n}{v.original ? ' (original)' : ''} · {v.steps} step{v.steps === 1 ? '' : 's'}
                      {v.latest && <span className="chip" style={{ marginLeft: 6 }}>← latest</span>}
                      {v.rejected && <span className="chip" style={{ marginLeft: 6 }}>✗ rejected</span>}
                    </span>
                    <button className="link" disabled={busy} onClick={() => reject(v.n, !v.rejected)}>
                      {v.rejected ? '↺ restore' : '✗ reject'}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="hint">Reject drops a bad version from the lineage so “start a run” uses the last good one — reversible.</p>
            </div>
          )}

          <div className="add-row" style={{ marginTop: 8 }}>
            <select value="" onChange={startRun} disabled={busy}>
              <option value="">start a run from a template…</option>
              {templates.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
            </select>
            {active && <button onClick={removeProcess} disabled={busy}>🗑 Delete process</button>}
          </div>
          {processes.length === 0 && (
            <p className="hint">A batch is one run of something you make again — a brew, a bake, a batch of soap. Save a task with steps as a template first; its steps become each run’s checklist. Tweak them as you go, then “Save as new version” to carry improvements into the next run.</p>
          )}
        </>
      )}
    </div>
  );
}
