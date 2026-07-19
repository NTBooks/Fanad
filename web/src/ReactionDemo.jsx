import { useState, useEffect } from 'react';
import { m, AnimatePresence } from 'framer-motion';

// A self-playing onboarding reel: it SHOWS how Fanad reads a message (statement→task, question→command,
// and the myth-buster long-paragraph→one-task) using Fanad's own two-step 👀→decision reaction as the
// teaching device. The reel content is server-owned (shared/copy.js → /api/config → cfg.reactionDemo);
// this component is pure playback and touches no real data. Mounts inside App's <MotionConfig>/<LazyMotion>
// (strict → m.* only), so springs + reduced-motion honoring come for free.

// Hold the 👀 "thinking" face before swapping to the decision emoji — mirrors App.jsx / Telegram REACT_MIN_MS.
const REACT_HOLD_MS = 600;
// How long a step lingers before auto-advancing: a turn step (has a reaction to watch) gets longer than a
// caption-only card. The last step never auto-advances — it holds on the recap + "try it" buttons.
const TURN_MS = 4200;
const CARD_MS = 3400;
const springPop = { type: 'spring', stiffness: 500, damping: 22 };

// A /command token at the start of a word (same shape as App.jsx's CMD_RE) — rendered as an inert chip here,
// so the demo's bot bubbles make "these are commands" legible without implying they're tappable.
const CMD_RE = /(^|\s)(\/[a-z]+(?:_\d+|:[a-z]+)?)/g;
function renderBot(line) {
  const nodes = []; let last = 0; let m2; let k = 0;
  CMD_RE.lastIndex = 0;
  while ((m2 = CMD_RE.exec(line)) !== null) {
    const start = m2.index + m2[1].length;
    if (start > last) nodes.push(line.slice(last, start));
    nodes.push(<span key={`c${k++}`} className="cmd-link demo-cmd">{m2[2]}</span>);
    last = start + m2[2].length;
  }
  if (last < line.length) nodes.push(line.slice(last));
  return nodes.length ? nodes : (line || ' ');
}

// One user turn: the "me" bubble plus its two-step reaction (👀 until `reacted`, then the decision emoji).
// Same markup/animation as App.jsx's .me-reacted so it reads identically to the real thing.
function Turn({ me, react, reacted }) {
  return (
    <div className="demo-turn">
      <div className="bubble me">{me}</div>
      {react && (
        <div className="me-reacted">
          <AnimatePresence mode="popLayout" initial={false}>
            <m.span key={reacted ? 'done' : 'think'} style={{ display: 'inline-block' }}
              initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0, opacity: 0 }} transition={springPop}>
              {reacted ? react : '👀'}
            </m.span>
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

export default function ReactionDemo({ reel, onClose, onTry }) {
  const [step, setStep] = useState(0);
  const [reacted, setReacted] = useState(false); // has the current turn's decision emoji been revealed yet
  const s = reel[step] || {};
  const isLast = step === reel.length - 1;
  const hasTurn = !!(s.me || s.turns);

  // Reveal + auto-advance timers, re-armed whenever the step changes (so Prev replays a step's animation).
  useEffect(() => {
    setReacted(false);
    const timers = [];
    if (hasTurn) timers.push(setTimeout(() => setReacted(true), REACT_HOLD_MS));
    else setReacted(true); // caption/recap cards have nothing to swap — reveal the bot bubble immediately
    if (!isLast) timers.push(setTimeout(() => setStep((i) => Math.min(i + 1, reel.length - 1)), hasTurn ? TURN_MS : CARD_MS));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Esc closes; arrows step through (buttons do the same).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' && !isLast) setStep((i) => i + 1);
      else if (e.key === 'ArrowLeft' && step > 0) setStep((i) => i - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, isLast, onClose]);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings demo-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>🎬 How Fanad works</h2>
          <button className="x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="demo-stage">
          <AnimatePresence mode="wait">
            <m.div
              key={step} className="demo-step"
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25 }}
            >
              {s.title && <div className="demo-title">{s.title}</div>}
              {s.rules && (
                <div className="demo-rules">{s.rules.map((r, i) => <div key={i}>{r}</div>)}</div>
              )}
              {(s.me || s.turns || s.bot) && (
                <div className="demo-chat">
                  {s.me && <Turn me={s.me} react={s.react} reacted={reacted} />}
                  {s.turns && s.turns.map((t, i) => <Turn key={i} me={t.me} react={t.react} reacted={reacted} />)}
                  {s.bot && reacted && (
                    <m.div
                      className="bubble bot" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.2 }}
                    >
                      {s.bot.split('\n').map((line, j) => <div key={j}>{renderBot(line)}</div>)}
                    </m.div>
                  )}
                </div>
              )}
              <p className="demo-caption">{s.caption}</p>
              {s.cta && (
                <div className="demo-cta">
                  {s.cta.map((c) => (
                    <button key={c.label} type="button" onClick={() => onTry(c.insert)}>{c.label}</button>
                  ))}
                </div>
              )}
            </m.div>
          </AnimatePresence>
        </div>

        <div className="demo-foot">
          <button className="ghost" onClick={onClose}>{isLast ? 'Done' : 'Skip'}</button>
          <div className="demo-dots">
            {reel.map((_, i) => (
              <button key={i} type="button" className={i === step ? 'on' : ''}
                aria-label={`Step ${i + 1} of ${reel.length}`} aria-current={i === step} onClick={() => setStep(i)} />
            ))}
          </div>
          <div className="demo-nav">
            <button className="ghost" disabled={step === 0} aria-label="Previous" onClick={() => setStep((i) => i - 1)}>‹</button>
            <button className="ghost" disabled={isLast} aria-label="Next" onClick={() => setStep((i) => i + 1)}>›</button>
          </div>
        </div>
      </div>
    </div>
  );
}
