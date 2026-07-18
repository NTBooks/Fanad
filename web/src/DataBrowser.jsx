import { useEffect, useState } from 'react';
import * as api from './api.js';

const PAGE = 50;

// Epoch-ms timestamps (every "*_at" column, plus task_outcomes' bare "at") render as readable dates;
// everything else passes through, with very long text clipped (full value stays in the cell's title).
function fmt(col, val) {
  if (val === null || val === undefined) return '—';
  if ((col === 'at' || col.endsWith('_at')) && typeof val === 'number' && val > 1e12) {
    return new Date(val).toLocaleString();
  }
  const s = String(val);
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}

export default function DataBrowser({ onClose }) {
  const [entities, setEntities] = useState(null); // [{ key, label, count, editable, deletable }]
  const [active, setActive] = useState(null);     // selected view key
  const [view, setView] = useState(null);         // { columns, rows, total, offset, editable, deletable }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);   // { id, values: { col: val } }

  const loadIndex = () => api.getData()
    .then(({ entities: e }) => { setEntities(e); setActive((a) => a || e[0]?.key || null); })
    .catch((err) => setError(err.message));

  useEffect(() => { loadIndex(); }, []);

  function loadRows(key, offset) {
    setBusy(true); setError(null); setEditing(null);
    api.getDataRows(key, { limit: PAGE, offset })
      .then(setView)
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false));
  }

  useEffect(() => { if (active) loadRows(active, 0); }, [active]);

  async function del(id) {
    if (!window.confirm('Delete this record? This can’t be undone.')) return;
    setError(null);
    try {
      await api.deleteDataRow(active, id);
      loadRows(active, view.offset);
      loadIndex();
    } catch (err) { setError(err.message); }
  }

  async function saveEdit() {
    setError(null);
    try {
      await api.updateDataRow(active, editing.id, editing.values);
      setEditing(null);
      loadRows(active, view.offset);
    } catch (err) { setError(err.message); }
  }

  const cur = entities?.find((e) => e.key === active);
  const hasActions = view && (view.deletable || view.editable.length > 0);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings data" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Your data</h2>
          <button className="x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="hint">
          Everything Fanad has stored for this account — browse, tidy, or delete it. This view is
          web-only; it never appears in Telegram.
        </p>

        <div className="data-layout">
          <nav className="data-nav">
            {(entities || []).map((e) => (
              <button key={e.key} className={e.key === active ? 'on' : ''} onClick={() => setActive(e.key)}>
                <span>{e.label}</span><span className="n">{e.count}</span>
              </button>
            ))}
          </nav>

          <div className="data-main">
            {error && <p className="err">⚠ {error}</p>}
            {!view ? (
              <p className="hint">Loading…</p>
            ) : view.rows.length === 0 ? (
              <p className="hint">No {cur?.label.toLowerCase()} yet.</p>
            ) : (
              <>
                <table className="data-table">
                  <thead>
                    <tr>
                      {view.columns.map((c) => <th key={c}>{c}</th>)}
                      {hasActions ? <th aria-label="actions" /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {view.rows.map((row) => {
                      const isEditing = editing && editing.id === row.id;
                      return (
                        <tr key={row[view.columns[0]]}>
                          {view.columns.map((c) => (
                            <td key={c} title={row[c] == null ? '' : String(row[c])}>
                              {isEditing && view.editable.includes(c) ? (
                                <input
                                  value={editing.values[c] ?? ''}
                                  onChange={(ev) => setEditing((s) => ({ ...s, values: { ...s.values, [c]: ev.target.value } }))}
                                />
                              ) : fmt(c, row[c])}
                            </td>
                          ))}
                          {hasActions ? (
                            <td className="row-actions">
                              {isEditing ? (
                                <>
                                  <button className="link" onClick={saveEdit}>Save</button>
                                  <button className="link" onClick={() => setEditing(null)}>Cancel</button>
                                </>
                              ) : (
                                <>
                                  {view.editable.length > 0 && (
                                    <button
                                      className="link" title="Edit"
                                      onClick={() => setEditing({ id: row.id, values: Object.fromEntries(view.editable.map((c) => [c, row[c] ?? ''])) })}
                                    >✎</button>
                                  )}
                                  {view.deletable && <button className="link danger" title="Delete" onClick={() => del(row.id)}>🗑</button>}
                                </>
                              )}
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                <div className="data-foot">
                  <span className="hint">{view.offset + 1}–{view.offset + view.rows.length} of {view.total}</span>
                  <span>
                    <button className="ghost" disabled={busy || view.offset === 0} onClick={() => loadRows(active, Math.max(0, view.offset - PAGE))}>‹ Prev</button>
                    <button className="ghost" disabled={busy || view.offset + view.rows.length >= view.total} onClick={() => loadRows(active, view.offset + PAGE)}>Next ›</button>
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
