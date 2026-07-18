// The Diet module (§13.5), chat-first: toggle gating, the canonical-foods eat flow (guess → confirm /
// correct → auto-save → silent reuse), quantity parsing & unit conversion, recipes (compact one-liner and
// the conversational builder), weight, undo, and per-user scoping. Runs on the mock provider: an unknown
// weighed food guesses 50 cal/oz, a piece-word food (egg/cookie/…) guesses 70 cal/piece — so every
// calorie below is exact arithmetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-diet-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');
const { setUserFeatures, getCurrentNotebookId } = await import('../server/settings.js');
const { getMetric, listFoods, getOrCreateTelegramUser, metricValuesSince, getDietDay, listDietDays } = await import('../server/repo.js');
const { parseEatLine } = await import('../server/diet.js');
const { dayStartOf } = await import('../shared/timeframe.js');

migrate();
const say = (text) => handleMessage({ text });

test('parseEatLine covers the quantity forms', () => {
  assert.deepEqual(parseEatLine('4oz chicken breast'), { qty: 4, unit: 'oz', food: 'chicken breast', article: false, cal: null });
  assert.deepEqual(parseEatLine('12 oz of chili'), { qty: 12, unit: 'oz', food: 'chili', article: false, cal: null });
  assert.deepEqual(parseEatLine('chicken breast 4 oz'), { qty: 4, unit: 'oz', food: 'chicken breast', article: false, cal: null });
  assert.deepEqual(parseEatLine('2 eggs'), { qty: 2, unit: null, food: 'eggs', article: false, cal: null });
  assert.deepEqual(parseEatLine('half a pound of chili'), { qty: 0.5, unit: 'lb', food: 'chili', article: false, cal: null });
  assert.deepEqual(parseEatLine('an egg'), { qty: 1, unit: null, food: 'egg', article: true, cal: null });
  // Unit-less trailing digits stay part of the name; a bare food has no quantity.
  assert.deepEqual(parseEatLine('7up'), { qty: null, unit: null, food: '7up', article: false, cal: null });
  assert.deepEqual(parseEatLine('route 66 bar'), { qty: null, unit: null, food: 'route 66 bar', article: false, cal: null });
  assert.deepEqual(parseEatLine('chicken breast'), { qty: null, unit: null, food: 'chicken breast', article: false, cal: null });
});

test('parseEatLine peels a stated calorie total, in every fuzzy form', () => {
  assert.deepEqual(parseEatLine('olives 80cal'), { qty: null, unit: null, food: 'olives', article: false, cal: 80 });
  assert.deepEqual(parseEatLine('olives 80 cal'), { qty: null, unit: null, food: 'olives', article: false, cal: 80 });
  assert.deepEqual(parseEatLine('olives 80 calories'), { qty: null, unit: null, food: 'olives', article: false, cal: 80 });
  assert.deepEqual(parseEatLine('olives, 80 kcal'), { qty: null, unit: null, food: 'olives', article: false, cal: 80 });
  assert.deepEqual(parseEatLine('80 calories of olives'), { qty: null, unit: null, food: 'olives', article: false, cal: 80 });
  assert.deepEqual(parseEatLine('80cal olives'), { qty: null, unit: null, food: 'olives', article: false, cal: 80 });
  // A quantity AND a total both survive — the remainder still parses through the normal grammar.
  assert.deepEqual(parseEatLine('4 oz olives 80 cal'), { qty: 4, unit: 'oz', food: 'olives', article: false, cal: 80 });
  assert.deepEqual(parseEatLine('2 mints 10 cal'), { qty: 2, unit: null, food: 'mints', article: false, cal: 10 });
  // Calories with no food at all → empty name (startEat nudges instead of guessing a food called "cal").
  assert.deepEqual(parseEatLine('80 cal'), { qty: null, unit: null, food: '', article: false, cal: 80 });
});

