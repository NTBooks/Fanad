// Diet engine (§13.5) — the canonical-foods calorie tracker behind the opt-in Diet module. The user's
// proven loop: weigh the food → look up its cal/oz → multiply. Foods the user has confirmed once are
// reused silently forever (no re-guessing); the LLM only prices a food the library has never seen, and
// its guess must be confirmed/corrected before it's saved. Recipes are ingredient snapshots ÷ cooked
// weight (see shared/diet.js for the math). Eaten portions land as ONE metric_values row on the
// 'calories' metric (entry_label = the portion; the row id rides the app-wide undo stack); these tables
// are only the lookup layer. The chat surface lives in features/diet.js.
import { chat } from './services/llm/index.js';
import { FOOD_ESTIMATE_SYSTEM, EAT_PARSE_SYSTEM, MEAL_ESTIMATE_SYSTEM } from './services/llm/prompts.js';
import { sanitizeForLlm } from './services/llm/sanitize.js';
import {
  getFood, listFoods, upsertFood, updateFood, deleteFood,
  getRecipe, getRecipeById, listRecipes, createRecipe, setRecipeCookedWeight, deleteRecipe,
  addRecipeItem, listRecipeItems,
  getMetric, getOrCreateMetric, insertMetricValue, setMetricTarget,
  setDietDay, clearDietDay, getDietDay,
} from './repo.js';
import { setDialogState, clearDialogState, setListing, resolveListing } from './dialog.js';
import { tallyText } from './metrics.js';
import { recordUndo } from './undo.js';
import { dayStartOf } from '../shared/timeframe.js';
import {
  UNIT_LABEL, COUNT_UNIT_TYPES, toFoodUnits, caloriesFor, recipeTotals, recipeCalPerOz, qtyLabel,
} from '../shared/diet.js';

// The one metric diet writes. Eat used to fan out across calories/protein/carbs/fat; the module is now
// calories-only (the user's workflow tracks nothing else) — old macro metrics and their history remain
// untouched, they just stop growing.
export function ensureCaloriesMetric(userId) {
  return getOrCreateMetric(userId, 'calories', { unit: 'kcal', aggregation: 'sum', target: 2000 });
}

export const unitWord = (unitType) => UNIT_LABEL[unitType] || 'oz';
const density = (f) => `${Math.round(f.cal_per_unit * 10) / 10} cal/${unitWord(f.unit_type)}`;
const isCount = (unitType) => COUNT_UNIT_TYPES.includes(unitType); // piece or serving: a bare number counts them

// ── Eat-line parsing: heuristic first (offline + test path), LLM for fuzzy leftovers ──
// Mirrors duration.js's shape. Returns { qty, unit ('oz'|'g'|'lb'|null), food, article, cal } — `article`
// marks a qty that came from "a/an", which counts as "1 piece" for a piece-food but is NOT a weight
// ("eat a chicken sandwich" must not read as 1 oz of sandwich). `cal` is a STATED calorie total
// ("olives 80cal", "80 calories of olives") — the user's own count, which outranks any density math
// (see startEat); without the cal word, trailing digits stay part of the name exactly as before.
const WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const UNIT_WORD = {
  oz: 'oz', ounce: 'oz', ounces: 'oz', g: 'g', gram: 'g', grams: 'g',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
};
const UNIT_RE = '(oz|ounces?|grams?|g|lbs?|pounds?)';
// Leading form: "4oz chicken breast" / "12 oz of chili" / "2 eggs" / "half a pound of chili" / "an egg".
const LEAD = new RegExp(String.raw`^(?:(\d+(?:\.\d+)?)|(half\s+an?|a|an|one|two|three|four|five|six|seven|eight|nine|ten))\s*${UNIT_RE}?\.?\s+(?:of\s+)?(.+)$`, 'i');
// Trailing form: "chicken breast 4 oz" / "rice 120g". The name is lazy so the LAST number reads as the amount.
const TRAIL = new RegExp(String.raw`^(.+?)\s+(\d+(?:\.\d+)?)\s*${UNIT_RE}?$`, 'i');

// Stated calories: the cal word is REQUIRED next to the number, so digit names ("7up", "route 66 bar")
// never trip it. Peeled BEFORE the quantity grammar — CAL_LEAD especially must beat LEAD, which would
// otherwise read "80 calories of olives" as 80 of a food called "calories of olives".
const CAL_WORD = String.raw`k?cal(?:orie)?s?`;
const CAL_BARE = new RegExp(String.raw`^(\d+(?:\.\d+)?)\s*${CAL_WORD}\.?$`, 'i'); // "80 cal" — calories, no food
const CAL_LEAD = new RegExp(String.raw`^(\d+(?:\.\d+)?)\s*${CAL_WORD}\s+(?:of\s+)?(.+)$`, 'i'); // "80 calories of olives"
const CAL_TAIL = new RegExp(String.raw`^(.+?)[\s,;]+(\d+(?:\.\d+)?)\s*${CAL_WORD}\.?$`, 'i'); // "4 oz olives, 80 cal"

const wordAmount = (w) => (/^half\s+an?$/i.test(w) ? 0.5 : WORD_NUM[w.toLowerCase()] ?? null);
const cleanFood = (s) => s.trim().replace(/[.!?]+$/, '').replace(/\s{2,}/g, ' ');

