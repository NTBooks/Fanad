// Diet math (§13.5) — the pure calorie arithmetic behind the Diet module, shared verbatim by the server
// engine (server/diet.js), the web GUI's live recipe preview, and clientConfig's taxonomy export. The core
// loop it encodes is the user's proven workflow: weigh the food, look up its calories per ounce, multiply.
// Foods carry ONE density number (cal_per_unit) in ONE unit_type; recipes derive theirs from a snapshot of
// ingredients divided by the dish's COOKED weight (so the user weighs the finished pot, never guesses
// cooking loss). No imports, no I/O — everything here is a plain function of its arguments.

export const UNIT_TYPES = ['ounce', 'gram', 'piece', 'serving'];

// Short display labels ("45 cal/oz", "1.3 cal/g", "70 cal/piece", "140 cal/serving") — the web view and
// chat share these.
export const UNIT_LABEL = { ounce: 'oz', gram: 'g', piece: 'piece', serving: 'serving' };

// The count-shaped unit types: a bare number is a count of them (bare "eat skyr" = 1), and a weight can
// never be reconciled against them. 'serving' is a food's TYPICAL SERVING taught by a stated calorie
// count with no amount ("eat skyr 140cal") or by "save meal"; it does all its math like 'piece'.
export const COUNT_UNIT_TYPES = ['piece', 'serving'];

export const GRAMS_PER_OZ = 28.35;
export const OZ_PER_LB = 16;

// Convert an EATEN quantity (`unit` = 'oz'|'g'|'lb'|'piece'|null) into the food's own unit_type units.
// `null` means "the user gave a bare number" — taken as the food's own unit. Weight↔weight converts
// (oz↔g via 28.35, lb → ×16 oz); a weight given for a count-food (or vice versa) can't be reconciled
// without a per-piece weight we don't store, so it returns null and the caller re-asks. The 'piece'
// unit token doubles as the count token for serving foods — no separate 'serving' token exists.
export function toFoodUnits(food, qty, unit) {
  const n = Number(qty);
  if (!(n > 0)) return null;
  const u = unit || null;
  if (COUNT_UNIT_TYPES.includes(food.unit_type)) return u == null || u === 'piece' ? n : null;
  if (u === 'piece') return null;
  const oz = u === 'g' ? n / GRAMS_PER_OZ : u === 'lb' ? n * OZ_PER_LB : n; // null|'oz' → already ounces…
  if (u == null && food.unit_type === 'gram') return n; // …except a bare number for a gram-food IS grams
  return food.unit_type === 'gram' ? oz * GRAMS_PER_OZ : oz;
}

// Whole calories for an eaten quantity of a food (or recipe-as-food). Null when the units don't reconcile.
export function caloriesFor(food, qty, unit) {
  const inUnits = toFoodUnits(food, qty, unit);
  return inUnits == null ? null : Math.round(inUnits * food.cal_per_unit);
}

// Recipe items each carry {cal_per_unit, quantity} (density snapshot × how much went in).
export function recipeTotals(items) {
  return { totalCalories: Math.round(items.reduce((s, it) => s + it.cal_per_unit * it.quantity, 0)) };
}

// The recipe's own density: total ingredient calories ÷ the finished dish's cooked weight in oz.
export function recipeCalPerOz(items, cookedWeightOz) {
  const oz = Number(cookedWeightOz);
  if (!(oz > 0)) return null;
  return Math.round((recipeTotals(items).totalCalories / oz) * 10) / 10;
}

// Label for an eaten portion, used in entry_label ("4 oz chicken breast") and confirmations. Counts
// (pieces, servings) show bare ("2 eggs" reads from the food name); weights carry their unit.
export function qtyLabel(qty, unit, unitType) {
  const n = Number(qty);
  const rounded = Math.round(n * 100) / 100;
  const u = unit || (unitType === 'gram' ? 'g' : COUNT_UNIT_TYPES.includes(unitType) ? null : 'oz');
  return u == null || u === 'piece' ? `${rounded}` : `${rounded} ${u}`;
}
