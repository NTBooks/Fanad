# Planning a party: one task, many steps, and a running start

"Plan Dad's birthday party" is a terrible task. It's really fifteen tasks wearing a trench coat, which is exactly why it sits on a list for three weeks radiating dread. Fanad's answer is steps: keep the one task, break it down underneath, and walk through it one checkbox at a time.

And for the classic blank-page problem — *what are the steps to plan a party, even?* — Fanad will draft the checklist for you.

## Capture it like anything else

```
you:    plan dad's birthday party by aug 2
fanad:  ✓ Filed: "plan dad's birthday party" · Social · high · ⏳ due aug 2
```

The `by aug 2` sets a due date that lifts the task's ranking as the day nears. (Use `on aug 2 10am` instead if you also want a one-time reminder, and `/cal N` any time to get an .ics file that drops it on your real calendar.)

## Ask for a draft of the steps

Start the task, then ask Fanad to guess:

```
you:    start
fanad:  ▶ Started: "plan dad's birthday party".
you:    guess
fanad:  💡 A guess at the steps for "plan dad's birthday party"
        (my own best guess, not from your notes — edit freely):
        ☐ 1. pick a date and guest list
        ☐ 2. book or prep the venue
        ☐ 3. send invitations
        ☐ 4. plan food and cake
        ☐ 5. sort decorations and music
        Tick off with "done" / "done 2" / "done all" · add "step …" ·
        remove "unstep 2".
```

Worth knowing what just happened: everywhere else, Fanad *never* invents — it only shows you things you actually wrote. `guess` is the single sanctioned exception, and it's always labeled as a guess: a disposable first draft from general know-how, never presented as fact. It exists precisely for this moment, when the blank page is the obstacle.

## Make the checklist yours

The draft is fully editable. Toss what doesn't fit, add what it couldn't know:

```
you:    unstep 2
fanad:  🗑 Removed step 2.
you:    step order the ice cream cake from Coldstone
you:    step ask Maria to bring the speaker
```

`step <text>` adds under the task you last touched (or `step N <text>` targets task N from a listing). The single letter `s` works too.

## Walk it, don't stare at it

A started, stepped task shows its checklist, and you tick things off as life allows:

```
you:    done
fanad:  ☑ 1. pick a date and guest list
        ☐ 2. send invitations
        ☐ 3. plan food and cake
        ...
```

- `done` ticks the next unticked step
- `done 2 4` ticks specific ones
- `done all` finishes the whole task
- `stop` pauses the session — steps stay saved, and the task keeps its place until you `start` it again next weekend

Between sessions, `whatdo` knows about your started task and will nudge you toward the next step rather than dumping the whole project on you. That's the point of the structure: you never face "plan the party," only "send invitations."

## Reuse the plan next year

If it went well, keep the shape:

```
you:    /template 1 birthday-party
fanad:  🗂 Saved template "birthday-party" (6 steps).
```

Next year, `/template birthday-party` drops a fresh copy on your list, every box unticked, no dates or leftovers attached. This is Fanad's whole alternative to recurring tasks — nothing nags you on a schedule, but a proven checklist is one command away when *you* decide it's time.

## The same shape, elsewhere

Anything big and vague works this way: moving apartments, a garage sale, tax season, hosting Thanksgiving. Capture the trench coat, `start`, `guess` a draft, edit it into your reality, and walk it one box at a time.