test('eat is blocked until the Diet module is opted in', async () => {
  setUserFeatures(1, { diet: false });
  assert.match((await say('eat 4oz chicken breast')).reply, /Diet is off/i);
});

test('unknown food: guess → yes → saved AND logged (diet on, metrics off)', async () => {
  setUserFeatures(1, { diet: true, metrics: false });
  const r = await say('eat 4 oz chicken thigh');
  assert.match(r.reply, /chicken thigh ≈ 50 cal\/oz/);
  assert.match(r.reply, /200 cal/); // 4 oz × 50, previewed before confirming
  const conf = await say('yes');
  assert.match(conf.reply, /chicken thigh saved at 50 cal\/oz/);
  assert.match(conf.reply, /Logged 4 oz chicken thigh: 200 cal/);
  assert.match((await say('foods')).reply, /chicken thigh — 50 cal\/oz/);
});

test('correction persists as the canonical value — and is reused with NO second guess', async () => {
  await say('eat 4 oz chicken breast');
  const conf = await say('45');
  assert.match(conf.reply, /chicken breast saved at 45 cal\/oz/);
  assert.match(conf.reply, /Logged 4 oz chicken breast: 180 cal/);
  // Silent reuse: the next eat computes immediately — no guess, no confirm question.
  const again = await say('eat 2 oz chicken breast');
  assert.match(again.reply, /Logged 2 oz chicken breast: 90 cal/);
  assert.doesNotMatch(again.reply, /my guess|Reply/);
});

test('"no" saves nothing and logs nothing', async () => {
  await say('eat 4 oz mystery stew');
  assert.match((await say('no')).reply, /nothing saved or logged/i);
  assert.doesNotMatch((await say('foods')).reply, /mystery stew/);
});

test('bare eat of a known weighed food asks for the weight', async () => {
  const ask = await say('eat chicken breast');
  assert.match(ask.reply, /How much chicken breast/);
  assert.match((await say('4 oz')).reply, /Logged 4 oz chicken breast: 180 cal/);
});

test('piece foods: counts, plural fallback, and "1" defaulting', async () => {
  await say('eat 2 eggs'); // unknown → piece guess (70/piece)
  const conf = await say('yes');
  assert.match(conf.reply, /eggs saved at 70 cal\/piece/);
  assert.match(conf.reply, /Logged 2 eggs: 140 cal/);
  // Bare singular later: plural fallback finds "eggs", a piece food defaults to 1.
  assert.match((await say('eat egg')).reply, /Logged eggs: 70 cal/);
});

test('unit conversion: a per-gram food eaten in ounces', async () => {
  assert.match((await say('food add rice 1.3/g')).reply, /rice — 1\.3 cal\/g/);
  // 2 oz = 56.7 g × 1.3 = 73.71 → 74
  assert.match((await say('eat 2 oz rice')).reply, /Logged 2 oz rice: 74 cal/);
});

test('compact recipe: ingredient snapshot ÷ cooked weight, logged by cooked oz', async () => {
  const r = await say('recipe bowl = 16 oz chicken breast, 100 g rice @ 28 oz cooked');
  // 16 × 45 = 720, 100 × 1.3 = 130 → 850 ÷ 28 = 30.4 cal/oz (rounded to a decimal)
  assert.match(r.reply, /850 cal ÷ 28 oz cooked = 30\.4 cal\/oz/);
  assert.match((await say('eat 8 oz bowl')).reply, /Logged 8 oz bowl: 243 cal/); // 8 × 30.4 = 243.2
  assert.match((await say('recipes')).reply, /bowl — 30\.4 cal\/oz/);
});

test('compact recipe refuses unknown ingredients (it never guesses)', async () => {
  assert.match((await say('recipe stew = 4 oz unicorn @ 10 oz cooked')).reply, /don’t know “unicorn”/);
});