export function parseEatLine(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  // Peel ONE stated-calories clause; the remainder still goes through the normal quantity grammar.
  let cal = null; let rest = s; let m;
  if ((m = CAL_BARE.exec(s))) {
    return { qty: null, unit: null, food: '', article: false, cal: Number(m[1]) > 0 ? Number(m[1]) : null };
  }
  if ((m = CAL_LEAD.exec(s))) { cal = Number(m[1]); rest = m[2]; }
  else if ((m = CAL_TAIL.exec(s))) { cal = Number(m[2]); rest = m[1]; }
  if (!(cal > 0)) cal = null;
  m = LEAD.exec(rest);
  if (m && (m[1] != null || m[2] != null)) {
    const qty = m[1] != null ? Number(m[1]) : wordAmount(m[2]);
    const article = m[1] == null && /^an?$/i.test(m[2].trim());
    if (qty != null) return { qty, unit: m[3] ? UNIT_WORD[m[3].toLowerCase()] : null, food: cleanFood(m[4]), article, cal };
  }
  m = TRAIL.exec(rest);
  // Unit-less trailing digits stay part of the name ("7up", "route 66 bar") — only a unit disambiguates.
  if (m && m[3]) return { qty: Number(m[2]), unit: UNIT_WORD[m[3].toLowerCase()], food: cleanFood(m[1]), article: false, cal };
  return { qty: null, unit: null, food: cleanFood(rest), article: false, cal };
}

const stripFences = (s) => String(s).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
function withTimeout(promise, ms = 6000) {
  return Promise.race([
    promise,
    new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('llm timeout')), ms); t.unref?.(); }),
  ]);
}

const EAT_PARSE_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'fanad_eat', strict: true,
    schema: {
      type: 'object', additionalProperties: false, required: ['food', 'quantity', 'unit', 'calories'],
      properties: {
        food: { type: 'string' },
        quantity: { type: 'number' },
        unit: { type: 'string', enum: ['oz', 'g', 'lb', 'piece', ''] },
        calories: { type: 'number' },
      },
    },
  },
};

export async function extractEat(text) {
  const heur = parseEatLine(text);
  if (!heur || heur.qty != null || heur.cal != null) return heur;
  // Short plain names ("chicken breast") stay offline; a digit in a no-amount name means the heuristic
  // missed something ("olives 1/4 cup"), so those go to the LLM regardless of length.
  if (heur.food.split(/\s+/).length <= 2 && !/\d/.test(heur.food)) return heur;
  // One LLM pass for phrasings the grammar missed ("about a third of the chili") — and to scrub volume
  // junk out of the NAME, so it can never be saved as a canonical food called "olives 1/4 cup".
  try {
    const raw = await withTimeout(chat({
      messages: [{ role: 'system', content: EAT_PARSE_SYSTEM }, { role: 'user', content: sanitizeForLlm(text) }],
      responseFormat: EAT_PARSE_SCHEMA, temperature: 0, maxTokens: 60, purpose: 'meal',
    }));
    const o = JSON.parse(stripFences(raw));
    const food = o?.food ? cleanFood(o.food) : '';
    if (food) {
      const qty = Number(o.quantity) > 0 ? Number(o.quantity) : null;
      const unit = qty != null && o.unit && o.unit !== 'piece' ? o.unit : null;
      const cal = Number(o.calories) > 0 ? Number(o.calories) : null;
      return { qty, unit, food, article: false, cal };
    }
  } catch (err) {
    if (!(err instanceof SyntaxError)) console.error('eat parse fallback failed:', err.message);
  }
  return heur;
}

// ── The LLM density guess for a food the library has never seen ──
const FOOD_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'fanad_food', strict: true,
    schema: {
      type: 'object', additionalProperties: false, required: ['unit_type', 'cal_per_unit'],
      properties: {
        unit_type: { type: 'string', enum: ['ounce', 'piece'] },
        cal_per_unit: { type: 'integer' },
      },
    },
  },
};

export async function estimateFood(food) {
  try {
    const raw = await chat({
      messages: [
        { role: 'system', content: FOOD_ESTIMATE_SYSTEM },
        { role: 'user', content: sanitizeForLlm(food) },
      ],
      responseFormat: FOOD_SCHEMA, temperature: 0.2, maxTokens: 60, purpose: 'meal',
    });
    const o = JSON.parse(stripFences(raw));
    if (o && (o.unit_type === 'ounce' || o.unit_type === 'piece') && Number(o.cal_per_unit) > 0) {
      return { unitType: o.unit_type, calPerUnit: Number(o.cal_per_unit) };
    }
  } catch (err) {
    // Fabricated fallback below reads exactly like a real estimate, so leave a trace when it wasn't the
    // mock's expected unparseable output (the user confirms before anything is saved or logged).
    if (!(err instanceof SyntaxError)) console.error('food estimate failed — using the default guess:', err.message);
  }
  return { unitType: 'ounce', calPerUnit: 50 };
}

// ── Lookups: the food library first (exact, then ±plural), then recipes; null → LLM territory ──
export function findFood(userId, name) {
  const f = getFood(userId, name)
    || (name.endsWith('s') ? getFood(userId, name.slice(0, -1)) : getFood(userId, `${name}s`));
  return f || null;
}
export function findRecipe(userId, name) {
  const r = getRecipe(userId, name)
    || (name.endsWith('s') ? getRecipe(userId, name.slice(0, -1)) : getRecipe(userId, `${name}s`));
  return r || null;
}

