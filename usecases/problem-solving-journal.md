# The problem-solving journal: "is it the dairy?"

Some problems don't announce themselves. The headaches that show up *some* afternoons. Sleep that's fine for a week and then isn't. The dog's limp that comes and goes just often enough that you can't describe it properly at the vet.

You can't think your way to these answers, because the pattern lives across weeks and your memory doesn't. What works is boring: log a little every day, then read it back over time. Fanad's Journal module does the logging with two small moves a day, and does the reading back for you.

## The setup, once

Say the mystery is afternoon headaches, and your hunch is dairy.

**1. Turn it on:** `optin journal`

**2. Build your daily checklist as a template.** File a task, give it steps for whatever you want to correlate later, save it:

```
you:    morning checks
you:    step walk the dog
you:    step no dairy breakfast
you:    step meds
you:    /template 1 morning-checks
fanad:  🗂 Saved template "morning-checks" (3 steps).
```

The "no dairy breakfast" item *is* the experiment. Everything else is context.

**3. Point a journal at it:**

```
you:    journal new food
you:    journal template morning-checks
fanad:  ✓ "food" now uses the "morning-checks" checklist (3 items)
```

The checklist is snapshotted — editing the template later never rewrites your journal.

## The daily habit: two moves

**Open today and tick the boxes:**

```
you:    entry
fanad:  📔 food — 2026-07-09 (fresh entry)
        Checklist 0/3:
        1. ☐ walk the dog
        2. ☐ no dairy breakfast
        3. ☐ meds
you:    check 1 3
```

**Then let the note carry the story.** This is where trends hide — jot symptoms, food, mood, anything:

```
you:    j note had dairy at lunch, headache by 3pm
fanad:  📝 Added to today's "food" note.
```

That's it. Under a minute. An unticked box is data, not guilt, and a skipped day is data too — Fanad never scolds you for gaps.

Each night, Fanad quietly summarizes the finished day, and weeks and months are built from those summaries. That's why the journal stays fast no matter how long it runs — month-old detail is never re-read raw.

## Reading it back

After a few days:

```
you:    journal week
fanad:  📅 food · 2026-W28
        You kept 5 of 7 days. Adherence held around 80% — dairy turned
        up in three notes, headaches in two, both in the back half of
        the week.
```

And once it's been running a while, the long look:

```
you:    journal trends
fanad:  🧭 food — trends
        One pattern might be worth watching: headaches turned up on 4
        of the 5 days that followed dairy. Tentative — the data is
        still thin.

        🩺 These are patterns in what you logged, not medical advice —
        a real conversation with a doctor (or vet) is the next step if
        one worries you.
```

Notice what it's doing: naming its evidence, staying tentative on thin data, and reminding you it isn't a doctor. Fanad only ever describes what you actually logged — it never invents a day, and that disclaimer is part of every trends reply on purpose.

## Then act like a scientist, not a patient

A pattern is a hypothesis, not a verdict. Tighten the checklist ("no dairy after noon"), keep logging, see if the pattern holds. And when you do take it to a doctor, you're walking in with *dated evidence* — "headaches on 4 of the 5 days after dairy, over three weeks" — instead of "I get headaches sometimes."

## Swap in your own mystery

The shape is identical for anything slow:

- **Sleep:** checklist of caffeine-after-noon, screens in bed, exercise; note how you slept.
- **A new medication:** checklist for taking it; note side effects and mood.
- **The dog:** `journal new pepper`, checklist of walks and food; note the limp when it shows. Journals are named so you can keep several — one for you, one for the dog — and `journal use <name>` picks the default.

When an experiment is over, `journal delete` erases a journal and everything in it. It asks you to confirm first — only an explicit "delete" deletes.
