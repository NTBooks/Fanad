# Tracking what you eat, without the database homework

Most calorie apps make you search a database, pick the closest match from forty near-identical entries, and adjust a slider. Fanad's Diet module works the way people actually eat: you have maybe twenty foods and five meals you rotate through, so it learns *your* foods once and then logging takes three words.

## Turn it on

Diet is its own module, off by default:

```
you:    optin diet
```

## The first time you eat something

Weigh it (kitchen scale, oz or grams) and say so. For a food Fanad has never seen, it makes one guess at the calorie density — and you confirm or correct it **once, ever**:

```
you:    eat 4 oz chicken breast
fanad:  chicken breast ≈ 45 cal/oz (my guess) — 4 oz ≈ 180 cal.
        Reply "yes" to save & log, send the right cal/oz (a bare
        number), or "no" to skip.
you:    yes
fanad:  ✓ chicken breast saved at 45 cal/oz — I'll reuse it from now on.
        Logged 4 oz chicken breast: 180 cal.
        • calories: 180 / 2000 kcal
```

After that, it's canonical and never re-guessed:

```
you:    eat 6 oz chicken breast
fanad:  Logged 6 oz chicken breast: 270 cal.
        • calories: 450 / 2000 kcal
```

If you already know the number, your count always wins — no guess, no question. `eat olives 80 cal` saves olives at 80 calories a serving, and from then on a bare `eat olives` logs one serving. Foods that come in pieces just count: `eat 2 eggs`.

One calories number, no macros. That's deliberate — the goal is a total you'll actually keep, not a spreadsheet you'll abandon in March.

## Meals: the same breakfast every day

If you eat the same thing most mornings, save it once:

```
you:    save meal breakfast 2 eggs, skyr, toast 450 cal
fanad:  ✓ breakfast saved at 450 cal/serving (2 eggs, skyr, toast).
        "eat breakfast" logs it.
```

Leave the total off and Fanad prices the meal from your saved foods, guessing only the unknowns, behind a single yes/number/no question. Either way, tomorrow morning the entire transaction is:

```
you:    eat breakfast
fanad:  Logged breakfast: 450 cal.
```

## Recipes: the pot of chili problem

Home cooking is where calorie tracking usually dies, because a "serving" of something you made is meaningless. Fanad does it the honest way — total calories in, divided by cooked weight out:

```
you:    recipe chili = 16 oz chicken breast, 8 oz olives @ 28 oz cooked
fanad:  🍲 chili:
          • chicken breast — 16 oz @ 45 cal/oz = 720 cal
          • olives — 8 oz @ 47 cal/oz = 376 cal
        = 1096 cal ÷ 28 oz cooked = 39.1 cal/oz. Log it with: eat 8 oz chili
```

(Weigh the whole pot, subtract the pot.) There's also a conversational version — `recipe new chili` walks you through it a line at a time. Once built, a recipe logs like any other food: scoop out a portion, weigh it, `eat 8 oz chili`.

## The daily picture

- `target 1800` sets the calorie goal every tally is measured against.
- `weight 182` logs today's body weight.
- `tally` shows where the day stands.
- `undo` removes the last logged portion — no fixing typos by hand.
- `foods` lists your library; `food set` and `food del` correct or remove an entry.

Two details that keep the numbers honest: the day rolls over at **2:00 am**, not midnight, so a 1 am snack still counts against the evening it belongs to. And days follow *your* timezone — if Fanad runs on a hosted box, set your weather location in Settings so the server's clock matches yours.

The web app adds a Diet report view: daily totals, a weight chart over time, and inline edit/delete on the food log for anything you got wrong.

## Why it stays easy

The whole system converges. Every food you confirm makes the next log shorter, until a normal day is four messages: `eat breakfast`, `eat lunch`, `eat 8 oz chili`, `weight 182`. That's the entire overhead — which is about what a habit can actually afford.
