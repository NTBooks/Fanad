# Reminders and deadlines: dates that help without hounding

Most apps treat a date as a tripwire — miss it and the task turns red, piles up, follows you around. Fanad treats a date as *information*: it lifts a task's ranking as the day approaches, pings you at most once, and then gets out of the way.

There are only three ways to put time on a task, and you say all of them in plain words at the moment of capture.

## `by` — a deadline

End a task with `by <when>` and it gets a due date:

```
you:    renew the passport by friday
fanad:  ✓ Filed: "renew the passport" · Admin · medium · ⏳ due friday
```

What a deadline does: it gently lifts the task in rankings and suggestions as friday approaches — `whatdo` gets more likely to offer it. What it doesn't do: ping you, turn red, or scold. Once the date passes, it quietly retires rather than haunting the list as "overdue."

## `on` — a deadline plus one ping

`on <when>` sets the due date *and* a one-time reminder at that exact moment:

```
you:    call mom on sunday 6pm
fanad:  ✓ Filed: "call mom" · Social · trivial · 🔔 sunday 6pm
```

Sunday at 6, you get one message. That's the whole contract. Use `on` for things with a real appointment-shaped moment; use `by` for things that just need to happen before one.

## `remind me` — a ping without ceremony

The most natural version needs no syntax at all:

```
you:    remind me to take the bins out at 8pm
fanad:  ✓ Filed: "take the bins out" · Home · trivial · 🔔 8pm

        …then, at 8:00 pm:
        🔔 Reminder: "take the bins out" — it's time.
```

It pings once and leaves the task on your list until you `done` it. There is no snooze, no re-ping, no escalation — Fanad's position is that a reminder is a courtesy, and a second reminder is a nag.

## Today: the short fence

For the "this must not survive the day" category:

- `x call the pharmacy` — the shortcut files a task due by the end of today
- `tasks today` — just what's due today
- `whatdo today` — the one-thing suggestion, scoped to today's dues

A nice detail: the day ends at **2:00 am**, not midnight. Finishing something at 12:30 still counts as tonight, because that's how evenings actually work.

## `/cal` — hand the date to your real calendar

Any dated task shows a 📅 link. `cal 3` hands you an .ics file that drops the task onto your own calendar — Google, Apple, Outlook, whatever you already live in:

```
you:    /cal 3
fanad:  📅 Add "renew the passport" to your calendar
        (hands you an .ics file to open — recur it there if you like)
```

This is also the official answer for anything recurring: Fanad will never re-add a task on a schedule, but your calendar is *built* for repeats — set it to recur there, on your terms. (More on that philosophy in [routines without recurrence](routines-without-recurrence.md).)

## `/wake` — the standing exception

One kind of scheduled ping exists, because it's an invitation rather than a demand: `wake 8:30` sets a daily check-in where Fanad offers a single suggestion each morning. `wakelist` shows your check-ins; `wake off 1` removes one. You can ignore it forever without consequence — it never accumulates.

## Which one, when

| You're thinking | Say |
|---|---|
| "…sometime before friday" | `…by friday` |
| "…at that specific moment" | `…on sunday 6pm` |
| "just ping me tonight" | `remind me to … at 8pm` |
| "today, no matter what" | `x …` |
| "every first of the month" | `cal N` → recur it in your calendar |
| "nudge me each morning" | `wake 8:30` |

The through-line: every date in Fanad results in **at most one ping, ever**. If you're used to apps that badger, the silence feels strange for about a week — and then it's the reason you still trust the list.
