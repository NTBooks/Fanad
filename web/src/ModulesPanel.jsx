import { lazy, Suspense } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import TaskBoard from './TaskBoard.jsx';
import NotesView from './NotesView.jsx';
import ListsTree from './ListsTree.jsx';
import TemplatesView from './TemplatesView.jsx';
import JournalView from './JournalView.jsx';
import BatchesView from './BatchesView.jsx';

// The chart-bearing views pull in echarts — lazy-load them so the main bundle stays lean and the
// charting code only downloads when one of these views is opened.
const MetricsView = lazy(() => import('./MetricsView.jsx'));
const DietView = lazy(() => import('./DietView.jsx'));
const MedicationView = lazy(() => import('./MedicationView.jsx'));

// The advanced module views the web offers beyond chat. Tasks + Templates are always available (Tasks is
// the core engine; Templates is task-adjacent); Notes / Lists / Metrics appear only once the user has opted
// into that module. App.jsx reads this SAME list to decide which header icons to render, so the icon set
// and this panel's left-nav can never drift apart. Icons are picked to stay distinct from the header gears.
export const MODULE_VIEWS = [
  { key: 'tasks', label: 'Tasks', icon: '📋', always: true },
  { key: 'notes', label: 'Notes', icon: '🗒️', feature: 'notes' },
  { key: 'lists', label: 'Lists', icon: '🌳', feature: 'lists' },
  { key: 'metrics', label: 'Metrics', icon: '📊', feature: 'metrics' },
  { key: 'diet', label: 'Diet', icon: '🍽️', feature: 'diet' },
  { key: 'medication', label: 'Meds', icon: '💊', feature: 'medication' },
  { key: 'journal', label: 'Journal', icon: '📔', feature: 'journal' },
  { key: 'batches', label: 'Batches', icon: '🧪', feature: 'batches' },
  { key: 'templates', label: 'Templates', icon: '📄', always: true },
];

// Which module views the acting user can see right now, given their feature flags (null while still loading —
// only the always-on ones show until /api/settings/features lands).
export function availableModules(features) {
  return MODULE_VIEWS.filter((m) => m.always || (features && features[m.feature]));
}

const BODY = { tasks: TaskBoard, notes: NotesView, metrics: MetricsView, diet: DietView, medication: MedicationView, lists: ListsTree, journal: JournalView, batches: BatchesView, templates: TemplatesView };

// A tiny GUI / Text segmented control each module view renders in its own header — the "show the current
// state as text as well as a GUI" half of the feature. Shared so the toggle looks and behaves identically
// across all five views.
export function ViewToggle({ view, onView }) {
  return (
    <div className="view-toggle" role="tablist" aria-label="View mode">
      <button className={view === 'gui' ? 'on' : ''} onClick={() => onView('gui')}>GUI</button>
      <button className={view === 'text' ? 'on' : ''} onClick={() => onView('text')}>Text</button>
    </div>
  );
}

// The overlay shell shared by every advanced module view — same modal pattern as DataBrowser (backdrop →
// wide card → left-nav → main). `tab` is the module to open on; App.jsx sets it from the header icon that
// was clicked. If that module has since been turned off, we fall back to the first still-available one.
export default function ModulesPanel({ tab, onTab, features, cfg, onClose }) {
  const mods = availableModules(features);
  const active = mods.some((m) => m.key === tab) ? tab : mods[0]?.key;
  const cur = mods.find((m) => m.key === active);
  const Body = active ? BODY[active] : null;
  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings data modules" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>{cur ? `${cur.icon} ${cur.label}` : 'Modules'}</h2>
          <button className="x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="hint">
          A richer view of what you’ve captured — the same data as the chat, editable here. Web-only; it never
          appears in Telegram.
        </p>
        <div className="data-layout">
          <nav className="data-nav">
            {mods.map((m) => (
              <button key={m.key} className={m.key === active ? 'on' : ''} onClick={() => onTab(m.key)}>
                <span>{m.icon} {m.label}</span>
              </button>
            ))}
          </nav>
          <div className="data-main">
            {/* Keyed on the active module so switching tabs slides the new view in. */}
            <AnimatePresence mode="wait" initial={false}>
              <m.div key={active || 'none'} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.15 }}>
                <Suspense fallback={<p className="hint">Loading…</p>}>
                  {Body ? <Body cfg={cfg} /> : <p className="hint">No modules enabled.</p>}
                </Suspense>
              </m.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
