import ModulesSection from './ModulesSection.jsx';

// The wide-screen gutter panels — floating cards in the letterbox space beside the 720px chat column,
// shown only ≥1280px (App gates rendering on matchMedia, index.css gates display). Left: the shortcut
// legend. Right: module toggles + live status. Everything here is server-fed (cfg.shortcuts /
// cfg.commandFeatures ride /api/config, the status bundle rides /api/sidebar) — nothing is hardcoded,
// per the clientConfig single-source rule.

const UPCOMING_ICON = { timer: '⏱', reminder: '🔔', checkin: '⏰' };

// "in 12m" under an hour, a clock time under a day, weekday + clock beyond — compact enough for a 240px card.
function fmtAt(at) {
  const d = at - Date.now();
  if (d < 60000) return 'now';
  if (d < 3600000) return `in ${Math.round(d / 60000)}m`;
  const clock = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d < 86400000) return clock;
  return `${new Date(at).toLocaleDateString([], { weekday: 'short' })} ${clock}`;
}

// The letter legend + the one-tap commands that have no letter. A with-text row INSERTS its letter into
// the composer (the point is teaching the shortcut, and the command wants arguments); a bare row and the
// one-tap chips SEND immediately — they're argument-free by construction.
export function LegendPanel({ cfg, features, onInsert, onSend }) {
  if (!cfg?.shortcuts) return null;
  const on = (f) => !f || features?.[f] === true;
  const shortcuts = cfg.shortcuts.filter((s) => on(s.feature));
  const hasLetter = new Set(cfg.shortcuts.map((s) => s.command));
  const oneTaps = (cfg.argless || []).filter((c) => !hasLetter.has(c) && on(cfg.commandFeatures?.[c]));
  return (
    <aside className="gutter gutter-left" aria-label="Shortcut legend">
      <div className="gutter-card">
        <h4>Shortcuts</h4>
        {shortcuts.map((s) => (
          <button
            key={s.key} type="button" className="legend-row"
            title={s.kind === 'bare' ? `Run ${s.command}` : `Start a message with “${s.key} ” (${s.command})`}
            onClick={() => (s.kind === 'bare' ? onSend(s.command) : onInsert(`${s.key} `))}
          >
            <kbd>{s.key}</kbd><span className="legend-label">{s.label}</span>
          </button>
        ))}
      </div>
      {oneTaps.length > 0 && (
        <div className="gutter-card">
          <h4>One-tap</h4>
          <div className="legend-chips">
            {oneTaps.map((c) => <button key={c} type="button" className="legend-chip" onClick={() => onSend(c)}>{c}</button>)}
          </div>
        </div>
      )}
    </aside>
  );
}

// The right-hand status stack: module toggles (the same per-user endpoints as Settings — onModulesChanged
// re-pulls features so the legend + header icons update live), the single started task, the next rings,
// and a context line (notebook · mood · logical day).
export function StatusPanel({ sidebar, notebooks, isOwner, onSend, onInsert, onModulesChanged }) {
  const nbName = notebooks?.enabled
    ? (notebooks.currentId != null
      ? (notebooks.notebooks.find((n) => n.id === notebooks.currentId)?.name ?? 'Main')
      : 'Main')
    : null;
  return (
    <aside className="gutter gutter-right" aria-label="Status panel">
      <div className="gutter-card">
        <h4>Modules</h4>
        <ModulesSection compact filterDisabled={!isOwner} onChange={onModulesChanged} />
      </div>
      <div className="gutter-card">
        <h4>Working on</h4>
        {sidebar?.startedTask ? (
          <>
            <div className="gutter-task">{sidebar.startedTask.summary}</div>
            <div className="gutter-actions">
              {/* The bare finish word closes the started task (chat.js); never positional — a "d 1" would
                  resolve against the last listing, which may not have this task first. */}
              <button type="button" onClick={() => onSend('done')}>✓ done</button>
              <button type="button" onClick={() => onInsert('s ')}>🪜 step</button>
            </div>
          </>
        ) : <p className="gutter-empty">nothing started</p>}
      </div>
      <div className="gutter-card">
        <h4>Upcoming</h4>
        {sidebar?.upcoming?.length
          ? sidebar.upcoming.map((u) => (
            <div key={`${u.type}-${u.id ?? u.taskId}`} className="gutter-row">
              <span className="gutter-row-icon">{UPCOMING_ICON[u.type] || '•'}</span>
              <span className="gutter-row-label">{u.type === 'timer' ? (u.label || 'timer') : u.type === 'reminder' ? u.summary : 'check-in'}</span>
              <span className="gutter-row-time">{fmtAt(u.at)}</span>
            </div>
          ))
          : <p className="gutter-empty">no timers or reminders</p>}
      </div>
      {(nbName || sidebar?.mood || sidebar?.day) && (
        <div className="gutter-card gutter-context">
          {nbName && <span title="Current notebook">{notebooks.currentId != null ? '📓' : '📖'} {nbName}</span>}
          {sidebar?.mood && <span title="Today's mood">{sidebar.mood}</span>}
          {sidebar?.day && <span title="Fanad's logical day (rolls over at 02:00)">{sidebar.day.label}</span>}
        </div>
      )}
    </aside>
  );
}