test('conversational builder: ingredients → cooked weight → done', async () => {
  await say('recipe new soup');
  assert.match((await say('4 oz chicken breast')).reply, /✓ chicken breast 4 oz \(180 cal\)/);
  // An unknown ingredient gets a guess that must be answered before building continues.
  assert.match((await say('4 oz broth')).reply, /broth ≈ 50 cal\/oz/);
  assert.match((await say('5')).reply, /✓ broth 4 oz \(20 cal\)/); // corrected to 5 cal/oz, saved as a food too
  assert.match((await say('done')).reply, /finished dish weigh/i);
  // (180 + 20) ÷ 10 oz = 20 cal/oz
  assert.match((await say('10')).reply, /200 cal ÷ 10 oz cooked = 20 cal\/oz/);
  assert.match((await say('eat 5 oz soup')).reply, /Logged 5 oz soup: 100 cal/);
});

test('undo removes the last portion (diet-only user, metrics still off)', async () => {
  assert.match((await say('undo')).reply, /Undid “5 oz soup”/);
});

test('eat writes ONLY calories — no macro metrics get created', () => {
  assert.equal(getMetric(1, 'protein'), null);
  assert.equal(getMetric(1, 'carbs'), null);
  assert.equal(getMetric(1, 'fat'), null);
  assert.ok(getMetric(1, 'calories'));
});

test('weight logs a point metric for the report graph', async () => {
  assert.match((await say('weight 182')).reply, /⚖️ 182 lbs logged/);
  assert.equal(getMetric(1, 'weight').measurement_type, 'point');
});

test('target sets the daily kcal goal (and shows in the tally line)', async () => {
  assert.match((await say('target 1800')).reply, /🎯 Daily target set to 1800 kcal/);
  assert.equal(getMetric(1, 'calories').target, 1800);
  assert.match((await say('calorie target 2200')).reply, /2200 kcal/);
  // Prose stays prose: a sentence containing "target" is a task, not a command.
  assert.match((await say('my target is to run more this month')).reply, /Filed/);
});

test('food set / food del work by listing position (1..N, never raw ids)', async () => {
  const list = (await say('foods')).reply;
  const second = /2\. ([^—]+) —/.exec(list)[1].trim();
  assert.match((await say('food set 2 99')).reply, new RegExp(`${second} is now 99`));
  assert.match((await say('food del 2')).reply, new RegExp(`Removed ${second}`));
  assert.doesNotMatch((await say('foods')).reply, new RegExp(`${second} —`));
});

test('foods are per-user', async () => {
  assert.ok(listFoods(1).length > 0);
  const uid2 = getOrCreateTelegramUser(777001, 'other');
  assert.equal(listFoods(uid2).length, 0);
});

// ── Stated calories: the user's own count logs immediately, no interrogation — and with no amount it
// IS the typical serving, saved as a per-serving food a bare re-eat reuses forever ──

test('stated calories alone save a typical-serving food and log it — no guess, no dialog', async () => {
  const r = await say('eat skyr 140cal');
  assert.match(r.reply, /skyr saved at 140 cal\/serving/);
  assert.match(r.reply, /Logged skyr: 140 cal/);
  assert.doesNotMatch(r.reply, /my guess|Reply/);
  const f = listFoods(1).find((x) => /^skyr$/i.test(x.name));
  assert.equal(f.unit_type, 'serving');
  assert.equal(f.cal_per_unit, 140);
  // The leading phrasing works the same.
  assert.match((await say('eat 80 calories of olives')).reply, /olives saved at 80 cal\/serving/);
});

test('a bare re-eat logs one typical serving; counts multiply; weights don’t reconcile', async () => {
  const r = await say('eat skyr');
  assert.match(r.reply, /Logged skyr: 140 cal/);
  assert.doesNotMatch(r.reply, /my guess|How much|Reply/);
  assert.match((await say('eat 2 skyr')).reply, /Logged 2 skyr: 280 cal/);
  assert.match((await say('eat 4 oz skyr')).reply, /skyr is a per-serving food/);
});