// A finished recipe presented in food-shape (density in cal per cooked oz), so eat treats both alike.
export function recipeAsFood(userId, recipe) {
  const items = listRecipeItems(userId, recipe.id);
  const calPerOz = recipeCalPerOz(items, recipe.cooked_weight_oz);
  if (calPerOz == null || !items.length) return null;
  return { name: recipe.name, cal_per_unit: calPerOz, unit_type: 'ounce', recipe: true };
}

// ── Logging: ONE calories row per portion. The row id lands on the undo stack, so "undo" removes exactly
// this portion — even after the web log's inline edit renames its entry_label (undo re-reads the live label).
export function logFood(userId, label, calories) {
  const cal = ensureCaloriesMetric(userId);
  const id = insertMetricValue({ userId, metricId: cal.id, value: calories, entryLabel: label, note: label });
  recordUndo(userId, 'metric_log', { ids: [id] }, `↩ Undid “${label}”.`);
  return `Logged ${label}: ${calories} cal.\n${tallyText(userId, 'calories')}`;
}

const askQty = (userId, name) => {
  setDialogState(userId, { type: 'eat_qty', data: { name }, prompt: `How much ${name}?` });
  return `How much ${name}? (e.g. “4 oz” — or “no” to skip)`;
};

// The portion arithmetic for a KNOWN food/recipe-as-food: calories + the entry label. Null when the
// units can't be reconciled (a weight for a piece food). Shared by chat and the web API.
export function portionOf(food, qty, unit) {
  const q = isCount(food.unit_type) && qty == null ? 1 : qty; // a bare "eat egg" is one egg; "eat skyr" one serving
  const u = isCount(food.unit_type) && qty == null ? 'piece' : unit;
  const calories = caloriesFor(food, q, u);
  if (calories == null) return null;
  const label = isCount(food.unit_type)
    ? `${qtyLabel(q, 'piece')} ${food.name}`.replace(/^1 /, '') // "1 egg" → "egg"; "2 eggs" keeps its count
    : `${qtyLabel(q, u, food.unit_type)} ${food.name}`;
  return { calories, label };
}

// Compute-and-log for a KNOWN food/recipe-as-food. Null qty on a weighed food → ask; on a count food → 1.
export function eatKnown(userId, food, qty, unit, { article = false } = {}) {
  if (!isCount(food.unit_type) && (qty == null || (article && unit == null))) {
    return askQty(userId, food.name); // "eat chicken breast" / "eat a chicken breast" — weigh it first
  }
  const portion = portionOf(food, qty, unit);
  if (!portion) {
    return `${food.name} is a per-${unitWord(food.unit_type)} food — give me it that way (e.g. ${isCount(food.unit_type) ? `“eat 2 ${food.name}”` : `“eat 4 oz ${food.name}”`}).`;
  }
  return logFood(userId, portion.label, portion.calories);
}

// "eat <line>" — the front door. Known things log (or ask the weight); unknown things get ONE guess
// that the food_confirm dialog turns into a canonical food.
export async function startEat(userId, text) {
  // A comma/semicolon list is several foods thrown together on a plate ("8 oz chicken, half red pepper,
  // 5 white mushrooms") — NOT one food whose whole weight is 8 oz. The leading amount binds to its own
  // item; each item is priced on its own and the plate is logged as one entry. A stated total for the
  // WHOLE line ("chicken, rice, 600 cal") is the user's own count for one entry, so it's excluded.
  const whole = parseEatLine(text);
  const plate = String(text).split(/\s*[,;]\s*/).map((s) => s.trim()).filter(Boolean);
  if (whole?.cal == null && plate.length >= 2) return startAdhocMeal(userId, text, plate);

  const parsed = await extractEat(text);
  if (!parsed || !parsed.food) {
    return 'What did you eat? Try “eat 4 oz chicken breast” — or add the calories you know: “eat olives 80 cal”.';
  }
  const { qty, unit, food: name, article, cal } = parsed;

  // Stated calories are the user's own count and always win — no guess, no confirm question. With no
  // amount ("eat skyr 140cal") the number IS the typical serving: an unknown food is saved per-serving
  // and reused by a bare "eat skyr" forever; restating it ("eat skyr 200cal") redefines the serving.
  // With an amount too ("4 oz olives 80 cal") the density falls out of what they typed, so an unknown
  // food becomes canonical from THEIR numbers (source 'user') with no LLM round-trip. A known weighed/
  // piece food or recipe is never rewritten by a one-off — the stated total just logs against its name.
  if (cal != null) {
    const known = findFood(userId, name) || findRecipe(userId, name);
    const foodName = known ? known.name : name;
    if (qty == null) {
      if (!known) {
        const saved = upsertFood(userId, { name, calPerUnit: cal, unitType: 'serving', source: 'user' });
        return `✓ ${saved.name} saved at ${density(saved)} — I’ll reuse it.\n${logFood(userId, saved.name, cal)}`;
      }
      if (known.unit_type === 'serving') { // a serving FOOD (a recipes row has no unit_type)
        const upd = updateFood(userId, known.id, { calPerUnit: cal });
        return `✓ ${upd.name} is now ${density(upd)}.\n${logFood(userId, upd.name, cal)}`;
      }
      return logFood(userId, foodName, cal);
    }
    const unitType = unit ? 'ounce' : 'piece'; // an explicit weight is weighed; a bare count is pieces
    const label = unitType === 'piece'
      ? `${qtyLabel(qty, 'piece')} ${foodName}`.replace(/^1 /, '')
      : `${qtyLabel(qty, unit, 'ounce')} ${foodName}`;
    const inUnits = toFoodUnits({ unit_type: unitType }, qty, unit);
    if (known || inUnits == null) return logFood(userId, label, cal);
    const saved = upsertFood(userId, { name, calPerUnit: Math.round((cal / inUnits) * 10) / 10, unitType, source: 'user' });
    return `✓ ${saved.name} saved at ${density(saved)} — I’ll reuse it.\n${logFood(userId, label, cal)}`;
  }

  const food = findFood(userId, name);
  if (food) return eatKnown(userId, food, qty, unit, { article });

  const recipe = findRecipe(userId, name);
  if (recipe) {
    const asFood = recipeAsFood(userId, recipe);
    if (!asFood) return `“${recipe.name}” isn’t finished — it needs ingredients and a cooked weight. “recipe show ${recipe.name}” has the state; “recipe new ${recipe.name}” rebuilds it.`;
    return eatKnown(userId, asFood, qty, unit, { article });
  }

  // Unknown → guess a density, confirm before anything is saved or logged.
  const est = await estimateFood(name);
  const effQty = est.unitType === 'piece' && qty == null ? 1 : qty;
  const preview = effQty != null && !(article && est.unitType === 'ounce')
    ? ` — ${qtyLabel(effQty, unit, est.unitType)}${est.unitType === 'piece' ? ' ×' : ''} ≈ ${caloriesFor({ cal_per_unit: est.calPerUnit, unit_type: est.unitType }, effQty, unit) ?? '?'} cal`
    : '';
  const prompt = `${name} ≈ ${est.calPerUnit} cal/${unitWord(est.unitType)} (my guess)${preview}.`;
  setDialogState(userId, {
    type: 'food_confirm',
    data: { name, qty: effQty, unit, article, unitType: est.unitType, calPerUnit: est.calPerUnit },
    prompt,
  });
  return `${prompt}\nReply “yes” to save & log, send the right cal/${unitWord(est.unitType)} (a bare number), or “no” to skip.`;
}

