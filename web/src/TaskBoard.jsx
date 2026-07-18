import { useEffect, useRef, useState } from 'react';
import { m } from 'framer-motion';
import * as api from './api.js';
import { ViewToggle } from './ModulesPanel.jsx';

// P1 = highest (confirmed convention, shared/priority.js): user-facing P1/P2/P3 map to stored 3/2/1. This is
// a fixed 3-level scale, not the runtime-mutable taxonomy, so a tiny local map is fine (categories still come
// from the server via cfg). Kept in sync with shared/priority.js by convention.
const PRIOS = [{ v: 3, label: 'P1 · high', mark: '🔴' }, { v: 2, label: 'P2 · med', mark: '🟠' }, { v: 1, label: 'P3 · low', mark: '🔵' }];
const prioOf = (v) => PRIOS.find((p) => p.v === v) || null;

const COLUMNS = [
  { status: 'available', title: 'Not Started' },
  { status: 'in_progress', title: 'Started' },
  { status: 'done', title: 'Done Today' },
];

const sameDay = (a, b) => {
  const d1 = new Date(a); const d2 = new Date(b);
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
};
const parseSteps = (t) => { try { return t.steps_json ? JSON.parse(t.steps_json) : []; } catch { return []; } };
// A task's stored link preview (server repo.parseLink's little sibling) — only a plain http(s) url counts.
const parseLink = (t) => {
  try {
    const l = t.link_json ? JSON.parse(t.link_json) : null;
    return (l && /^https?:\/\//i.test(l.url || '')) ? l : null;
  } catch { return null; }
};
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const ymd = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const dtLocal = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const catLabel = (cfg, key) => cfg?.categories?.find((c) => c.key === key)?.label || key;
const wakeLabel = (ms) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dueBadge = (t) => {
  if (t.due_at == null) return null;
  const d = new Date(t.due_at);
  return `⏳ ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
};

export default function TaskBoard({ cfg }) {
  const [tasks, setTasks] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState('gui');
  const [addText, setAddText] = useState('');
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState(null);   // task id whose detail editor is open
  const [showSlept, setShowSlept] = useState(false);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [dragOver, setDragOver] = useState(null); // status column currently hovered
  const dragId = useRef(null);

  const load = () => api.getTasks().then((r) => { setTasks(r.tasks); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  // Buckets. Slept tasks (auto-hidden after ~3 weeks) stay status 'available' with slept_at set — keep them
  // out of every column and behind the drawer. Snoozed tasks (status 'snoozed' + a wake timer) get their own
  // drawer, so they aren't a black hole. Done tasks only show if completed TODAY; older ones are hidden.
  const all = tasks || [];
  const slept = all.filter((t) => t.slept_at);
  const snoozed = all.filter((t) => t.status === 'snoozed');
  const visible = all.filter((t) => !t.slept_at);
  const byCol = {
    available: visible.filter((t) => t.status === 'available'),
    in_progress: visible.filter((t) => t.status === 'in_progress'),
    done: visible.filter((t) => t.status === 'done' && t.completed_at && sameDay(t.completed_at, Date.now())),
  };
  const editing = editId != null ? all.find((t) => t.id === editId) : null;

  async function act(fn) {
    if (busy) return;
    setBusy(true); setError(null);
    try { await fn(); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const addTask = () => { const t = addText.trim(); if (!t) return; setAddText(''); act(() => api.createTask(t)); };
  const moveTo = (status) => { const id = dragId.current; dragId.current = null; setDragOver(null); if (id != null) act(() => api.setTaskStatus(id, status)); };

  if (error && !tasks) return <p className="err">⚠ {error}</p>;
  if (!tasks) return <p className="hint">Loading…</p>;

  return (
    <div className="module-view">
      <div className="module-bar">
        <form className="add-row" onSubmit={(e) => { e.preventDefault(); addTask(); }}>
          <input value={addText} onChange={(e) => setAddText(e.target.value)} placeholder="Add a task…" />
          <button type="submit" disabled={busy || !addText.trim()}>Add</button>
        </form>
        <ViewToggle view={view} onView={setView} />
      </div>
      {error && <p className="err">⚠ {error}</p>}

      {view === 'text' ? (
        <pre className="text-mirror">{textMirror(byCol, slept, snoozed, cfg)}</pre>
      ) : (
        <>
          <div className="kanban">
            {COLUMNS.map((col) => (
              <div
                key={col.status}
                className={`kan-col${dragOver === col.status ? ' over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(col.status); }}
                onDragLeave={() => setDragOver((s) => (s === col.status ? null : s))}
                onDrop={() => moveTo(col.status)}
              >
                <div className="kan-head">{col.title} <span className="n">{byCol[col.status].length}</span></div>
                {byCol[col.status].map((t) => {
                  const steps = parseSteps(t); const doneSteps = steps.filter((s) => s.done).length;
                  const p = prioOf(t.priority); const due = dueBadge(t); const link = parseLink(t);
                  return (
                    // `layout` (transform-only) slides a card to its new column on drag-drop/status change
                    // instead of teleporting it.
                    <m.div
                      key={t.id} className="kan-card" layout draggable
                      onDragStart={() => { dragId.current = t.id; }}
                      onClick={() => setEditId(t.id)}
                    >
                      <div className="kan-sum">{t.summary}</div>
                      <div className="kan-meta">
                        <span className="chip">{catLabel(cfg, t.category)}</span>
                        {p && <span className="chip prio">{p.mark} {p.label.split(' · ')[0]}</span>}
                        {t.effort_level && <span className="chip effort">{t.effort_level}</span>}
                        {due && <span className="chip due">{due}</span>}
                        {steps.length > 0 && <span className="chip">🪜 {doneSteps}/{steps.length}</span>}
                        {link && (
                          // stopPropagation: the card's own onClick opens the edit modal — a link tap shouldn't.
                          <a className="chip link-chip" href={link.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                            🔗 {hostOf(link.url)}
                          </a>
                        )}
                      </div>
                    </m.div>
                  );
                })}
                {byCol[col.status].length === 0 && <div className="kan-empty">—</div>}
              </div>
            ))}
          </div>

          {slept.length > 0 && (
            <div className="slept-drawer">
              <button className="link" onClick={() => setShowSlept((s) => !s)}>💤 Slept ({slept.length}) {showSlept ? '▾' : '▸'}</button>
              {showSlept && (
                <div className="slept-list">
                  {slept.map((t) => (
                    <div key={t.id} className="slept-item">
                      <span>{t.summary}</span>
                      <button className="link" onClick={() => act(() => api.wakeTasks([t.id]))}>wake</button>
                    </div>
                  ))}
                  <button className="link" onClick={() => act(() => api.wakeTasks(slept.map((t) => t.id)))}>wake all</button>
                </div>
              )}
            </div>
          )}

          {snoozed.length > 0 && (
            <div className="slept-drawer">
              <button className="link" onClick={() => setShowSnoozed((s) => !s)}>😴 Snoozed ({snoozed.length}) {showSnoozed ? '▾' : '▸'}</button>
              {showSnoozed && (
                <div className="slept-list">
                  {snoozed.map((t) => (
                    <div key={t.id} className="slept-item">
                      <span>{t.summary}{t.snoozed_until ? ` · wakes ${wakeLabel(t.snoozed_until)}` : ''}</span>
                      <button className="link" onClick={() => act(() => api.setTaskStatus(t.id, 'available'))}>unsnooze</button>
                    </div>
                  ))}
                  <button className="link" onClick={() => act(async () => { for (const t of snoozed) await api.setTaskStatus(t.id, 'available'); })}>unsnooze all</button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {editing && (
        <TaskEditor
          task={editing} cfg={cfg} busy={busy}
          onClose={() => setEditId(null)}
          onChange={load}
          setError={setError}
        />
      )}
    </div>
  );
}

// Numbered text listing grouped by column + the slept/snoozed drawers — the "current state as text" mirror.
function textMirror(byCol, slept, snoozed, cfg) {
  const line = (t, i) => {
    const bits = [catLabel(cfg, t.category)];
    const p = prioOf(t.priority); if (p) bits.push(p.label.split(' · ')[0]);
    if (t.due_at) bits.push(`due ${new Date(t.due_at).toLocaleDateString()}`);
    return `  ${i + 1}. ${t.summary}  [${bits.join(' · ')}]`;
  };
  const block = (title, arr) => `${title} (${arr.length})\n${arr.length ? arr.map(line).join('\n') : '  —'}`;
  let out = [block('NOT STARTED', byCol.available), block('STARTED', byCol.in_progress), block('DONE TODAY', byCol.done)].join('\n\n');
  if (slept.length) out += `\n\n💤 SLEPT (${slept.length})\n${slept.map((t, i) => `  ${i + 1}. ${t.summary}`).join('\n')}`;
  if (snoozed.length) out += `\n\n😴 SNOOZED (${snoozed.length})\n${snoozed.map((t, i) => `  ${i + 1}. ${t.summary}${t.snoozed_until ? ` · wakes ${wakeLabel(t.snoozed_until)}` : ''}`).join('\n')}`;
  return out;
}

// The per-task detail editor — full parity with the chat's task menu: rename, re-categorize, priority,
// deadline + reminder, steps, snooze/archive/complete, and save-as-template. Every control calls the repo
// setter behind its REST route, then asks the board to reload.
function TaskEditor({ task, cfg, busy, onClose, onChange, setError }) {
  const steps = parseSteps(task);
  const run = async (fn) => { try { await fn(); await onChange(); } catch (e) { setError(e.message); } };
  const patch = (p) => run(() => api.patchTask(task.id, p));

  return (
    <div className="settings-overlay nested" onClick={onClose}>
      <div className="task-editor" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h3>Edit task</h3>
          <button className="x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <label className="fld">
          <span>Summary</span>
          <input defaultValue={task.summary} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== task.summary) patch({ summary: v }); }} />
        </label>

        <div className="fld-row">
          <label className="fld">
            <span>Category</span>
            <select value={task.category} onChange={(e) => patch({ category: e.target.value })}>
              {(cfg?.categories || []).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
          <label className="fld">
            <span>Priority</span>
            <select value={task.priority ?? ''} onChange={(e) => patch({ priority: e.target.value === '' ? null : Number(e.target.value) })}>
              <option value="">none</option>
              {PRIOS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
            </select>
          </label>
        </div>

        <div className="fld-row">
          <label className="fld">
            <span>Deadline</span>
            <input
              type="date" defaultValue={task.due_at ? ymd(task.due_at) : ''}
              onChange={(e) => {
                const v = e.target.value;
                patch(v ? { dueAt: new Date(`${v}T23:59:59`).getTime(), dueKind: 'by', remindAt: task.remind_at ?? null }
                  : { dueAt: null, dueKind: null, remindAt: task.remind_at ?? null });
              }}
            />
          </label>
          <label className="fld">
            <span>Reminder</span>
            <input
              type="datetime-local" defaultValue={task.remind_at ? dtLocal(task.remind_at) : ''}
              onChange={(e) => { const v = e.target.value; patch({ remindAt: v ? new Date(v).getTime() : null }); }}
            />
          </label>
        </div>

        <div className="steps">
          <span className="fld-label">Steps</span>
          {steps.map((s, i) => (
            <div key={i} className="step">
              <label>
                <input type="checkbox" checked={!!s.done} onChange={(e) => run(() => api.setTaskStep(task.id, i + 1, e.target.checked))} />
                <span className={s.done ? 'done' : ''}>{s.text}</span>
              </label>
              <button className="link danger" title="Remove step" onClick={() => run(() => api.removeTaskStep(task.id, i + 1))}>🗑</button>
            </div>
          ))}
          <form
            className="add-row" onSubmit={(e) => { e.preventDefault(); const inp = e.target.elements.step; const v = inp.value.trim(); if (v) { inp.value = ''; run(() => api.addTaskStep(task.id, v)); } }}
          >
            <input name="step" placeholder="Add a step…" />
            <button type="submit">Add</button>
          </form>
        </div>

        <div className="editor-actions">
          {task.status !== 'in_progress' && task.status !== 'done' && (
            <button disabled={busy} onClick={() => run(() => api.setTaskStatus(task.id, 'in_progress').then(onClose))}>▶ Start</button>
          )}
          {task.status === 'in_progress' && (
            <button disabled={busy} onClick={() => run(() => api.setTaskStatus(task.id, 'available').then(onClose))}>⏸ Unstart</button>
          )}
          {task.status !== 'done' && (
            <button disabled={busy} onClick={() => run(() => api.setTaskStatus(task.id, 'done').then(onClose))}>✓ Complete</button>
          )}
          {task.status === 'done' && (
            <button disabled={busy} onClick={() => run(() => api.setTaskStatus(task.id, 'available').then(onClose))}>↺ Reopen</button>
          )}
          <button disabled={busy} onClick={() => run(() => api.setTaskStatus(task.id, 'snoozed', { until: Date.now() + 86400000 }).then(onClose))}>💤 Snooze 1d</button>
          <button disabled={busy} onClick={() => { const n = (window.prompt('Template name:') || '').trim(); if (n) run(() => api.saveTaskTemplate(task.id, n)); }}>📄 Save as template</button>
          <button className="danger" disabled={busy} onClick={() => { if (window.confirm('Archive this task?')) run(() => api.setTaskStatus(task.id, 'archived').then(onClose)); }}>Archive</button>
        </div>
      </div>
    </div>
  );
}