test('restating the calories redefines the typical serving (serving foods only)', async () => {
  const r = await say('eat skyr 200cal');
  assert.match(r.reply, /skyr is now 200 cal\/serving/);
  assert.match(r.reply, /Logged skyr: 200 cal/);
  assert.equal(listFoods(1).find((x) => /^skyr$/i.test(x.name)).cal_per_unit, 200);
  assert.match((await say('eat skyr')).reply, /Logged skyr: 200 cal/);
});

test('bare calories with no food still nudge — no empty-named food is ever saved', async () => {
  assert.match((await say('eat 80 cal')).reply, /What did you eat/);
  assert.ok(!listFoods(1).some((f) => !f.name.trim()));
});

test('amount + stated calories: the density comes from the user’s numbers, saved silently', async () => {
  const r = await say('eat 4 oz pickles 60 cal');
  assert.match(r.reply, /pickles saved at 15 cal\/oz/);
  assert.match(r.reply, /Logged 4 oz pickles: 60 cal/);
  assert.doesNotMatch(r.reply, /my guess|Reply/);
  // Reused like any canonical food from then on.
  assert.match((await say('eat 2 oz pickles')).reply, /Logged 2 oz pickles: 30 cal/);
  // A bare count derives a per-piece food the same way.
  const m = await say('eat 2 mints 10 cal');
  assert.match(m.reply, /mints saved at 5 cal\/piece/);
  assert.match(m.reply, /Logged 2 mints: 10 cal/);
});

test('stated calories on a KNOWN food log the override without touching its density', async () => {
  assert.match((await say('eat pickles 45 cal')).reply, /Logged pickles: 45 cal/);
  assert.match((await say('eat 2 oz pickles')).reply, /Logged 2 oz pickles: 30 cal/); // still 15 cal/oz
});

test('volume junk never becomes a food name — the LLM pass strips it', async () => {
  const r = await say('eat gherkins 1/4 cup');
  assert.match(r.reply, /gherkins ≈ 50 cal\/oz/); // the guess is for "gherkins", not "gherkins 1/4 cup"
  assert.doesNotMatch(r.reply, /1\/4 cup/);
  assert.match((await say('no')).reply, /nothing saved or logged/i);
});

test('a pending diet question never swallows a fresh eat command', async () => {
  assert.match((await say('eat pickles')).reply, /How much pickles/); // eat_qty now pending
  // Exactly 3 words — used to be trapped as an "answer" and re-prompted about pickles.
  assert.match((await say('eat skyr 140cal')).reply, /Logged skyr: 140 cal/);
  // food_confirm escapes the same way: a bare command runs instead of re-prompting.
  assert.match((await say('eat 4 oz weird stew')).reply, /weird stew ≈ 50 cal\/oz/);
  assert.match((await say('foods')).reply, /🥗 Your foods/);
  assert.doesNotMatch((await say('foods')).reply, /weird stew/);
});

// ── Meals: a serving food + a description — the same-breakfast-every-day shortcut ──
// (skyr is back at 140 cal/serving here — the escape test above restated it.)

test('save meal with a stated total saves silently and lists with its contents', async () => {
  const r = await say('save meal breakfast 2 eggs, skyr, toast 450cal');
  assert.match(r.reply, /breakfast saved at 450 cal\/serving \(2 eggs, skyr, toast\)/);
  assert.doesNotMatch(r.reply, /Logged/); // save is not eat
  const f = listFoods(1).find((x) => x.name === 'breakfast');
  assert.equal(f.unit_type, 'serving');
  assert.equal(f.description, '2 eggs, skyr, toast');
  assert.match((await say('foods')).reply, /breakfast — 450 cal\/serving · 2 eggs, skyr, toast/);
});