// "eat whatever" — declare a day off the record. A cheat day, a fast, a travel day: calories still log
// normally if you want, but the graph tints the day and the report's average leaves it out, so one
// deliberate blowout (or a skipped day) never reads as a tracked result. Idempotent; `on = false`
// ("eat whatever off") clears it. Marks the SERVER's current logical day (dayStartOf, 02:00 rollover).
export function setWhateverDay(userId, on = true, at = Date.now()) {
  const day = dayStartOf(at);
  if (on) {
    const already = getDietDay(userId, day) != null;
    setDietDay(userId, day, 'whatever');
    return `🍕 Today’s an eat-whatever day${already ? ' (already was)' : ''} — off the record. I’ll tint it on the graph and leave it out of your averages.\n(“eat whatever off” puts it back on the books.)`;
  }
  return clearDietDay(userId, day)
    ? '✓ Cleared — today counts toward your averages again.'
    : 'Today wasn’t marked as an eat-whatever day.';
}

// food_confirm resolution: save the (possibly corrected) density as a canonical food, then log the
// portion — or ask for the weight when none was given. `ans` comes from dialog.js's foodConfirmAnswer.
export function confirmFood(userId, data, ans) {
  clearDialogState(userId);
  if (ans.type === 'no') return 'Okay — nothing saved or logged.';
  let calPerUnit = data.calPerUnit;
  if (ans.type === 'calper') calPerUnit = ans.v;
  if (ans.type === 'total') {
    const inUnits = toFoodUnits({ unit_type: data.unitType, cal_per_unit: 0 }, data.qty, data.unit);
    if (!inUnits) return `I can only turn a total into cal/${unitWord(data.unitType)} when I know the amount — send the density instead (e.g. “45”).`;
    calPerUnit = Math.round((ans.v / inUnits) * 10) / 10;
  }
  const food = upsertFood(userId, { name: data.name, calPerUnit, unitType: data.unitType, source: 'llm' });
  const saved = `✓ ${food.name} saved at ${density(food)} — I’ll reuse it from now on.`;
  if (data.qty == null || (data.article && food.unit_type === 'ounce')) return `${saved}\n${askQty(userId, food.name)}`;
  return `${saved}\n${eatKnown(userId, food, data.qty, data.unit)}`;
}

// eat_qty resolution — the "how much?" answer for a known food/recipe.
export function answerQty(userId, data, ans) {
  clearDialogState(userId);
  if (ans.type === 'no') return 'Okay — not logged.';
  const food = findFood(userId, data.name)
    || (findRecipe(userId, data.name) && recipeAsFood(userId, findRecipe(userId, data.name)));
  if (!food) return `I’ve lost track of “${data.name}” — try “eat 4 oz ${data.name}” again.`;
  return eatKnown(userId, food, ans.qty, ans.unit);
}

