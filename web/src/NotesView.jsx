import { useEffect, useState } from 'react';
import * as api from './api.js';
import { ViewToggle } from './ModulesPanel.jsx';

const FILTERS = [
  { key: 'active', label: 'Active', status: null },
  { key: 'new', label: 'New', status: 'new' },
  { key: 'reviewed', label: 'Kept', status: 'reviewed' },
  { key: 'archived', label: 'Archived', status: 'archived' },
];
const when = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const preview = (t) => { const s = (t || '').replace(/\s+/g, ' ').trim(); return s.length > 60 ? `${s.slice(0, 60)}…` : s || '(empty)'; };

// The self-voicemail inbox as a browsable list + editor pane. Left: filter tabs, a "new note" composer, and
// a recall search; the note list underneath. Right: the selected note — edit text/title, or keep / promote
// to a task / archive / delete. Text tab mirrors the list.
export default function NotesView() {
  const [notes, setNotes] = useState(null);
  const [filter, setFilter] = useState('active');
  const [selId, setSelId] = useState(null);
  const [view, setView] = useState('gui');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [addText, setAddText] = useState('');
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState({ text: '', title: '' });

  const cur = FILTERS.find((f) => f.key === filter);
  const load = () => api.getNotes(cur.status).then((r) => { setNotes(r.notes); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter]);

  const sel = notes?.find((n) => n.id === selId) || null;
  useEffect(() => { setDraft({ text: sel?.text || '', title: sel?.title || '' }); }, [selId, sel?.text, sel?.title]);

  async function act(fn, keepSel = true) {
    if (busy) return; setBusy(true); setError(null);
    try { await fn(); if (!keepSel) setSelId(null); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const addNote = () => { const t = addText.trim(); if (!t) return; setAddText(''); act(async () => { const r = await api.createNote(t); setSelId(r.note.id); }); };
  const runRecall = async () => {
    const term = q.trim(); if (!term) return load();
    setBusy(true); setError(null);
    try { const r = await api.recall(term); setNotes(r.notes); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const saveDraft = () => {
    if (!sel) return;
    if (draft.text.trim() && (draft.text !== sel.text || draft.title !== (sel.title || ''))) {
      act(() => api.patchNote(sel.id, { text: draft.text, title: draft.title || null }));
    }
  };

  if (error && !notes) return <p className="err">⚠ {error}</p>;
  if (!notes) return <p className="hint">Loading…</p>;

  return (
    <div className="module-view">
      <div className="module-bar">
        <form className="add-row" onSubmit={(e) => { e.preventDefault(); addNote(); }}>
          <input value={addText} onChange={(e) => setAddText(e.target.value)} placeholder="Jot a note…" />
          <button type="submit" disabled={busy || !addText.trim()}>Add</button>
        </form>
        <ViewToggle view={view} onView={setView} />
      </div>
      {error && <p className="err">⚠ {error}</p>}

      {view === 'text' ? (
        <pre className="text-mirror">{notes.map((n, i) => `${i + 1}. ${n.title ? `[${n.title}] ` : ''}${preview(n.text)}  ·  ${when(n.created_at)} (${n.status})`).join('\n') || 'No notes.'}</pre>
      ) : (
        <div className="notes-split">
          <aside className="notes-side">
            <div className="filter-tabs">
              {FILTERS.map((f) => (
                <button key={f.key} className={f.key === filter ? 'on' : ''} onClick={() => { setFilter(f.key); setSelId(null); }}>{f.label}</button>
              ))}
            </div>
            <form className="recall-row" onSubmit={(e) => { e.preventDefault(); runRecall(); }}>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 Recall…" />
              {q && <button type="button" className="link" onClick={() => { setQ(''); load(); }}>clear</button>}
            </form>
            <div className="notes-list">
              {notes.length === 0 ? <p className="hint">No notes.</p> : notes.map((n) => (
                <button key={n.id} className={`note-item${n.id === selId ? ' on' : ''}`} onClick={() => setSelId(n.id)}>
                  <span className="note-title">{n.title || preview(n.text)}</span>
                  <span className="note-date">{when(n.created_at)}</span>
                </button>
              ))}
            </div>
          </aside>

          <div className="notes-pane">
            {!sel ? <p className="hint">Select a note, or jot a new one.</p> : (
              <>
                <input className="note-title-edit" value={draft.title} placeholder="Title (optional)"
                  onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} onBlur={saveDraft} />
                <textarea className="note-text-edit" value={draft.text} rows={10}
                  onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))} onBlur={saveDraft} />
                <div className="editor-actions">
                  <button disabled={busy} onClick={saveDraft}>Save</button>
                  {sel.status !== 'reviewed' && <button disabled={busy} onClick={() => act(() => api.reviewNote(sel.id, 'keep'))}>Keep</button>}
                  <button disabled={busy} onClick={() => act(() => api.reviewNote(sel.id, 'promote'))}>➜ Task</button>
                  {sel.status !== 'archived' && <button disabled={busy} onClick={() => act(() => api.reviewNote(sel.id, 'archive'), false)}>Archive</button>}
                  <button className="danger" disabled={busy} onClick={() => { if (window.confirm('Delete this note?')) act(() => api.deleteNote(sel.id), false); }}>🗑 Delete</button>
                </div>
                {sel.promoted_task_id && <p className="hint">Promoted to a task.</p>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
