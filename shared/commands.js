// Commands that do something useful with NO arguments → safe to run on a single tap. This is the menu
// the bare "c" shortcut (and /menu) shows as command "bubbles" on Telegram, and the chips on the web.
// Ordered for display. `/tally` only appears when Metrics is enabled (chat.js filters it).
// SINGLE SOURCE OF TRUTH for the tappable list: the web does NOT hardcode it — clientConfig.js puts this
// into /api/config and web/src/App.jsx reads `cfg.argless`. Edit here only.
export const ARGLESS_COMMANDS = [
  '/whatdo', '/tasks', '/notes', '/lists', '/tally', '/timer', '/ha', '/wakelist', '/me', '/rules', '/howto', '/guide', '/manual',
];

// The single-letter shortcuts, as DATA — one row per letter, so chat.js (routing) and the web legend
// (via /api/config) can't drift. `kind`: 'with_text' = letter + text only ("n spare key"), 'bare' = the
// lone letter runs an arg-free command ("w"), 'both' = either shape works ("j" and "j new food").
// `feature` gates the row to an opt-in module (null = core). `menuOnly` marks rows route() dispatches
// through its own branch (bare "c" → the command menu) — excluded from the derived maps below.
export const SHORTCUTS = [
  { key: 'n', command: '/note',    label: 'note',           kind: 'with_text', feature: 'notes' },
  { key: 't', command: '/task',    label: 'task',           kind: 'with_text', feature: null },
  { key: 'd', command: '/done',    label: 'done',           kind: 'with_text', feature: null },
  { key: 'k', command: '/drop',    label: 'drop',           kind: 'with_text', feature: null },
  { key: 'u', command: '/undo',    label: 'undo',           kind: 'bare',      feature: null },
  { key: 's', command: '/step',    label: 'add step',       kind: 'with_text', feature: null },
  { key: 'r', command: '/recall',  label: 'recall notes',   kind: 'with_text', feature: 'notes' },
  { key: 'g', command: '/guide',   label: 'guide',          kind: 'with_text', feature: null },
  { key: 'x', command: '/today',   label: 'due today',      kind: 'with_text', feature: null },
  { key: 'j', command: '/journal', label: 'journal',        kind: 'both',      feature: 'journal' },
  { key: 'h', command: '/manual',  label: 'ask the manual', kind: 'both',      feature: null },
  { key: 'w', command: '/whatdo',  label: 'what next',      kind: 'bare',      feature: null },
  { key: 'c', command: '/menu',    label: 'command menu',   kind: 'bare',      feature: null, menuOnly: true },
];
// The routing maps chat.js consumes — derived so they stay byte-identical to the table above.
export const SHORTCUT_WITH_TEXT = Object.fromEntries(SHORTCUTS.filter((s) => s.kind !== 'bare').map((s) => [s.key, s.command]));
export const SHORTCUT_BARE = Object.fromEntries(SHORTCUTS.filter((s) => s.kind !== 'with_text' && !s.menuOnly).map((s) => [s.key, s.command]));

// Which ARGLESS_COMMANDS belong to an opt-in module (absent = core, always shown). Shared by chat's
// commandMenu AND the web legend, so a chip for a switched-off surface never appears on either.
export const COMMAND_FEATURES = { '/tally': 'metrics', '/notes': 'notes', '/lists': 'lists', '/timer': 'timer', '/ha': 'homeassistant' };