// ── Meals: "save meal breakfast 2 eggs, skyr, toast 450 cal" — the same-breakfast-every-day shortcut ──
// A meal IS a serving food (unit_type 'serving') plus a description of what's in it — not a recipe (no
// cooked weight, no snapshots) and not its own table, so "eat breakfast" logs one typical serving through
// the normal food lookup, "eat 2 breakfast" doubles it, and "foods" lists it alongside everything else.
// A stated trailing total saves silently; without one, known items are priced from the library and the
// rest get ONE batched LLM guess behind ONE yes/number/no confirm (meal_confirm).
const MEAL_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'fanad_meal', strict: true,
    schema: {
      type: 'object', additionalProperties: false, required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['name', 'calories'],
            properties: { name: { type: 'string' }, calories: { type: 'integer' } },
          },
        },
      },
    },
  },
};

// One batched guess for every item the library couldn't price — TOTAL calories per item (a density is a
// dead end for a weightless "toast"). Fabricated 100/item fallback with a trace, like estimateFood.
async function estimateMealItems(names) {
  try {
    const raw = await withTimeout(chat({
      messages: [
        { role: 'system', content: MEAL_ESTIMATE_SYSTEM },
        { role: 'user', content: names.map((n) => sanitizeForLlm(n)).join('\n') },
      ],
      responseFormat: MEAL_SCHEMA, temperature: 0.2, maxTokens: 300, purpose: 'meal',
    }));
    const o = JSON.parse(stripFences(raw));
    if (Array.isArray(o?.items)) {
      return names.map((n, i) => {
        const hit = o.items[i]?.name && names.length === o.items.length ? o.items[i]
          : o.items.find((it) => it?.name?.toLowerCase() === n.toLowerCase());
        const cal = Number(hit?.calories);
        return { name: n, calories: cal > 0 ? Math.round(cal) : 100 };
      });
    }
  } catch (err) {
    if (!(err instanceof SyntaxError)) console.error('meal estimate failed — using the default guess:', err.message);
  }
  return names.map((n) => ({ name: n, calories: 100 }));
}

// Price a list of already-split food segments ("2 eggs", "skyr", "5 white mushrooms") into a per-item
// breakdown: a known food (or an inline "x 80cal") prices EXACTLY from the library, its own amount bound
// to itself; each leftover gets ONE batched LLM guess for its TOTAL calories, and the WHOLE segment is
// what's guessed — so "5 white mushrooms" isn't priced like a single mushroom. Splitting is the caller's
// job (save-meal also breaks on "and"; the ad-hoc plate keeps "mac and cheese" whole). Returns
// { priced:[{label,calories}], guessed:[{name,calories}], total }.
async function priceSegments(userId, segments) {
  const priced = []; const toGuess = [];
  for (const seg of segments) {
    const p = parseEatLine(seg);
    if (p?.cal != null) { priced.push({ label: p.food || seg, calories: p.cal }); continue; } // "2 eggs 140cal" inline
    const f = p?.food
      ? findFood(userId, p.food) || (() => { const r = findRecipe(userId, p.food); return r && recipeAsFood(userId, r); })()
      : null;
    const portion = f ? portionOf(f, p.qty, p.unit) : null; // null: unknown, or a weighed food with no weight
    if (portion) priced.push({ label: portion.label, calories: portion.calories });
    else toGuess.push(seg); // the whole segment, so its amount informs the guess
  }
  const guessed = toGuess.length ? await estimateMealItems(toGuess) : [];
  const total = Math.round(priced.reduce((s, x) => s + x.calories, 0) + guessed.reduce((s, x) => s + x.calories, 0));
  return { priced, guessed, total };
}

const mealBreakdown = (priced, guessed) =>
  [...priced.map((x) => `${x.label} ${x.calories}`), ...guessed.map((x) => `${x.name} ~${x.calories} guess`)].join(' · ');

const savedMealText = (f) => `✓ ${f.name} saved at ${density(f)} (${f.description}). “eat ${f.name}” logs it.`;

