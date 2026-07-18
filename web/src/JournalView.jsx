import { useEffect, useState } from 'react';
import * as api from './api.js';
import { ViewToggle } from './ModulesPanel.jsx';

// The Journal module's web view: today's entry (tappable checklist + note), a 14-day adherence strip
// (from the stored day summaries — the same hierarchical rows the AI rolls up), on-demand AI summaries,
// and the trends report. Same data as the chat's "entry"/"journal …" commands, via the same engine.
const dayKey = (offset = 0) => {
  const d = new Date(Date.now() + offset * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const PERIODS = [
  { key: 'today', label: 'Today' }, { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'Week' }, { key: 'month', label: 'Month' },
];

export default function JournalView() {
  const [journals, setJournals] = useState(null);
  const [active, setActive] = useState(null);     // journal name
  const [entry, setEntry] = useState(null);       // today's entry (or null until opened)
  const [days, setDays] = useState([]);           // stored day summaries, last 14 days
  const [summary, setSummary] = useState(null);   // { label, text, live } — the last requested summary/trends
  const [templates, setTemplates] = useState([]);
  const [view, setView] = useState('gui');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);        // any in-flight mutation
  const [thinking, setThinking] = useState(null); // which AI button is running (they can be slow locally)

  const journal = (journals || []).find((j) => j.name === active) || null;

  const loadJournals = async () => {
    try {
      const r = await api.getJournals();
      setJournals(r.journals); setError(null);
      if (r.journals.length && !r.journals.some((j) => j.name === active)) {
        const def = [...r.journals].sort((a, b) => (b.last_used_at || 0) - (a.last_used_at || 0))[0];
        setActive(def.name);
      }
    } catch (e) { setError(e.message); }
  };
  const loadActive = async (name) => {
    if (!name) { setEntry(null); setDays([]); return; }
    try {
      const [ents, sums] = await Promise.all([
        api.getJournalEntries(name, dayKey(0), dayKey(0)),
        api.getJournalSummaries(name, 'day', dayKey(-13), dayKey(0)),
      ]);
      setEntry(ents.entries[0] || null);
      setDays(sums.summaries);
    } catch (e) { setError(e.message); }
  };

  useEffect(() => { loadJournals(); api.getTemplates().then((r) => setTemplates(r.templates)).catch(() => {}); }, []);
  useEffect(() => { setSummary(null); loadActive(active); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [active]);

  const act = async (fn) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const openToday = () => act(async () => { const r = await api.openJournalEntry(active); setEntry(r.entry); });
  const toggle = (pos) => act(async () => { const r = await api.checkJournalItems(active, [pos]); setEntry(r.entry); });
  const addNote = (e) => {
    e.preventDefault();
    const text = e.target.elements.note.value.trim();
    if (!text) return;
    act(async () => { const r = await api.addJournalNote(active, text); setEntry(r.entry); e.target.reset(); });
  };
  const create = (e) => {
    e.preventDefault();
    const name = e.target.elements.name.value.trim();
    if (!name) return;
    act(async () => { await api.createJournal(name); e.target.reset(); await loadJournals(); setActive(name); });
  };
  const setTpl = (e) => {
    const template = e.target.value;
    if (!template) return;
    act(async () => { await api.setJournalTemplate(active, template); await loadJournals(); await loadActive(active); });
  };
  const remove = () => {
    if (!window.confirm(`Delete “${active}” and ALL of its entries + summaries? This can’t be undone.`)) return;
    act(async () => { await api.deleteJournal(active); setActive(null); await loadJournals(); });
  };
  const askSummary = (period) => {
    if (thinking) return;
    setThinking(period); setError(null);
    api.makeJournalSummary(active, period)
      .then((r) => setSummary({ label: `${PERIODS.find((p) => p.key === period)?.label} · ${r.summary.period_key}`, text: r.summary.summary, live: !!r.summary.live }))
      .catch((e) => setError(e.message))
      .finally(() => setThinking(null));
  };
  const askTrends = () => {
    if (thinking) return;
    setThinking('trends'); setError(null);
    api.getJournalTrends(active)
      .then((r) => setSummary({ label: 'Trends', text: r.message, live: false }))
      .catch((e) => setError(e.message))
      .finally(() => setThinking(null));
  };

  if (error && !journals) return <p className="err">⚠ {error}</p>;
  if (!journals) return <p className="hint">Loading…</p>;

  // The chat-equivalent text (the "Text" half of the GUI/Text toggle): today's card as the bot renders it.
  const textMirror = () => {
    if (!journal) return 'No journals yet. Start one with: journal new <name>';
    const items = entry?.checklist || [];
    const done = items.filter((i) => i.done).length;
    return [
      `📔 ${journal.name} — ${dayKey(0)}`,
      entry
        ? (items.length ? `Checklist ${done}/${items.length}:\n${items.map((it, i) => `${i + 1}. ${it.done ? '☑' : '☐'} ${it.text}`).join('\n')}` : 'No checklist — “journal template <name>” snapshots one.')
        : 'No entry for today yet — “entry” opens it.',
      entry?.note ? `📝 ${entry.note}` : null,
      summary ? `\n${summary.label}\n${summary.text}` : null,
    ].filter(Boolean).join('\n');
  };

  return (
    <div className="module-view">
      <div className="module-bar">
        <div className="range-tabs">
          {journals.map((j) => (
            <button key={j.id} className={j.name === active ? 'on' : ''} onClick={() => setActive(j.name)}>📔 {j.name}</button>
          ))}
        </div>
        <ViewToggle view={view} onView={setView} />
      </div>
      {error && <p className="err">⚠ {error}</p>}

      {view === 'text' ? (
        <pre className="text-mirror">{textMirror()}</pre>
      ) : (
        <>
          {journal && (
            <div className="metric-card">
              <div className="metric-head">
                <b>{journal.name} — {dayKey(0)}</b>
                {journal.template_name && <span className="chip">♻️ {journal.template_name}</span>}
                <span className="chip">{days.length ? `${days.length} day summar${days.length === 1 ? 'y' : 'ies'} / 14d` : 'no summaries yet'}</span>
              </div>

              {/* 14-day adherence strip: one cell per day, ☑-count over total, from stored day summaries. */}
              <div className="journal-strip" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', margin: '6px 0' }}>
                {Array.from({ length: 14 }, (_, i) => {
                  const k = dayKey(i - 13);
                  const s = days.find((d) => d.period_key === k);
                  const st = s?.stats_json ? JSON.parse(s.stats_json) : null;
                  const label = st && st.total ? `${st.checked}/${st.total}` : (s ? '📝' : '·');
                  return (
                    <span key={k} className="chip" title={`${k}${s ? ` — ${s.summary}` : ' — no entry'}`}
                      style={{ opacity: s ? 1 : 0.4, minWidth: 34, textAlign: 'center' }}>{label}</span>
                  );
                })}
              </div>

              {!entry ? (
                <button onClick={openToday} disabled={busy}>➕ Open today’s entry</button>
              ) : (
                <>
                  {(entry.checklist || []).length === 0 && (
                    <p className="hint">No checklist — pick a template below and tomorrow’s entry will carry it (today stays note-only).</p>
                  )}
                  <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0' }}>
                    {(entry.checklist || []).map((it, i) => (
                      <li key={i}>
                        <label style={{ cursor: 'pointer' }}>
                          <input type="checkbox" checked={!!it.done} disabled={busy} onChange={() => toggle(i + 1)} /> {it.text}
                        </label>
                      </li>
                    ))}
                  </ul>
                  {entry.note && <pre className="text-mirror" style={{ margin: '4px 0' }}>📝 {entry.note}</pre>}
                  <form className="add-row" onSubmit={addNote}>
                    <input name="note" placeholder="add to today’s note (symptoms, food, anything)…" />
                    <button type="submit" disabled={busy}>Add note</button>
                  </form>
                </>
              )}

              <div className="module-bar" style={{ marginTop: 8 }}>
                <div className="range-tabs">
                  {PERIODS.map((p) => (
                    <button key={p.key} disabled={!!thinking} onClick={() => askSummary(p.key)}>
                      {thinking === p.key ? '…' : p.label}
                    </button>
                  ))}
                  <button disabled={!!thinking} onClick={askTrends}>{thinking === 'trends' ? '…' : '🧭 Trends'}</button>
                </div>
              </div>
              {summary && (
                <div>
                  <div className="fld-label">{summary.label}{summary.live ? ' (still moving — filed overnight)' : ''}</div>
                  <pre className="text-mirror">{summary.text}</pre>
                </div>
              )}

              <div className="add-row" style={{ marginTop: 8 }}>
                <select value="" onChange={setTpl} disabled={busy}>
                  <option value="">checklist from template…</option>
                  {templates.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                </select>
                <button onClick={remove} disabled={busy}>🗑 Delete journal</button>
              </div>
            </div>
          )}

          <form className="add-row" onSubmit={create}>
            <input name="name" placeholder="new journal (e.g. food — or a pet’s name)" />
            <button type="submit" disabled={busy}>➕ New journal</button>
          </form>
          {journals.length === 0 && (
            <p className="hint">A journal is a small daily checklist + note the AI reads back over weeks — good for spotting food triggers, sleep patterns, even a pet’s symptoms. Patterns, not diagnoses.</p>
          )}
        </>
      )}
    </div>
  );
}
