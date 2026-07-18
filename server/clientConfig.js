// The config the WEB CLIENT needs but must NOT hardcode — the (runtime-mutable) category taxonomy, effort
// levels, the tappable-command list, the onboarding copy, and the provider catalog — assembled server-side
// so there is ONE source of truth. Carries a content `version` (a cheap hash) the client polls on its
// heartbeat to know, without re-pulling the payload, whether its cached copy is stale.
//
// Dirty tracker: the assembled config is cached and only rebuilt when something invalidates it. The only
// runtime-mutable piece is the taxonomy, so server/categories.js calls markConfigDirty() on every
// add/remove; the static pieces change only on deploy (which restarts the process and re-seeds the cache).
import { config } from './config.js';
import { emitUserEvent } from './events.js';
import { CATEGORIES, CATEGORY_ORDER, CATEGORY_LABELS, EFFORT_LEVELS } from '../shared/categories.js';
import { ARGLESS_COMMANDS, SHORTCUTS, COMMAND_FEATURES } from '../shared/commands.js';
import { RULES, HOWTO } from '../shared/copy.js';
import { PROVIDERS } from '../shared/providers.js';
import { UNIT_TYPES, UNIT_LABEL, COUNT_UNIT_TYPES, GRAMS_PER_OZ } from '../shared/diet.js';
import { getSystemModules } from './settings.js';

let cache = null; // { config, version } — null means "dirty", rebuild on next read

// Invalidate the cache so the next read rebuilds the payload and bumps the version. Called whenever a piece
// of the config changes at runtime (today: the taxonomy — see server/categories.js).
export function markConfigDirty() {
  cache = null;
  emitUserEvent(null, 'config'); // broadcast poke: every /api/stream client re-checks configVersion
}

// FNV-1a over the serialized payload → a short base36 tag. Not cryptographic: just a stable, cheap key the
// client can compare. Same content ⇒ same version (so a restart with unchanged config won't force a refetch).
function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

function build() {
  const payload = {
    // CATEGORY_ORDER carries the legacy 'entertainment' key (display-only); keep only live categories.
    categories: CATEGORY_ORDER.filter((k) => CATEGORIES.includes(k)).map((k) => ({ key: k, label: CATEGORY_LABELS[k] })),
    effortLevels: [...EFFORT_LEVELS],
    argless: [...ARGLESS_COMMANDS], // commands a one-tap chip can run as-is (no argument needed)
    // The single-letter shortcut table (shared/commands.js) for the web's wide-screen legend — each row
    // carries its gating module (feature) so the client shows only what the user has opted into.
    shortcuts: SHORTCUTS.map((s) => ({ ...s })),
    commandFeatures: { ...COMMAND_FEATURES }, // argless command → gating module (absent = core)
    rules: RULES,
    howto: HOWTO,
    providers: PROVIDERS,
    // The Diet module's unit taxonomy (types + display labels + count types + the oz↔g factor the live
    // recipe preview needs) — served here so web/src never hardcodes it.
    dietUnits: { types: [...UNIT_TYPES], labels: { ...UNIT_LABEL }, countTypes: [...COUNT_UNIT_TYPES], gramsPerOz: GRAMS_PER_OZ },
    // This deployment's theme for browsers with no saved pick (WEB_DEFAULT_THEME — the demo sets 'bokeh').
    // Env-only, so it can't go dirty at runtime; a restart (= redeploy) re-seeds the cache like the rest.
    defaultTheme: config.webDefaultTheme,
    // System-wide module availability ({ <feature>: bool }) — the owner's global on/off for the whole
    // deployment. Non-secret, so it rides this broadcast: the web hides disabled modules from the per-user
    // list. Runtime-mutable, so the owner's system-modules routes call markConfigDirty() to bump the version.
    systemModules: getSystemModules(),
  };
  const version = hashString(JSON.stringify(payload));
  cache = { config: { ...payload, version }, version };
  return cache;
}

// The full client config, including its `version`.
export function getClientConfig() { return (cache || build()).config; }

// Just the version tag (cheap — reuses the cached build).
export function getConfigVersion() { return (cache || build()).version; }
