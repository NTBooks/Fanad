import { useEffect, useRef, useState } from 'react';
import * as api from './api.js';

const fmtTime = (t) => new Date(t).toLocaleTimeString();

// Live tail of the AI activity log: every LLM call plus the /whatdo decision event. Polls incrementally by
// seq every ~1.5s while open. Each row expands to show the full prompt, the raw reply, and any <think>
// reasoning — so you can see exactly what the model received and produced, and whether a recommendation was
// the AI's choice or a silent fallback. Gated server-side by the Settings toggle (DB-backed).
export default function AiLog({ onClose }) {
  const [lines, setLines] = useState([]);
  const [open, setOpen] = useState({}); // seq -> expanded?
  const [err, setErr] = useState(null);
  const sinceRef = useRef(0);
  const bodyRef = useRef(null);
  const stickRef = useRef(true); // keep pinned to the bottom unless the user scrolls up

  useEffect(() => {
    let alive = true;
    const tick = () => api.getAiLog(sinceRef.current)
      .then(({ logs, seq }) => {
        if (!alive) return;
        setErr(null); // the poll recovered — don't leave a stale error banner up
        if (!logs?.length) return;
        sinceRef.current = seq;
        setLines((prev) => [...prev, ...logs].slice(-300));
      })
      .catch((e) => { if (alive) setErr(e.message); });
    tick();
    const id = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Autoscroll to newest, but only if the user is already at the bottom.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  async function clearAll() {
    // Only blank the view once the server actually cleared — otherwise the panel would show a false
    // success while the ring buffer (full prompts/replies) still holds everything.
    try { await api.clearAiLog(); } catch (e) { setErr(`Clear failed: ${e.message}`); return; }
    sinceRef.current = 0;
    setLines([]); setOpen({}); setErr(null);
  }

  const toggle = (seq) => setOpen((o) => ({ ...o, [seq]: !o[seq] }));

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings dbg" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>🧠 AI activity log</h2>
          <button className="x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="hint">
          Live tail of every model call (newest at the bottom). Tap a row to see the full prompt, the raw
          reply, and the model’s <code>&lt;think&gt;</code> reasoning. The <code>suggest</code> rows show why
          <code> /whatdo</code> picked what it did — candidate scores, whether embeddings fired, and whether
          the AI chose or it fell back.
        </p>
        {err && <p className="bad">⚠ {err}</p>}
        <div className="dbg-body" ref={bodyRef} onScroll={onScroll}>
          {lines.length === 0
            ? <div className="dbg-empty">No AI activity yet — leave this open and use the app…</div>
            : lines.map((l) => (
              <div key={l.seq} className={`ai-entry${l.ok ? '' : ' bad'}`}>
                <button type="button" className="ai-row" onClick={() => toggle(l.seq)}>
                  <span className="ai-caret">{open[l.seq] ? '▾' : '▸'}</span>
                  <span className="dbg-t">{fmtTime(l.t)}</span>
                  <span className="ai-kind">{l.purpose || l.kind}</span>
                  {l.model && <span className="ai-model">{l.model}</span>}
                  {l.ms > 0 && <span className="ai-ms">{l.ms}ms</span>}
                  {l.kind !== 'suggest' && <span className={`ai-badge ${l.ok ? 'ok' : 'bad'}`}>{l.ok ? 'ok' : 'fail'}</span>}
                  {l.kind === 'suggest' && l.meta && (
                    <span className={`ai-badge ${l.meta.llmDecided ? 'ok' : 'warn'}`}>{l.meta.llmDecided ? 'AI chose' : 'fallback'}</span>
                  )}
                </button>
                {open[l.seq] && (
                  <div className="ai-detail">
                    {l.prompt && <><div className="ai-lbl">prompt</div><pre>{l.prompt}</pre></>}
                    {l.reasoning && <><div className="ai-lbl">thinking</div><pre className="ai-think">{l.reasoning}</pre></>}
                    {l.response && <><div className="ai-lbl">response</div><pre>{l.response}</pre></>}
                    {l.error && <><div className="ai-lbl">error</div><pre className="ai-think">{l.error}</pre></>}
                    {l.meta && <><div className="ai-lbl">details</div><pre>{JSON.stringify(l.meta, null, 2)}</pre></>}
                  </div>
                )}
              </div>
            ))}
        </div>
        <div className="settings-foot">
          <button className="ghost" onClick={() => { setLines([]); setOpen({}); }}>Clear view</button>
          <button className="ghost danger" onClick={clearAll}>Clear log</button>
        </div>
      </div>
    </div>
  );
}
