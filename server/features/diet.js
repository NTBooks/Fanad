// The Diet module (opt-in): the canonical-foods calorie tracker. "eat 4 oz chicken breast" looks the food
// up in YOUR library and logs weight × cal/oz; an unknown food gets ONE LLM guess you confirm or correct,
// and the answer is saved as a canonical food (never re-guessed). Recipes are built from those foods plus
// a cooked weight (ingredients ÷ cooked oz = the recipe's own cal/oz). The engine lives in server/diet.js;
// this module is only its chat surface. Logging lands on the 'calories' metric, so it's separate from —
// but compatible with — the Metrics module: tally/chart include it when Metrics is also on, and the
// app-wide "undo" (route() + server/undo.js) removes the last portion either way.
import {
  startEat, confirmFood, answerQty, recipeBuildStep,
  saveMeal, confirmMeal, confirmAdhocMeal, eatMealText,
  foodsText, addFoodText, setFoodText, deleteFoodText, showFoodText,
  recipesText, showRecipeText, deleteRecipeText, startRecipeBuild, defineRecipeCompact,
  recordWeight, setCalorieTarget, setWhateverDay,
} from '../diet.js';
import { foodConfirmAnswer, qtyAnswer, notebookGuardAnswer, setDialogState, clearDialogState } from '../dialog.js';
import { registerFeature, tryFeatureCommand } from './registry.js';
import { getCurrentNotebookId, clearCurrentNotebookId } from '../settings.js';
import { getNotebook, effectiveUserId } from '../repo.js';

function handleFoodConfirm(userId, text, ds) {
  const ans = foodConfirmAnswer(text);
  if (!ans) return 'Reply “yes” to save & log, send the right calories per unit (a bare number), or “no” to skip.';
  return confirmFood(userId, ds.data, ans);
}

function handleEatQty(userId, text, ds) {
  const ans = qtyAnswer(text);
  if (!ans) return `How much ${ds.data.name}? (e.g. “4 oz” — or “no” to skip)`;
  return answerQty(userId, ds.data, ans);
}

function handleMealConfirm(userId, text, ds) {
  const ans = foodConfirmAnswer(text);
  if (!ans) return 'Reply “yes” to save the meal, send the right total calories (a bare number), or “no” to skip.';
  return confirmMeal(userId, ds.data, ans);
}

function handleAdhocMealConfirm(userId, text, ds) {
  const ans = foodConfirmAnswer(text);
  if (!ans) return 'Reply “yes” to log the plate, send the right total calories (a bare number), or “no” to skip.';
  return confirmAdhocMeal(userId, ds.data, ans);
}

const handleRecipeBuild = (userId, text, ds) => recipeBuildStep(userId, text, ds, foodConfirmAnswer);

// Each run() re-checks the gate itself: an off module answers with the turn-on offer, never silence.
const gated = (fn) => (ctx, hit) => (ctx.isOn('diet') ? fn(ctx, hit) : ctx.offerOn('diet'));

// Diet data is one lifelong record, so it lives in the MAIN space — logging from inside a notebook is
// almost always an accident (the stats land where the report/undo/graphs won't see them). Every WRITE
// command gets this guard: warn, offer a one-tap switch to Main (the command then re-runs there), allow
// "log here" on purpose, or cancel. Read-only commands (foods/recipes/show) stay unguarded. `ctx.nbOk`
// marks a deliberate re-run after the user answered, so the guard can't loop.
const nbGuard = (fn) => gated((ctx, hit) => {
  const nbId = ctx.nbOk ? null : getCurrentNotebookId(ctx.identityId);
  if (nbId == null) return fn(ctx, hit);
  const nb = getNotebook(nbId);
  setDialogState(ctx.userId, { type: 'diet_notebook', prompt: 'log in Main?', data: { text: ctx.t } });
  return {
    text: `⚠️ You're in 📓 ${nb?.notebook_name || 'a notebook'} — food & weight logs live in your Main space, where the report and graphs look. Switch to Main and run that there?`,
    options: ['Switch to Main', 'Log here', 'Cancel'],
  };
});

// The diet_notebook answer: switch → back to Main and re-run the saved command there; here → re-run in
// the notebook on purpose; cancel/escape → nothing logged. The re-run goes back through the feature
// registry with nbOk so it can't re-arm the guard.
async function handleDietNotebook(userId, text, ds, extras = {}) {
  const ans = notebookGuardAnswer(text);
  if (!ans) return 'Reply “switch” to log it in Main, “log here” to keep it in this notebook, or “cancel”.';
  clearDialogState(userId);
  const pending = (ds.data?.text || '').trim();
  const { identityId, channel, energy, isOn, offerOn } = extras;
  if (ans === 'cancel' || !pending || identityId == null) return 'Okay — nothing logged.';
  const rerun = async (uid) => {
    const hit = await tryFeatureCommand({ userId: uid, identityId, t: pending, lower: pending.toLowerCase(), channel, energy, isOn, offerOn, nbOk: true });
    return hit ? hit.reply : 'Hmm — I couldn’t re-run that one. Try typing it again.';
  };
  if (ans === 'here') return rerun(userId);
  clearCurrentNotebookId(identityId);            // switch to Main…
  const out = await rerun(effectiveUserId(identityId)); // …and log it there
  const prefix = '📖 Switched to Main.\n';
  return typeof out === 'string' ? prefix + out : { ...out, text: prefix + (out.text || '') };
}