test('eat meal / bare eat / a count all log the meal', async () => {
  assert.match((await say('eat meal breakfast')).reply, /Logged breakfast: 450 cal/);
  assert.match((await say('eat breakfast')).reply, /Logged breakfast: 450 cal/);
  assert.match((await say('eat 2 breakfast')).reply, /Logged 2 breakfast: 900 cal/);
});

test('restating updates the meal; re-saving overwrites the description', async () => {
  assert.match((await say('eat breakfast 500cal')).reply, /breakfast is now 500 cal\/serving/);
  const r = await say('save meal breakfast 3 eggs and toast 520 cal');
  assert.match(r.reply, /breakfast saved at 520 cal\/serving \(3 eggs and toast\)/);
  assert.equal(listFoods(1).find((x) => x.name === 'breakfast').description, '3 eggs and toast');
});

test('save meal without a total: the library prices what it can, ONE guess covers the rest', async () => {
  // eggs are 70/piece and skyr 140/serving from earlier tests; the mock meal guess is 100/item.
  const r = await say('save meal lunch 2 eggs, skyr, mystery bite');
  assert.match(r.reply, /lunch ≈ 380 cal \(2 eggs 140 · skyr 140 · mystery bite ~100 guess\)/);
  const conf = await say('yes');
  assert.match(conf.reply, /lunch saved at 380 cal\/serving \(2 eggs, skyr, mystery bite\)/);
  assert.match((await say('eat lunch')).reply, /Logged lunch: 380 cal/);
  // The guessed component was NOT saved as a food of its own — only the meal total was confirmed.
  assert.ok(!listFoods(1).some((x) => /mystery bite/i.test(x.name)));
});

test('a bare number corrects the meal total; "no" saves nothing', async () => {
  await say('save meal snack cheese and crackers'); // both unknown → 100 + 100
  const corr = await say('250');
  assert.match(corr.reply, /snack saved at 250 cal\/serving \(cheese and crackers\)/);
  await say('save meal dinner beans, franks');
  assert.match((await say('no')).reply, /nothing saved/i);
  assert.ok(!listFoods(1).some((x) => x.name === 'dinner'));
});

test('a pending meal confirm never swallows a fresh command — including "save meal"', async () => {
  await say('save meal supper leftover surprise'); // meal_confirm pending
  assert.match((await say('foods')).reply, /🥗 Your foods/); // escapes and drops the confirm
  assert.ok(!listFoods(1).some((x) => x.name === 'supper'));
  // "save meal …" is a COMMAND, not the yes-word "save" — it must escape too, never confirm supper.
  await say('save meal supper leftover surprise'); // re-arm the confirm
  const r = await say('save meal brunch bagel 300cal');
  assert.match(r.reply, /brunch saved at 300 cal\/serving/);
  assert.ok(!listFoods(1).some((x) => x.name === 'supper')); // not read as "yes"
});

test('eat meal with an unknown name nudges toward save meal — never the guess flow', async () => {
  const r = await say('eat meal nosuch');
  assert.match(r.reply, /don’t have a meal called “nosuch”/);
  assert.doesNotMatch(r.reply, /my guess/);
});

test('prose containing "meal" still files as a task', async () => {
  assert.match((await say('save mealtime ideas for the week')).reply, /Filed/);
});

// ── The ad-hoc plate: "eat <a, comma, list>" is several foods thrown together, logged as ONE entry.
// The leading amount binds to its OWN item — the bug this fixes read "8 oz chicken, …" as 8 oz of the
// WHOLE plate. Reuses save-meal's pricing (library first, one batched guess for the rest) but logs now. ──
test('eat a comma list is a one-off plate: each amount binds to its own item', async () => {
  await say('food add grilled chicken 50'); // 50 cal/oz, known
  const r = await say('eat 8 oz grilled chicken, half red pepper, 5 white mushrooms');
  // 8 oz binds to the chicken ALONE → 8 × 50 = 400; the two unknowns guess 100 each → 600 total.
  assert.match(r.reply, /8 oz grilled chicken 400/);
  assert.match(r.reply, /half red pepper ~100 guess/);
  assert.match(r.reply, /5 white mushrooms ~100 guess/); // the amount rides along to the guess, too
  assert.match(r.reply, /≈ 600 cal/);
  const conf = await say('yes');
  assert.match(conf.reply, /Logged 8 oz grilled chicken, half red pepper, 5 white mushrooms: 600 cal/);
});

