import { useEffect, useRef, useState } from 'react';
import * as api from './api.js';

const fmtTime = (t) => new Date(t).toLocaleTimeString();

// Live tail of captured server logs. Polls incrementally (by seq) every ~1.5s while open, so new
// lines stream in as you, say, send the Telegram bot a message. Dev-only — gated by DEBUG_LOG server-side.
export default function DebugLog({ onClose }) {
  const [lines, setLines] = useState([]);
  const [err, setErr] = useState(null);
  const sinceRef = useRef(0);
  const bodyRef = useRef(null);
  const stickRef = useRef(true); // keep pinned to the bottom unless the user scrolls up

  useEffect(() => {
    let alive = true;
    const tick = () => api.getDebugLog(sinceRef.current)
      .then(({ logs, seq }) => {
        if (!alive) return;
        setErr(null); // the poll recovered — don't leave a stale error banner up
        if (!logs?.length) return;
        sinceRef.current = seq;
        setLines((prev) => [...prev, ...logs].slice(-1000));
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

  const copyAll = () => {
    const text = lines.map((l) => `${fmtTime(l.t)} [${l.level}] ${l.msg}`).join('\n');
    // navigator.clipboard is undefined off HTTPS/localhost — without the guard "Copy all" is a silent no-op.
    if (!navigator.clipboard) { setErr('Copy failed — the clipboard needs HTTPS or localhost'); return; }
    navigator.clipboard.writeText(text).then(() => setErr(null), (e) => setErr(`Copy failed: ${e.message}`));
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings dbg" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>🐞 Server log</h2>
          <button className="x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="hint">
          Live tail of the server console (newest at the bottom). Dev-only — visible because
          <code> DEBUG_LOG</code> is set. Send the bot a message and watch the <code>[tg]</code> lines.
        </p>
        {err && <p className="bad">⚠ {err}</p>}
        <div className="dbg-body" ref={bodyRef} onScroll={onScroll}>
          {lines.length === 0
            ? <div className="dbg-empty">No log lines yet…</div>
            : lines.map((l) => (
              <div key={l.seq} className={`dbg-line ${l.level}`}>
                <span className="dbg-t">{fmtTime(l.t)}</span>
                <span className="dbg-lvl">{l.level}</span>
                <span className="dbg-msg">{l.msg}</span>
              </div>
            ))}
        </div>
        <div className="settings-foot">
          <button className="ghost" onClick={() => setLines([])}>Clear view</button>
          <button className="ghost" onClick={copyAll}>Copy all</button>
        </div>
      </div>
    </div>
  );
}