// The unit tail of "food add": /oz · /g · /piece · /serving (aliases: gram, each). Default is per-ounce.
const UNIT_TAIL = { oz: 'ounce', ounce: 'ounce', g: 'gram', gram: 'gram', piece: 'piece', each: 'piece', serving: 'serving' };

registerFeature({
  name: 'diet',
  commands: [
    // Meals — BOTH above the generic eat matcher, which would otherwise read "meal breakfast" as a food
    // name. "save meal <one-word-name> <what's in it> [<n> cal]" saves (never logs); "eat meal <name>"
    // logs a typical serving (bare "eat <name>" works too, through the normal food lookup below).
    { match: ({ t }) => /^\/?(?:eat|ate)\s+meal\s+(.+)$/i.exec(t),
      run: nbGuard(({ userId }, m) => eatMealText(userId, m[1].trim())) },
    { match: ({ t }) => /^\/?save\s+meal\s+(\S+)\s+(.+)$/i.exec(t),
      run: nbGuard(({ userId }, m) => saveMeal(userId, m[1].trim(), m[2].trim())) },
    // "eat whatever" marks today off the record (cheat/fast/travel day) — must beat the generic eat
    // matcher below, which would otherwise save a food called "whatever". "eat whatever off" clears it.
    { match: ({ t }) => /^\/?(?:eat|ate)\s+whatever(?:\s+(off|on|clear|no|cancel|undo))?\.?$/i.exec(t),
      run: nbGuard(({ userId }, m) => setWhateverDay(userId, !/^(off|clear|no|cancel|undo)$/i.test(m[1] || ''))) },
    { match: ({ t }) => /^\/?(?:eat|ate)\s+(.+)$/i.exec(t),
      run: nbGuard(({ userId }, m) => startEat(userId, m[1].trim())) },
    { match: ({ lower }) => lower === '/foods' || lower === 'foods',
      run: gated(({ userId }) => foodsText(userId)) },
    // "food add <name> <cal>[/oz|/g|/piece]" — the LAST number is the calories, so names with digits
    // ("7up") still parse. "food set <ref> <cal>" corrects; ref is a listing number or a name.
    { match: ({ t }) => /^\/?food\s+add\s+(.+?)\s+(\d+(?:\.\d+)?)\s*(?:cal(?:ories)?)?\s*(?:[/\s]\s*(oz|ounce|g|gram|piece|each))?$/i.exec(t),
      run: nbGuard(({ userId }, m) => addFoodText(userId, m[1].trim(), Number(m[2]), UNIT_TAIL[(m[3] || 'oz').toLowerCase()])) },
    { match: ({ t }) => /^\/?food\s+set\s+(.+?)\s+(\d+(?:\.\d+)?)$/i.exec(t),
      run: nbGuard(({ userId }, m) => setFoodText(userId, m[1].trim(), Number(m[2]))) },
    { match: ({ t }) => /^\/?food\s+(?:del|delete|rm|remove)\s+(.+)$/i.exec(t),
      run: nbGuard(({ userId }, m) => deleteFoodText(userId, m[1].trim())) },
    { match: ({ t }) => /^\/?food\s+show\s+(.+)$/i.exec(t),
      run: gated(({ userId }, m) => showFoodText(userId, m[1].trim())) },
    { match: ({ lower }) => lower === '/recipes' || lower === 'recipes',
      run: gated(({ userId }) => recipesText(userId)) },
    { match: ({ t }) => /^\/?recipe\s+new\s+(.+)$/i.exec(t),
      run: nbGuard(({ userId }, m) => { clearDialogState(userId); return startRecipeBuild(userId, m[1].trim()); }) },
    { match: ({ t }) => /^\/?recipe\s+(?:show)\s+(.+)$/i.exec(t),
      run: gated(({ userId }, m) => showRecipeText(userId, m[1].trim())) },
    { match: ({ t }) => /^\/?recipe\s+(?:del|delete|rm|remove)\s+(.+)$/i.exec(t),
      run: nbGuard(({ userId }, m) => deleteRecipeText(userId, m[1].trim())) },
    // The compact one-liner: "recipe chili = 16 oz beef, 1 onion @ 28 oz cooked". The "=" is what
    // distinguishes it from prose ("recipe ideas for tonight" falls through to capture).
    { match: ({ t }) => /^\/?recipe\s+([^=]+?)\s*=\s*(.+)$/i.exec(t),
      run: nbGuard(({ userId }, m) => defineRecipeCompact(userId, m[1].trim(), m[2].trim())) },
    // "weight 182" — the report's weight graph. Requires the number so "weight" prose still captures.
    { match: ({ t }) => /^\/?weight\s+(\d+(?:\.\d+)?)$/i.exec(t),
      run: nbGuard(({ userId }, m) => recordWeight(userId, Number(m[1]))) },
    // "target 1800" (or "calorie target 1800") — the daily kcal goal. Whole-message match only, so
    // prose like "my target is to run more" still files as a task.
    { match: ({ t }) => /^\/?(?:calories?\s+)?target\s+(\d+)$/i.exec(t),
      run: nbGuard(({ userId }, m) => setCalorieTarget(userId, Number(m[1]))) },
    // ("undo" left this module: it's app-wide now — matched in route() ahead of the dialog check, backed
    // by the undo stack in server/undo.js. logFood pushes each portion's row onto it in the engine.)
  ],
  dialogHandlers: {
    food_confirm: handleFoodConfirm, meal_confirm: handleMealConfirm, eat_meal_confirm: handleAdhocMealConfirm,
    eat_qty: handleEatQty, recipe_build: handleRecipeBuild, diet_notebook: handleDietNotebook,
  },
});