test('an all-known comma plate logs immediately — no guess, no confirm', async () => {
  await say('food add turkey 40'); // 40 cal/oz
  const r = await say('eat 4 oz turkey, 2 oz grilled chicken');
  // 4 × 40 = 160 + 2 × 50 = 100 → 260, logged now (both foods are already in the library).
  assert.match(r.reply, /Logged 4 oz turkey, 2 oz grilled chicken: 260 cal/);
  assert.doesNotMatch(r.reply, /guess|“yes” logs it/);
});

test('a stated total on a comma line is one logged entry, not a plate', async () => {
  const r = await say('eat crackers, cheese, 250 cal'); // the user's own count for the whole line
  assert.match(r.reply, /Logged crackers, cheese: 250 cal/);
  assert.doesNotMatch(r.reply, /guess|“yes” logs it/);
});

test('a pending ad-hoc plate confirm never swallows a fresh command', async () => {
  await say('eat 8 oz grilled chicken, mystery veg'); // eat_meal_confirm pending (mystery veg guessed)
  assert.match((await say('foods')).reply, /🥗 Your foods/); // escapes and drops the confirm
});

// ── "eat whatever": take a day off the record (cheat/fast/travel) — the graph tints it and the average
// skips it. Marks the current logical day; "eat whatever off" clears it. ──
test('"eat whatever" marks today off the record — and never saves a food called "whatever"', async () => {
  const before = listFoods(1).length;
  const r = await say('eat whatever');
  assert.match(r.reply, /eat-whatever day/i);
  assert.ok(getDietDay(1, dayStartOf(Date.now())), 'today is marked');
  // Intercepted before the generic eat matcher — no phantom food, no guess dialog.
  assert.doesNotMatch(r.reply, /my guess|Reply .yes/);
  assert.equal(listFoods(1).length, before, 'no new food row');
  assert.ok(!listFoods(1).some((f) => /^whatever$/i.test(f.name)));
  await say('eat whatever off'); // clean up
});

test('"eat whatever off" clears the day; a second clear is a no-op message', async () => {
  await say('eat whatever');
  assert.match((await say('eat whatever off')).reply, /counts toward your averages again/i);
  assert.equal(getDietDay(1, dayStartOf(Date.now())), null);
  assert.match((await say('eat whatever off')).reply, /wasn.t marked/i);
});

test('marking is idempotent — one row per day, and it says so', async () => {
  await say('eat whatever');
  assert.match((await say('eat whatever')).reply, /already was/);
  assert.equal(listDietDays(1).filter((d) => d.day_start === dayStartOf(Date.now())).length, 1);
  await say('eat whatever off'); // clean up so later tests aren't skewed
});

