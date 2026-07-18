# Timers: the ding that never touches your list

Some things need a ding, not a task. The pasta, the laundry, the parking meter, the "give the paint an hour." Putting these on a task list is absurd — they're not commitments, they're eggs boiling. But you still reach for *something*, and if Fanad is already the chat window you're standing in, it might as well hold the timer.

That's the whole module: a one-shot kitchen timer that lives in chat and leaves your list alone.

## Turn it on, set one

```
you:    optin timer
you:    timer 12 min pasta
fanad:  ⏰ Timer set — 12 min — pasta · rings 6:42 pm.
        ("timer" shows it · "timer off" cancels)

        …12 minutes later:
        ⏰ Ding — 12 min is up: pasta.
```

Say the duration however it comes out of your mouth — `timer 12 min pasta`, `timer 1h laundry`, `timer 90 seconds`. The label is optional but future-you appreciates knowing *which* ding this is when two are running.

## Managing them

- `timer` — bare, lists what's running and when each rings
- `timer off 1` — cancels one (the set-confirmation also carries a ✕ Cancel button, so mis-sets die in one tap)

And that's the entire command surface. It rings once, then it's gone.

## What makes it different from a reminder

It's worth being precise, because Fanad has both:

| | Timer | Reminder |
|---|---|---|
| Counts | a duration ("12 min from now") | a clock time ("at 8pm") |
| Lands on your list | never | yes — the task stays until you `done` it |
| After it fires | gone | the task remains |
| Good for | pasta, laundry, meters, breaks | bins, calls, meds, errands |

The rule of thumb: if you'd feel silly seeing it on tomorrow's list, it's a timer. "Take the bins out" is a reminder — if you miss the ping, the task is still there tomorrow. "Pasta" is a timer — if you miss the ding, no list can save the pasta.

## Timers as a focus trick

The sleeper use case has nothing to do with kitchens. A timer is the cheapest possible commitment device:

```
you:    timer 20 min just start the gutters
```

Twenty minutes is small enough to start when the whole task feels impossible — and starting is usually the entire problem. Pair it with a started task and its steps, and the ding becomes permission to stop, which paradoxically makes starting easy. (If you're doing this daily, [the journal](problem-solving-journal.md) can tell you whether it's actually working.)

Same trick, other direction: `timer 30 min phone break`, `timer 1h then decide`. A ding is a boundary you set for yourself, delivered by something that won't judge you either way when it arrives.
