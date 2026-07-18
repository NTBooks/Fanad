# Getting it out of your head: the brain dump

This is the use case Fanad was built for, and the one every other article here sits on top of. If you read only one, read this one.

## The problem

Your head is holding too much. The gutters, the passport renewal, the thing you promised your sister, the weird noise the dryer makes. None of it is written down anywhere, so all of it takes turns waking you up at 2 am.

Most task apps make this worse: now you have to *file* everything. Pick a project, pick a tag, pick a due date, feel bad when the list grows.

Fanad's deal is simpler: **you unload, it organizes.**

## How it works

There are only three rules, and they're the whole grammar:

1. Make a statement, and it becomes a task on your list.
2. Ask a question, and it runs a command.
3. Answer Fanad's own question, and that's taken as your answer.

So a brain dump looks like this — no commands, no ceremony:

```
you:    the gutters need clearing
fanad:  ✓ Filed: "the gutters need clearing" · Home · medium

you:    renew the passport by friday
fanad:  ✓ Filed: "renew the passport" · Admin · medium · ⏳ due friday

you:    call mom on sunday 6pm
fanad:  ✓ Filed: "call mom" · Social · trivial · 🔔 sunday 6pm
```

Just wander — through your house, your day, your head — and say each thing as it surfaces. Fanad keeps your own words as the title and quietly picks a category and effort. You never tag, sort, or tidy anything by hand. A photo works too: snap the broken fence gate, caption it "fix the fence gate", and it's filed with the picture attached.

Ending a task with `by friday` sets a due date; `on sunday 6pm` sets a deadline *and* a one-time reminder. `x call the pharmacy` files something due today.

## Then: ask for one thing, not a wall

Here's the part that matters. When you're ready to do something, don't open the list. Ask:

```
you:    whatdo
fanad:  💡 How about "clear the gutters"? — you usually finish home
        things by afternoon
        ("yes" to start · "done" if it's finished · "no" · "smaller")
```

One suggestion, sized to your time, energy, and mood, with an honest reason. And "no" is never the end — say `no` or `smaller` and Fanad offers something lighter, or nothing at all. After a few passes it will gently offer to reword the task or break it down, rather than push.

Tell it how you're doing anytime — `mood 😴` or `mood overwhelmed` — and suggestions shrink to match for the next few hours.

## The list, when you want it

`tasks` shows everything open, grouped by category (or counts to drill into, when there's a lot). Every listing is numbered 1..N from the top, so `done 3` always means the third row you just saw:

```
you:    done 1 2
fanad:  ✓ Done: "call the pharmacy", "water the plants".
```

`drop 4` clears something that isn't yours anymore. No guilt, it's just archived.

## The safety net: nothing rots

The reason a brain dump usually fails is that the list becomes a guilt archive. Fanad refuses to let that happen: anything untouched for about three weeks quietly **goes to sleep** — out of your listings and out of your suggestions. Nothing is deleted. `sleeping` shows what drifted off; `revive 1` brings it back the moment it's yours again.

## Worth knowing

- The leading slash is always optional. `/whatdo` and `whatdo` are the same.
- Single letters work as shortcuts: `w` is whatdo, `d` is done, `t` is task, `x` is due-today.
- `me` shows what Fanad has learned about you — completion rate, favored categories, usual mood. `summary today` gives a narrative recap.
- Fanad never invents tasks. Suggestions come only from things you actually wrote down.

That's the loop: unload everything, ask for one thing, let the rest sleep. Everything else in Fanad is optional.
