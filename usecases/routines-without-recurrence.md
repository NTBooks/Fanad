# Routines without recurring tasks

Fanad has no recurring tasks. That's not a missing feature — it's a refusal. A task that re-adds itself is a machine for manufacturing guilt: skip "water the plants" twice and your list is now nagging you about the past instead of helping with the present. Recurrence is nagging, and nagging is stress.

But real life does repeat. Here's how Fanad handles each kind of repetition, without ever putting a task on your list that you didn't ask for *today*.

## Templates: the routine you invoke on purpose

For anything with a repeatable shape — the sourdough bake, the packing routine, the monthly bills sweep — do it once with steps, then save the shape:

```
you:    /template 3 sourdough
fanad:  🗂 Saved template "sourdough" (4 steps).
```

From then on, whenever *you* decide it's bread day:

```
you:    /template sourdough
fanad:  📋 Fresh copy on your list:
        ✓ Filed: "bake sourdough" · Home · medium (4 steps) —
        say "start" to walk through it.
```

A fresh copy, every box unticked, no deadline or leftovers carried over. The difference from recurrence is exactly one thing, and it's everything: the task appears when you summon it, not when a calendar decides you're behind. `/templates` lists your saved ones; `/template retire <name>` removes one.

## The calendar: where actual recurrence belongs

Some things genuinely happen on a schedule — trash night, the quarterly filter change. Those belong in your *calendar*, which is already good at recurrence and already yours. Any dated task in Fanad offers a `/cal` link:

```
you:    /cal 3
fanad:  📅 Add "renew the passport" to your calendar
        (hands you an .ics file to open — recur it there if you like)
```

Open the .ics, set it to repeat in your own calendar app, on your terms. Fanad stays a clean pad; your calendar does calendar things.

## One-time reminders: pings that fire once

`remind me to take the bins out at 8pm` pings you once at 8 and leaves the task on your list. Ending a capture with `on sunday 6pm` sets a deadline plus one reminder at that moment. Every reminder in Fanad fires exactly once — there is no snooze-spiral.

For even smaller stuff, the Timer module (`optin timer`) gives you a kitchen-grade one-shot ding — `timer 12 min pasta` — that never touches your list at all.

## The daily check-in: one nudge, sized to you

If you want a daily rhythm without a daily task, ask for a check-in:

```
you:    /wake 8:30
fanad:  ⏰ I'll check in at 08:30 (tomorrow).
```

Each morning you get a single gentle nudge — one suggestion from your real list, sized to your mood and history, with `whatdo`'s usual escape hatches (`no`, `smaller`, or just ignore it). It's the difference between a housemate saying "morning — gutters, maybe?" and an app with a red badge counting your failures.

## Journals: routine as data

When the routine *is* the point — meds, morning checks, an experiment you're running on yourself — that's the Journal module's job: a named daily checklist you tick, where a skipped day is data rather than debt. See [the problem-solving journal](problem-solving-journal.md).

## The shape of all of it

Every repetition tool in Fanad has the same property: **the pull comes from you.** Templates wait to be summoned, calendars are yours, reminders fire once, the check-in offers instead of demands. The list only ever contains things you put there — which is why you can trust it enough to keep using it.
