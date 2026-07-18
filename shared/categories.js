// Canonical task taxonomy — the SINGLE source of truth shared by server + web. Categories are stored as
// the lowercase `key`; everything else (the display label, the classifier's one-line guide, and the fuzzy
// synonyms) is derived from CATEGORY_META so the enum, prompt, labels, and /task:<word> matching can never
// drift apart. Category is an unconstrained TEXT column (no DB CHECK), so adding one needs no migration.
//
// Designed for differentiation (Projects was a dumping ground): prefer the most SPECIFIC bucket; 'task'
// (Projects) is only for genuine multi-step personal projects; 'other' is only for true miscellany.
// 'entertainment' is a LEGACY key (now folded into 'recreation') — kept out of CATEGORIES so the model
// stops using it, but its label survives below so pre-existing rows still render.
export const CATEGORY_META = [
  { key: 'work', label: 'Work', def: 'your job: clients, meetings, deliverables, work email',
    syn: ['job', 'office', 'career', 'boss', 'client', 'clients', 'meeting', 'meetings', 'coworker', 'standup', 'report', 'presentation'] },
  { key: 'admin', label: 'Admin', def: 'paperwork & life logistics: bills, taxes, banking, forms, accounts, renewals, insurance',
    syn: ['admin', 'paperwork', 'account', 'accounts', 'form', 'forms', 'renew', 'renewal', 'renewals', 'license', 'registration', 'dmv', 'bill', 'bills', 'tax', 'taxes', 'bank', 'banking', 'budget', 'invoice', 'invoices', 'payment', 'payments', 'insurance'] },
  { key: 'errand', label: 'Errands', def: 'out-and-about: shopping, groceries, pickups, the pharmacy',
    syn: ['shopping', 'store', 'groceries', 'grocery', 'shop', 'errand', 'errands', 'pickup', 'pick up', 'pharmacy', 'mall'] },
  { key: 'household', label: 'Home', def: 'the home: chores, cleaning, repairs, laundry, the yard',
    syn: ['home', 'house', 'chore', 'chores', 'cleaning', 'clean', 'domestic', 'repair', 'repairs', 'laundry', 'dishes', 'vacuum', 'tidy', 'yard', 'garden', 'garage'] },
  { key: 'health', label: 'Health', def: 'body & medical: doctor, dentist, fitness, exercise, meds, diet',
    syn: ['fitness', 'gym', 'exercise', 'workout', 'medical', 'doctor', 'diet', 'meds', 'medication', 'physical', 'checkup', 'run', 'running', 'walk', 'jog', 'jogging'] },
  { key: 'selfcare', label: 'Self-care', def: 'rest & wellbeing: relaxing, recharging, mental/emotional health, boundaries',
    syn: ['selfcare', 'self care', 'self-care', 'rest', 'relax', 'recharge', 'unwind', 'decompress', 'meditate', 'meditation', 'mindfulness', 'therapy', 'journal', 'journaling', 'nap', 'breathe', 'spa', 'pamper', 'wellness', 'wellbeing', 'well-being', 'mental health', 'boundaries'] },
  { key: 'social', label: 'Social', def: 'people: friends, family, calls, gatherings, gifts, relationships',
    syn: ['friend', 'friends', 'family', 'social', 'relationship', 'relationships', 'call', 'calls', 'text', 'talk', 'talking', 'chat', 'chatting', 'conversation', 'gift', 'gifts', 'party', 'gathering', 'hangout', 'visit', 'reunion', 'wedding', 'mom', 'dad', 'parents', 'birthday'] },
  { key: 'personal', label: 'Personal', def: 'personal/identity bits that are not social, health, or self-care',
    syn: ['personal', 'life', 'identity'] },
  { key: 'enrichment', label: 'Enrichment', def: 'learning & growth: courses, study, skills, practice, reading to learn, culture',
    syn: ['enrichment', 'learn', 'learning', 'study', 'studying', 'course', 'courses', 'class', 'classes', 'skill', 'skills', 'practice', 'lesson', 'lessons', 'language', 'research', 'tutorial', 'education'] },
  { key: 'recreation', label: 'Recreation', def: 'play & leisure: hobbies, games, watching, reading for fun, sports, the outdoors',
    syn: ['recreation', 'fun', 'entertainment', 'game', 'gaming', 'games', 'movie', 'movies', 'tv', 'show', 'shows', 'watch', 'stream', 'read', 'reading', 'hobby', 'hobbies', 'play', 'leisure', 'outdoors', 'hike', 'hiking', 'sport', 'sports'] },
  { key: 'task', label: 'Projects', def: 'a genuine MULTI-STEP personal project that fits no category above (use sparingly)',
    syn: ['project', 'projects', 'build', 'diy'] },
  { key: 'other', label: 'Other', def: 'true miscellany only — use only when nothing above fits',
    syn: ['misc', 'general', 'random', 'stuff'] },
];

// Custom categories minted at runtime (e.g. via "/lock <new-name>"). The server persists these and
// re-registers them on boot (server/categories.js); this module just holds the merged in-memory view that
// all of the derived exports below reflect — so a new category is, from then on, indistinguishable from a
// built-in one.
const CUSTOM_META = [];

// Built-in categories retired via "/remcat" — they can't be spliced out of the static CATEGORY_META, so we
// hide them here instead (custom categories are simply dropped from CUSTOM_META). The server persists this
// set and re-applies it on boot, so a removal is permanent.
const DISABLED = new Set();

