import { useEffect, useState } from 'react';
import * as api from './api.js';
import { ViewToggle } from './ModulesPanel.jsx';

const stepCount = (t) => { try { return t.steps_json ? JSON.parse(t.steps_json).length : 0; } catch { return 0; } };
const catLabel = (cfg, key) => cfg?.categories?.find((c) => c.key === key)?.label || key;

// Saved task blueprints — the calm alternative to recurring tasks. A gallery of cards; "Use" materializes a
// fresh task from the template, "Delete" removes the blueprint. (Save-as-template lives on the task board.)
// Text tab lists them.
export default function TemplatesView({ cfg }) {
  const [templates, setTemplates] = useState(null);
  const [view, setView] = useState('gui');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const load = () => api.getTemplates().then((r) => { setTemplates(r.templates); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function act(fn) {
    if (busy) return; setBusy(true); setError(null);
    try { await fn(); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const use = (name) => act(async () => { await api.materializeTemplate(name); setToast(`“${name}” added to your tasks.`); setTimeout(() => setToast(null), 3000); });

  if (error && !templates) return <p className="err">⚠ {error}</p>;
  if (!templates) return <p className="hint">Loading…</p>;

  return (
    <div className="module-view">
      <div className="module-bar">
        <span className="hint">Save a task as a template from the Tasks board (📄 Save as template).</span>
        <ViewToggle view={view} onView={setView} />
      </div>
      {error && <p className="err">⚠ {error}</p>}
      {toast && <p className="toast">✓ {toast}</p>}

      {view === 'text' ? (
        <pre className="text-mirror">{templates.length ? templates.map((t, i) => `${i + 1}. ${t.name} — ${t.summary} [${catLabel(cfg, t.category)}${stepCount(t) ? `, ${stepCount(t)} steps` : ''}]`).join('\n') : 'No templates yet.'}</pre>
      ) : templates.length === 0 ? (
        <p className="hint">No templates yet. Save one from a task to reuse its shape later.</p>
      ) : (
        <div className="tpl-grid">
          {templates.map((t) => (
            <div key={t.id} className="tpl-card">
              <div className="tpl-name">{t.name}</div>
              <div className="tpl-summary">{t.summary}</div>
              <div className="kan-meta">
                <span className="chip">{catLabel(cfg, t.category)}</span>
                {t.effort_level && <span className="chip effort">{t.effort_level}</span>}
                {stepCount(t) > 0 && <span className="chip">🪜 {stepCount(t)}</span>}
              </div>
              <div className="editor-actions">
                <button disabled={busy} onClick={() => use(t.name)}>➜ Use</button>
                <button className="danger" disabled={busy} onClick={() => { if (window.confirm(`Delete template “${t.name}”?`)) act(() => api.deleteTemplate(t.name)); }}>🗑 Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