export async function saveMeal(userId, name, body) {
  // Peel a trailing stated total ("… 450 cal") with the same grammar eat uses; the rest is the description.
  let desc = cleanFood(body); let cal = null; let m;
  if ((m = CAL_TAIL.exec(desc))) { cal = Number(m[2]); desc = cleanFood(m[1]); }
  if (!(cal > 0)) cal = null;
  if (!desc) return 'What’s in it? e.g. “save meal breakfast 2 eggs, skyr, toast 450 cal”.';
  if (cal != null) {
    const saved = upsertFood(userId, { name, calPerUnit: cal, unitType: 'serving', source: 'user', description: desc });
    return savedMealText(saved);
  }
  // No stated total → price it: library first, ONE batched guess for the leftovers, ONE confirm. A meal
  // splits on "and" too ("cheese and crackers" is two items); the ad-hoc plate below deliberately doesn't.
  const segments = desc.split(/\s*[,;]\s*|\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
  const { priced, guessed, total } = await priceSegments(userId, segments);
  const prompt = `${name} ≈ ${total} cal (${mealBreakdown(priced, guessed)}).`;
  setDialogState(userId, {
    type: 'meal_confirm',
    data: { name, description: desc, total, guessed: guessed.length > 0 },
    prompt,
  });
  return `${prompt}\n“yes” saves it, a number sets the total, or “no” to skip.`;
}

// meal_confirm resolution — mirrors confirmFood; both of foodConfirmAnswer's number shapes set the total.
export function confirmMeal(userId, data, ans) {
  clearDialogState(userId);
  if (ans.type === 'no') return 'Okay — nothing saved.';
  const total = ans.type === 'yes' ? data.total : ans.v;
  const saved = upsertFood(userId, {
    name: data.name, calPerUnit: total, unitType: 'serving',
    source: ans.type === 'yes' && data.guessed ? 'llm' : 'user', description: data.description,
  });
  return savedMealText(saved);
}

// "eat <a, comma, list>" — a one-off plate, logged NOW (never saved like a meal: it's thrown together,
// not a repeatable). Each item is priced on its own — its amount bound to itself, unknowns getting the
// batched total-calorie guess — and the whole plate lands as ONE calories row. All-known plates log
// immediately; if anything was guessed, one yes/number/no confirm precedes the log, like every diet guess.
async function startAdhocMeal(userId, text, segments) {
  const label = cleanFood(text);
  const { priced, guessed, total } = await priceSegments(userId, segments);
  if (!guessed.length) return logFood(userId, label, total); // nothing to guess — just log the plate
  const prompt = `${label} ≈ ${total} cal (${mealBreakdown(priced, guessed)}).`;
  setDialogState(userId, { type: 'eat_meal_confirm', data: { label, total }, prompt });
  return `${prompt}\n“yes” logs it, a number sets the total, or “no” to skip.`;
}

// eat_meal_confirm resolution — mirrors confirmMeal, but LOGS the plate instead of saving a meal food.
export function confirmAdhocMeal(userId, data, ans) {
  clearDialogState(userId);
  if (ans.type === 'no') return 'Okay — nothing logged.';
  return logFood(userId, data.label, ans.type === 'yes' ? data.total : ans.v);
}

// "eat meal <name>" — the explicit form. Deliberately NOT startEat: a typo'd meal name must get the
// save-meal nudge, never the unknown-food guess flow.
export function eatMealText(userId, name) {
  const food = findFood(userId, name);
  if (!food) return `I don’t have a meal called “${name}” — “save meal ${name} <what’s in it>” teaches me.`;
  return eatKnown(userId, food, null, null);
}

// ── Food management (listings renumber 1..N — raw ids never shown) ──
export function foodsText(userId) {
  const foods = listFoods(userId);
  if (!foods.length) return 'No foods saved yet. “eat 4 oz chicken breast” teaches me one, or “food add chicken breast 45” sets it directly.';
  setListing(userId, 'foods', foods.map((f) => f.id));
  const lines = foods.map((f, i) => `${i + 1}. ${f.name} — ${density(f)}${f.description ? ` · ${f.description}` : ''}`);
  return `🥗 Your foods:\n${lines.join('\n')}\n(“food set 2 48” corrects one · “food del 2” removes it)`;
}

export function addFoodText(userId, name, calPerUnit, unitType = 'ounce') {
  const f = upsertFood(userId, { name, calPerUnit, unitType, source: 'user' });
  return `✓ ${f.name} — ${density(f)}. Log it with: eat ${f.unit_type === 'serving' ? f.name : f.unit_type === 'piece' ? `2 ${f.name}` : `4 oz ${f.name}`}`;
}

// A "ref" is a position from the last foods listing, or a name.
function resolveFoodRef(userId, ref) {
  const n = /^\d+$/.test(ref) ? Number(ref) : null;
  if (n != null) {
    const { pairs } = resolveListing(userId, 'foods', [n]);
    return pairs.length ? listFoods(userId).find((f) => f.id === pairs[0].id) || null : null;
  }
  return findFood(userId, ref);
}

export function setFoodText(userId, ref, calPerUnit) {
  const f = resolveFoodRef(userId, ref);
  if (!f) return `I don’t have “${ref}” — “foods” lists what I know.`;
  const upd = updateFood(userId, f.id, { calPerUnit });
  return `✓ ${upd.name} is now ${density(upd)}.`;
}

export function deleteFoodText(userId, ref) {
  const f = resolveFoodRef(userId, ref);
  if (!f) return `I don’t have “${ref}” — “foods” lists what I know.`;
  deleteFood(userId, f.id);
  return `✕ Removed ${f.name}. (Past logs keep their calories.)`;
}

export function showFoodText(userId, name) {
  const f = findFood(userId, name);
  if (!f) return `I don’t have “${name}” — “foods” lists what I know, “food add ${name} <cal>” teaches me.`;
  return `${f.name} — ${density(f)}${f.description ? ` · ${f.description}` : ''}${f.source === 'llm' ? ' (from a confirmed guess)' : ''}.`;
}

// ── Recipes ──
export function recipeSummary(userId, recipe) {
  const items = listRecipeItems(userId, recipe.id);
  const { totalCalories } = recipeTotals(items);
  const calPerOz = recipeCalPerOz(items, recipe.cooked_weight_oz);
  return { items, totalCalories, calPerOz };
}

export function recipesText(userId) {
  const recipes = listRecipes(userId);
  if (!recipes.length) return 'No recipes yet. “recipe new chili” builds one from your foods.';
  setListing(userId, 'recipes', recipes.map((r) => r.id));
  const lines = recipes.map((r, i) => {
    const { calPerOz } = recipeSummary(userId, r);
    return `${i + 1}. ${r.name} — ${calPerOz != null ? `${calPerOz} cal/oz` : 'draft (unfinished)'}`;
  });
  return `🍲 Your recipes:\n${lines.join('\n')}\n(“recipe show chili” · “eat 8 oz chili” logs a portion)`;
}

const itemLine = (it) => `  • ${it.name} — ${qtyLabel(it.quantity, null, it.unit_type)}${it.unit_type === 'piece' ? '×' : ''} @ ${Math.round(it.cal_per_unit * 10) / 10} cal/${unitWord(it.unit_type)} = ${Math.round(it.cal_per_unit * it.quantity)} cal`;

export function showRecipeText(userId, name) {
  const r = findRecipe(userId, name);
  if (!r) return `No recipe called “${name}” — “recipes” lists them.`;
  const { items, totalCalories, calPerOz } = recipeSummary(userId, r);
  const head = `🍲 ${r.name}:\n${items.map(itemLine).join('\n') || '  (no ingredients yet)'}`;
  if (calPerOz == null) return `${head}\nDraft — ${r.cooked_weight_oz ? 'add ingredients' : 'no cooked weight yet'}. “recipe new ${r.name}” continues building it.`;
  return `${head}\n= ${totalCalories} cal ÷ ${r.cooked_weight_oz} oz cooked = ${calPerOz} cal/oz. Log it with: eat 8 oz ${r.name}`;
}

export function deleteRecipeText(userId, ref) {
  const n = /^\d+$/.test(ref) ? Number(ref) : null;
  let r = null;
  if (n != null) {
    const { pairs } = resolveListing(userId, 'recipes', [n]);
    r = pairs.length ? getRecipeById(userId, pairs[0].id) : null;
  } else r = findRecipe(userId, ref);
  if (!r) return `No recipe called “${ref}” — “recipes” lists them.`;
  deleteRecipe(userId, r.id);
  return `✕ Removed the ${r.name} recipe. (Past logs keep their calories.)`;
}

// ── The conversational recipe builder (recipe_build dialog) ──
// The draft is a real DB row from the first message, so an expired dialog never loses work; every
// non-slash line while building is an answer (dialog.js gives recipe_build the list_nav treatment).
const BUILD_HELP = '(an amount + ingredient per line · “cooked 28 oz” sets the dish weight · “done” finishes · “cancel” discards)';

export function startRecipeBuild(userId, name) {
  const existing = findRecipe(userId, name);
  const r = existing || createRecipe(userId, name);
  setDialogState(userId, { type: 'recipe_build', data: { recipeId: r.id, phase: 'items' }, prompt: `Building ${r.name}` });
  const state = existing ? `${showRecipeText(userId, r.name)}\nKeep going — ` : `🍲 Building ${r.name}. `;
  return `${state}what’s in it? e.g. “16 oz chicken breast”\n${BUILD_HELP}`;
}

function addIngredient(userId, ds, food, qty, unit) {
  const inUnits = toFoodUnits(food, qty, unit);
  if (inUnits == null) return `${food.name} is per-${unitWord(food.unit_type)} — give it that way (e.g. “2 ${food.name}”).`;
  addRecipeItem(userId, ds.data.recipeId, {
    foodId: food.id ?? null, name: food.name, calPerUnit: food.cal_per_unit, unitType: food.unit_type, quantity: inUnits,
  });
  const cal = Math.round(food.cal_per_unit * inUnits);
  return `✓ ${food.name} ${qtyLabel(inUnits, null, food.unit_type)}${food.unit_type === 'piece' ? '×' : ''} (${cal} cal) — next?`;
}

function finishRecipe(userId, recipeId) {
  clearDialogState(userId);
  const r = getRecipeById(userId, recipeId);
  const { items, totalCalories, calPerOz } = recipeSummary(userId, r);
  if (calPerOz == null || !items.length) {
    return `🍲 ${r.name} saved as a draft (${items.length ? 'no cooked weight' : 'no ingredients'} yet) — “recipe new ${r.name}” continues it.`;
  }
  return `🍲 ${r.name}: ${totalCalories} cal ÷ ${r.cooked_weight_oz} oz cooked = ${calPerOz} cal/oz.\nLog it with: eat 8 oz ${r.name}`;
}

// One builder turn. `foodConfirmAns` is dialog.js's parser, passed in so the engine stays parser-free.
export async function recipeBuildStep(userId, text, ds, foodConfirmAns) {
  const t = String(text || '').trim();
  const low = t.toLowerCase();
  const { recipeId, phase, pending } = ds.data;

  if (/^(cancel|nvm|never ?mind|discard)$/.test(low)) {
    clearDialogState(userId);
    deleteRecipe(userId, recipeId);
    return '✕ Draft discarded.';
  }

  if (phase === 'item_confirm') {
    const ans = foodConfirmAns(t);
    if (!ans) return `Reply “yes” to use my guess, send the right cal/${unitWord(pending.unitType)}, or “no” to drop it.`;
    setDialogState(userId, { ...ds, data: { ...ds.data, phase: 'items', pending: null } });
    if (ans.type === 'no') return 'Dropped — next ingredient?';
    const calPerUnit = ans.type === 'calper' ? ans.v : pending.calPerUnit; // (a "total" here has no portion to divide by)
    const food = upsertFood(userId, { name: pending.name, calPerUnit, unitType: pending.unitType, source: 'llm' });
    return `${addIngredient(userId, ds, food, pending.qty, pending.unit)} (saved ${food.name} to your foods too)`;
  }

  if (phase === 'cooked') {
    const w = /^(\d+(?:\.\d+)?)\s*(?:oz|ounces?)?$/i.exec(t);
    if (!w) return 'What does the finished dish weigh, in oz? (a bare number is fine)';
    setRecipeCookedWeight(userId, recipeId, Number(w[1]));
    return finishRecipe(userId, recipeId);
  }

  // phase 'items'
  let m;
  if ((m = /^cooked(?:\s+weight)?\s+(\d+(?:\.\d+)?)\s*(?:oz|ounces?)?$/i.exec(t))) {
    setRecipeCookedWeight(userId, recipeId, Number(m[1]));
    return `✓ Cooked weight ${m[1]} oz — more ingredients, or “done”.`;
  }
  if (/^(done|finish(ed)?|that'?s (it|all))$/.test(low)) {
    const r = getRecipeById(userId, recipeId);
    if (r.cooked_weight_oz) return finishRecipe(userId, recipeId);
    setDialogState(userId, { ...ds, data: { ...ds.data, phase: 'cooked' } });
    return 'What does the finished dish weigh, in oz? (weigh the whole pot minus the pot)';
  }
  const parsed = parseEatLine(t);
  if (!parsed?.food || parsed.qty == null) return `Give an amount with each ingredient — e.g. “16 oz chicken breast”.\n${BUILD_HELP}`;
  const food = findFood(userId, parsed.food);
  if (food) return addIngredient(userId, ds, food, parsed.qty, parsed.unit);
  const est = await estimateFood(parsed.food);
  setDialogState(userId, {
    ...ds,
    data: { ...ds.data, phase: 'item_confirm', pending: { name: parsed.food, qty: parsed.qty, unit: parsed.unit, unitType: est.unitType, calPerUnit: est.calPerUnit } },
  });
  return `${parsed.food} ≈ ${est.calPerUnit} cal/${unitWord(est.unitType)} (my guess). “yes” to use it, the right cal/${unitWord(est.unitType)}, or “no” to drop it.`;
}

// The compact one-liner: recipe chili = 16 oz chicken breast, 1 onion @ 28 oz cooked
// Every named ingredient must already be a canonical food — the one-liner never guesses.
export function defineRecipeCompact(userId, name, body) {
  const at = /^(.*?)(?:\s*@\s*(\d+(?:\.\d+)?)\s*(?:oz|ounces?)?\s*(?:cooked)?)$/i.exec(body.trim());
  const itemsPart = at ? at[1] : body;
  const cookedOz = at ? Number(at[2]) : null;
  const parts = itemsPart.split(/\s*[,;]\s*/).filter(Boolean);
  if (!parts.length) return 'What’s in it? e.g. “recipe chili = 16 oz beef, 1 onion @ 28 oz cooked”.';
  const resolved = []; const unknown = [];
  for (const p of parts) {
    const parsed = parseEatLine(p);
    if (!parsed?.food || parsed.qty == null) return `I couldn’t read “${p}” — each ingredient needs an amount, e.g. “16 oz chicken breast”.`;
    const food = findFood(userId, parsed.food);
    if (!food) { unknown.push(parsed.food); continue; }
    const inUnits = toFoodUnits(food, parsed.qty, parsed.unit);
    if (inUnits == null) return `${food.name} is per-${unitWord(food.unit_type)} — give it that way in the recipe.`;
    resolved.push({ food, quantity: inUnits });
  }
  if (unknown.length) return `I don’t know ${unknown.map((u) => `“${u}”`).join(', ')} yet — “food add ${unknown[0]} <cal>” teaches me, or “recipe new ${name}” builds interactively (I’ll guess unknowns there).`;
  if (!(cookedOz > 0)) return 'How much does the finished dish weigh? End with “@ <oz> cooked”, e.g. “… @ 28 oz cooked”.';
  const existing = findRecipe(userId, name);
  if (existing) deleteRecipe(userId, existing.id); // the one-liner is a full (re)definition
  const r = createRecipe(userId, name);
  for (const { food, quantity } of resolved) {
    addRecipeItem(userId, r.id, { foodId: food.id, name: food.name, calPerUnit: food.cal_per_unit, unitType: food.unit_type, quantity });
  }
  setRecipeCookedWeight(userId, r.id, cookedOz);
  return showRecipeText(userId, r.name);
}

// ── The daily calorie target (the goal line on the chart + the "/ 2000" in every tally) ──
export function setCalorieTarget(userId, target) {
  const cal = ensureCaloriesMetric(userId);
  setMetricTarget(userId, cal.id, target);
  return `🎯 Daily target set to ${target} kcal.\n${tallyText(userId, 'calories')}`;
}

// ── Weight (the report's graph): a point metric, shared with metrics' own "measure weight …" ──
// `at` lets the web's weight log backdate an entry (the chart is a real time axis, so the date matters).
export function recordWeight(userId, value, at = Date.now()) {
  const existing = getMetric(userId, 'weight');
  const m = existing || getOrCreateMetric(userId, 'weight', { unit: 'lbs', aggregation: 'last', measurementType: 'point' });
  const id = insertMetricValue({ userId, metricId: m.id, value, recordedAt: at });
  recordUndo(userId, 'metric_log', { ids: [id] }, `↩ Undid the weight log (${value}${m.unit ? ` ${m.unit}` : ''}).`);
  return `⚖️ ${value}${m.unit ? ` ${m.unit}` : ''} logged.`;
}