// The derived views over (static + custom) categories. Declared `let`, not `const`: registering a custom
// category recomputes them, and because ES-module named exports are LIVE bindings, every importer that
// reads them at call time (catLabel, the grouped-list order, closestCategory, the classifier guide, the
// /task:<word> matcher) sees the new category without any further plumbing.
export let CATEGORIES = [];
export let CATEGORY_LABELS = {};
export let CATEGORY_ORDER = [];
export let CATEGORY_GUIDE = '';
export let CATEGORY_SYNONYMS = {};

function recomputeCategories() {
  const all = [...CATEGORY_META, ...CUSTOM_META].filter((m) => !DISABLED.has(m.key));
  CATEGORIES = all.map((m) => m.key);
  // key → display label. Includes the legacy 'entertainment' → 'Fun' so old rows still render a friendly name.
  CATEGORY_LABELS = { ...Object.fromEntries(all.map((m) => [m.key, m.label])), entertainment: 'Fun' };
  // Display order for the grouped task list. Legacy 'entertainment' sits next to its successor 'recreation'
  // (or trails the list if recreation was retired); custom categories follow the built-ins, add-order.
  const order = all.map((m) => m.key);
  const ri = order.indexOf('recreation');
  if (ri >= 0) order.splice(ri + 1, 0, 'entertainment'); else order.push('entertainment');
  CATEGORY_ORDER = order;
  // One-line guide per category, fed verbatim into the classifier's system prompt (classify.js).
  CATEGORY_GUIDE = all.map((m) => `- ${m.key} (${m.label}): ${m.def}`).join('\n');
  // Everyday words that map onto a category — so "/task:chores", "/task:fitness", "/task:learning" land
  // where you'd expect. Derived from each category's `syn`; closestCategory() also handles plurals + typos.
  CATEGORY_SYNONYMS = Object.fromEntries(all.flatMap((m) => m.syn.map((s) => [s, m.key])));
}
recomputeCategories(); // seed the views from the static taxonomy

// Add a custom category for the rest of the session — classifiable, lockable, labelled, and groupable,
// just like a built-in. Idempotent by key (re-registering an existing key returns its meta, custom OR
// built-in). Missing label/def/syn are filled with sensible defaults. Returns the stored meta, or null
// for an empty key. Persistence (so it survives a restart) is the server's job — see server/categories.js.
export function registerCategory({ key, label = null, def = null, syn = null } = {}) {
  const k = String(key || '').toLowerCase().trim();
  if (!k) return null;
  if (DISABLED.has(k)) { DISABLED.delete(k); recomputeCategories(); } // re-adding a retired built-in un-retires it
  const existing = [...CATEGORY_META, ...CUSTOM_META].find((m) => m.key === k);
  if (existing) return existing;
  const cap = k.charAt(0).toUpperCase() + k.slice(1);
  const meta = { key: k, label: label || cap, def: def || `${label || cap} — a category you added`, syn: (syn && syn.length) ? syn : [k], custom: true };
  CUSTOM_META.push(meta);
  recomputeCategories();
  return meta;
}

// Remove a category from the live taxonomy. A custom (runtime) category is dropped entirely; a built-in is
// retired into DISABLED so it stops being offered, listed, labelled, and matched. Idempotent. Returns
// { key, wasCustom } on a real removal, or null if `key` isn't a current category. Persistence (so the
// removal survives a restart) is the server's job — see server/categories.js.
export function unregisterCategory(key) {
  const k = String(key || '').toLowerCase().trim();
  if (!k || !CATEGORIES.includes(k)) return null;
  const idx = CUSTOM_META.findIndex((m) => m.key === k);
  const wasCustom = idx >= 0;
  if (wasCustom) CUSTOM_META.splice(idx, 1); else DISABLED.add(k);
  recomputeCategories();
  return { key: k, wasCustom };
}

export const EFFORT_LEVELS = ['trivial', 'low', 'medium', 'high'];

// Tiny Levenshtein for typo-tolerant matching (the category set is tiny, so this is cheap).
function editDistance(a, b) {
  const m = a.length; const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[m][n];
}

// Resolve a free-typed word to the closest canonical category, or null if nothing's close enough.
// Order: exact → synonym → singular/plural → prefix → nearest by edit distance (small threshold).
export function closestCategory(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return null;
  if (CATEGORIES.includes(s)) return s;
  if (CATEGORY_SYNONYMS[s]) return CATEGORY_SYNONYMS[s];
  const sing = s.replace(/s$/, '');
  if (CATEGORIES.includes(sing)) return sing;
  if (CATEGORY_SYNONYMS[sing]) return CATEGORY_SYNONYMS[sing];
  if (s.length >= 3) {
    const pref = CATEGORIES.find((c) => c.startsWith(s) || s.startsWith(c));
    if (pref) return pref;
  }
  const candidates = [...CATEGORIES, ...Object.keys(CATEGORY_SYNONYMS)];
  let best = null; let bestD = Infinity;
  for (const cand of candidates) { const d = editDistance(s, cand); if (d < bestD) { bestD = d; best = cand; } }
  if (best != null && bestD <= Math.max(1, Math.floor(best.length / 4))) {
    return CATEGORIES.includes(best) ? best : CATEGORY_SYNONYMS[best];
  }
  return null;
}

// (snoozed/archived added by the staleness/refusal grooming module).
// 'expired' = a deadline passed; the task is retired non-judgily (advanced /task deadlines).
export const TASK_STATUS = ['available', 'in_progress', 'done', 'snoozed', 'archived', 'expired'];