// ── The notebook guard: diet writes belong in Main; a notebook gets a warn + switch/here/cancel choice ──
test('a diet write inside a notebook warns first and logs NOTHING until answered', async () => {
  const u = getOrCreateTelegramUser(88_001, 'nbdiet1');
  setUserFeatures(u, { diet: true, notebook: true });
  await handleMessage({ userId: u, text: 'notebook Work' });
  const warn = await handleMessage({ userId: u, text: 'weight 182' });
  assert.match(warn.reply, /You're in 📓 Work/);
  assert.ok(warn.options.includes('Switch to Main'));
  assert.equal(getMetric(u, 'weight'), null);                       // not in Main…
  assert.equal(getMetric(getCurrentNotebookId(u), 'weight'), null); // …and not in the notebook either
});

test('“Switch to Main” switches AND re-runs the command there', async () => {
  const u = getOrCreateTelegramUser(88_002, 'nbdiet2');
  setUserFeatures(u, { diet: true, notebook: true });
  await handleMessage({ userId: u, text: 'notebook Cutting' });
  await handleMessage({ userId: u, text: 'weight 183' });           // warned, pending
  const out = await handleMessage({ userId: u, text: 'Switch to Main' });
  assert.match(out.reply, /Switched to Main/);
  assert.match(out.reply, /183/);
  assert.equal(getCurrentNotebookId(u), null);                      // back in Main
  const w = getMetric(u, 'weight');
  assert.ok(w, 'weight metric exists under the MAIN user');
  assert.equal(metricValuesSince(u, w.id, 0).at(-1).value, 183);
});

test('“log here” keeps the entry in the notebook on purpose', async () => {
  const u = getOrCreateTelegramUser(88_003, 'nbdiet3');
  setUserFeatures(u, { diet: true, notebook: true });
  await handleMessage({ userId: u, text: 'notebook Bulk' });
  const nbId = getCurrentNotebookId(u);
  await handleMessage({ userId: u, text: 'weight 190' });
  const out = await handleMessage({ userId: u, text: 'log here' });
  assert.match(out.reply, /190/);
  assert.equal(getCurrentNotebookId(u), nbId, 'still in the notebook');
  assert.ok(getMetric(nbId, 'weight'), 'logged under the notebook sub-user');
  assert.equal(getMetric(u, 'weight'), null, 'Main untouched');
});

test('cancel logs nothing; an unrelated message escapes the guard the same way', async () => {
  const u = getOrCreateTelegramUser(88_004, 'nbdiet4');
  setUserFeatures(u, { diet: true, notebook: true });
  await handleMessage({ userId: u, text: 'notebook Trip' });
  await handleMessage({ userId: u, text: 'eat 4 oz chicken breast' });
  const out = await handleMessage({ userId: u, text: 'cancel' });
  assert.match(out.reply, /nothing logged/i);
  assert.equal(getMetric(getCurrentNotebookId(u), 'calories'), null);
  // Re-arm, then escape with a fresh task statement instead of an answer — still nothing logged.
  await handleMessage({ userId: u, text: 'weight 200' });
  await handleMessage({ userId: u, text: 'buy sunscreen for the trip' });
  assert.equal(getMetric(getCurrentNotebookId(u), 'weight'), null);
  assert.equal(getMetric(u, 'weight'), null);
});

test('read-only diet commands (foods) are not guarded in a notebook', async () => {
  const u = getOrCreateTelegramUser(88_005, 'nbdiet5');
  setUserFeatures(u, { diet: true, notebook: true });
  await handleMessage({ userId: u, text: 'notebook Recipes' });
  const out = await handleMessage({ userId: u, text: 'foods' });
  assert.doesNotMatch(out.reply, /You're in 📓/);
});

test('the guessed-food confirm flow works end-to-end after switching to Main', async () => {
  const u = getOrCreateTelegramUser(88_006, 'nbdiet6');
  setUserFeatures(u, { diet: true, notebook: true });
  await handleMessage({ userId: u, text: 'notebook Health' });
  await handleMessage({ userId: u, text: 'eat 4 oz halibut' });      // warned
  const sw = await handleMessage({ userId: u, text: 'switch' });     // → Main, re-runs eat → guess confirm
  assert.match(sw.reply, /Switched to Main/);
  assert.match(sw.reply, /halibut ≈ 50 cal\/oz/);                    // mock guess
  const done = await handleMessage({ userId: u, text: 'yes' });      // confirm lands in MAIN
  assert.match(done.reply, /Logged/);
  const cal = getMetric(u, 'calories');
  assert.ok(cal);
  assert.equal(metricValuesSince(u, cal.id, 0).at(-1).value, 200);   // 4 oz × 50
});
