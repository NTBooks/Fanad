// Persistence for user-minted custom categories (added via "/lock <new-name>"). The taxonomy itself lives
// in shared/categories.js (registerCategory adds one to the in-memory view); this module is the server-only
// half that makes "forever" real — it stores the custom set in app_settings and re-registers it on boot so
// a category outlives a restart. Global (not per-user), matching the built-in taxonomy and the single-user
// pilot: the *lock* is per-user, but the category DEFINITION is shared.
import { getSetting, setSetting } from './settings.js';
import { CATEGORIES, registerCategory, unregisterCategory } from '../shared/categories.js';
import { markConfigDirty } from './clientConfig.js';

const KEY = 'custom_categories';
const DISABLED_KEY = 'disabled_categories'; // built-in keys retired via /remcat (customs just leave KEY)

// A usable category key: a single clean word — a letter then letters/digits, 2–20 chars. Rejects multi-word
// or punctuated input so "/lock the front door" stays an error instead of minting a junk category.
export function sanitizeCategoryKey(raw) {
  const s = String(raw || '').toLowerCase().trim();
  return /^[a-z][a-z0-9]{1,19}$/.test(s) ? s : null;
}

// Re-register every persisted custom category into the in-memory taxonomy. Call once on boot; safe to call
// again (registerCategory is idempotent by key). Returns how many were loaded.
export function loadCustomCategories() {
  const list = getSetting(KEY, []) || [];
  for (const m of list) registerCategory(m);
  // Re-apply any built-in retirements AFTER the customs are back (a custom was simply never re-registered).
  for (const k of getSetting(DISABLED_KEY, []) || []) unregisterCategory(k);
  markConfigDirty(); // the client config embeds the taxonomy
  return list.length;
}

// Mint a brand-new category for good: register it in-memory AND persist it so it survives a restart. Returns
// the stored meta, or null when the name isn't a usable single-word key. Idempotent — re-adding an existing
// (or built-in) key just returns its meta without a duplicate row.
export function addCustomCategory(rawName) {
  const key = sanitizeCategoryKey(rawName);
  if (!key) return null;
  const label = key.charAt(0).toUpperCase() + key.slice(1);
  const meta = registerCategory({ key, label });
  if (!meta) return null;
  // Persist only genuinely-custom categories. A built-in (no `custom` flag) being re-added is an un-retire,
  // handled below — it must never land in the custom list.
  if (meta.custom) {
    const list = getSetting(KEY, []) || [];
    if (!list.some((m) => m.key === meta.key)) {
      list.push({ key: meta.key, label: meta.label, def: meta.def, syn: meta.syn });
      setSetting(KEY, list);
    }
  }
  // Re-adding a previously-retired built-in (e.g. "/lock work" after "/remcat work") un-retires it.
  const disabled = getSetting(DISABLED_KEY, []) || [];
  if (disabled.includes(meta.key)) setSetting(DISABLED_KEY, disabled.filter((k) => k !== meta.key));
  markConfigDirty();
  return meta;
}

// Retire a category for good: drop it from the live taxonomy AND from persistence (a custom one leaves the
// custom list; a built-in joins the disabled set). Returns { key, wasCustom } or null if it isn't a current
// category. Does NOT move tasks — the caller reassigns them first (see /remcat).
export function removeCategory(rawKey) {
  const k = String(rawKey || '').toLowerCase().trim();
  if (!CATEGORIES.includes(k)) return null;
  const res = unregisterCategory(k);
  if (!res) return null;
  if (res.wasCustom) {
    setSetting(KEY, (getSetting(KEY, []) || []).filter((m) => m.key !== k));
  } else {
    const disabled = getSetting(DISABLED_KEY, []) || [];
    if (!disabled.includes(k)) setSetting(DISABLED_KEY, [...disabled, k]);
  }
  markConfigDirty();
  return res;
}
