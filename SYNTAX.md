# Fanad input syntax

This is the **internal contract** for how Fanad reads a message — not the onboarding story.
The product thesis is "just talk, I'll sort"; this document exists for power users, for
maintainers, and as the seam that future persona packs will swap a lexicon against.

## The one organizing rule

> **Ask a question → run a command. Make a statement → file a task, _or_ answer Fanad's open question.**

Everything below is the precise machinery behind that sentence.

## What is and isn't formalizable

Fanad's input handling is **three layers**, and only one of them is a grammar:

1. **A deterministic command sublanguage** (slash/keyword commands + an inline capture
   mini-language). This _is_ a grammar — written below.
2. **A dialog state machine** (answering Fanad's open question). A statechart, not a grammar.
3. **A free-text capture fallback** (everything else → the LLM, or a verbatim task). Deliberately
   _not_ grammar-shaped — that's the whole point of the app.

> Because layer 3 files a whole paragraph as one verbatim task, newcomers who treat Fanad like a
> chatbot are surprised on message #1. The web client counters this with a first-run **reaction demo**
> (`web/src/ReactionDemo.jsx`, reel copy in `shared/copy.js` → `REACTION_DEMO`) that animates the
> statement→task / question→command split; it changes no syntax.

A subtlety that rules out plain **BNF**: disambiguation in Fanad lives in **order** and in
**runtime/database state**, not in the syntax. `route()` is an ordered cascade (first match wins),
and several productions only fire if a predicate holds (a template exists, a word names a real
category, a date actually parses). That's a **PEG (parsing-expression grammar) with semantic
predicates**, sitting on top of an ordered dispatch pipeline, beside a dialog FSM. So this spec
uses PEG notation, not BNF.

### Notation

```
rule ← body            a production
A / B                  ORDERED choice — try A first, then B (this is why it's PEG, not BNF)
x?  x*  x+             optional · zero-or-more · one-or-more
( … )                  grouping
"lit"                  a literal, case-insensitive unless noted
[abc]                  character class
UPPER                  a lexical token: SP (spaces), INT, EOL, TEXT (free text to end), WORD
{pred: …}              a SEMANTIC PREDICATE — the production matches only if this runtime/DB
                       check holds. BNF cannot express these; they are the crux of Fanad's parser.
# …                    a comment
```

Source of truth for every lexicon (category words, effort words, priority words, guide aliases)
is the code, not this file — see the [Lexicon](#lexicon) section for the exact modules.

---

## Layer 0 — resolution order (the dispatch pipeline)

Mirror of `server/chat.js` → `route()`. Each step is tried in order; the **first** one that
produces a reply wins. `recordSnapshot` (mood + time-of-day capture) runs for _every_ message
before any of this, so energy/status stay fresh even for messages that never become a task.

```
message ←
   0. action_token            # an interactive button was tapped → handleAction(a:*/m:*); bypasses all below
   1. ""                       {pred: empty text AND no image}
   2. capture_note             {pred: a photo with NO caption}        # parks in the notes inbox
   3. shortcut_expand          # leading single letter → canonical slash command (then re-enter below)
   4. menu_pop                 # "c" | "/c" | "/menu"    # tappable command menu; clears any open dialog
   5. dialog_answer            {pred: a dialog is open AND answersPendingState(text) == 'answer'}
   6. command                  # the deterministic command layer (Layer 1) — never hits the LLM
   7. unknown_slash            {pred: text starts with "/" and matched nothing, except "/note …"}
   8. greeting                 # hi / hello / good morning → the welcome
   9. emoji_mood               {pred: emoji-only message} → set mood
  10. filler_ack               {pred: bare yes/no/ok/thanks AND nothing pending} → gentle ack
  11. nl_dispatch              # classifyIntent: question (conf ≥ 0.5) → a command; else → capture
```

`shortcut_expand` (step 3) rewrites the text to the canonical slash form and lets the rest of the
pipeline handle it unchanged, so a shortcut escapes an open question exactly like the full command:

```
shortcut_expand ← [ntdsrgx] SP TEXT     # n→/note t→/task d→/done s→/step r→/recall g→/guide x→/today
                / "w" / "u"              # bare w → /whatdo · bare u → /undo  (bare "n" stays "no")
```

`nl_dispatch` (step 11) is the free-text layer — **not** formalized here. A question maps to a
command intent (`whatdo`, `summary`, `tasks`, `notes`, `recall`, `mood_set`, `done`,
`start`); anything else is captured verbatim as a task (or a note, via the `note` verb).

---

## Layer 1 — the command grammar

**The leading `/` is an optional prefix that never changes _what_ a command does.** Its only jobs
are to escape an open question (step 5) and to aid discovery. So `/sleeping` ≡ `sleeping`,
`/done 3` ≡ `done 3`. Some commands accept _only_ the slash form (noted), because the bare word is
too common in ordinary speech to hijack (`/today`, `/cal`, `/pic`, `/summary`, `/recall`, …).

```
command ← capture / list / lists_cmd / act / schedule / organize / suggest / guide / metrics / admin

# ── capturing ──────────────────────────────────────────────────────────────
capture     ← note_cmd / task_cmd / today_cmd / step_cmd
note_cmd    ← "/"? "note" [ :]+ TEXT                       # → notes inbox (NOT the task list)
task_cmd    ← "/task" (":" WORD)? SP body                  # WORD = a category, fuzzy-matched
today_cmd   ← "/today" SP body                             # slash REQUIRED; pins due = end of today
step_cmd    ← "/"? ("step"/"substep"/"subtask") [ :]* (INT SP)? TEXT
                                                           # INT ⇒ step under listed task #INT; else the in-progress task, else newest open task

# ── listing & paging ───────────────────────────────────────────────────────
list        ← "/"? "tasks" (SP task_filter)?               # bare ⇒ grouped or counts-overview
            / "/notes"
            / "/"? ("sleeping"/"stale"/"dormant")
            / "/"? "snoozed"                                # manually-snoozed tasks, with when each wakes
            / page_move
task_filter ← "all" / "today" / effort_word / category_word
page_move   ← "/"? ("next"/"more"/"prev"/"back"/"previous")   {pred: a paged listing is open}

# ── lists: a nestable outliner, separate from tasks/notes (its own tree) ─────
lists_cmd   ← "/"? "lists"                                  # open the lists hub (the top-level lists)
            / "/list"                                       # bare ⇒ same as /lists
            / "/list" SP TEXT                               # create a list (top-level, or an item in the open one)
            / "/"? "sub" [ _]* "#"? INT (SP TEXT)?          # /sub_N: descend into item N · with TEXT: quick-add a child
            # While a list is OPEN (the list_nav dialog, Layer 3) these bare words also act, and any other line
            # becomes a new item: out · up · top · home · next · prev · "del N" · "rename N <text>" · exit

# ── acting on listed items (N = position on the LAST listing, never a DB id) ─
act         ← done_cmd / drop_cmd / revive_cmd / unsnooze_cmd / unstart_cmd / promote_cmd / forget_cmd
            / pic_cmd / cal_cmd / finish_word / guess_cmd / unstep_cmd / undo_cmd
undo_cmd    ← "/"? "undo"                                  # app-wide: pop the undo stack — takes back the last
                                                           #   undoable thing (a capture, done/drop/snooze/start,
                                                           #   an eat/track/weight log, a timer, a list item).
                                                           #   Escapes any open question; empty stack ⇒ "can't undo".
done_cmd    ← "/"? ("done"/"finish"/"start") SP (positions / TEXT)
                                                           # positions ⇒ act on them; TEXT ⇒ match by name, else FILE as a new task
positions   ← "#"? INT ( [ ,]+ "#"? INT )*                 # "3" · "1 2 3" · "1,2,3" · "#1, #2"
drop_cmd    ← "/drop" SP positions
revive_cmd  ← "/"? "revive" SP positions   /   "/"? "revive"   # bare ⇒ show the sleeping list
unsnooze_cmd← "/"? "unsnooze" SP positions /   "/"? "unsnooze" # bare ⇒ show the snoozed list
unstart_cmd ← "/"? "unstart" (SP positions)?                   # bare ⇒ un-start the in-progress task (back to not-started, not done)
promote_cmd ← "/promote" SP "#"? INT                       # note N → a task
forget_cmd  ← "/"? ("forget"/"delete") SP ("note" "s"? SP)? positions   # bare form only when the positions resolve on the note listing
pic_cmd     ← "/"? ("pic"/"photo"/"image"/"img") [ _]* "#"? INT
cal_cmd     ← "/"? ("cal"/"calendar"/"ical"/"ics") [ _]* "#"? INT
finish_word ← ("done"/"finished"/"stop"/"end"/"all done"/"wrap up"/…) EOL
                                                           # bare finish word, no id ⇒ close the most-recently-started task
guess_cmd   ← "/"? "guess" (SP "steps")?                   # LLM-break the most-recently-started task into a step checklist
            / ("break it down"/"break into steps")  {pred: a task is in progress}   # looser phrasings, gated so they don't eat tasks
unstep_cmd  ← "/"? ("unstep"/"delstep") SP (positions / "all")     # remove step(s) from the task you're working on
            / "/"? ("remove"/"delete"/"drop"/"del"/"rm") SP "step" "s"? SP (positions / "all")   # verb needs "step" (else it's /drop, /forget, or a task)

# ── scheduling & reminders ─────────────────────────────────────────────────
schedule    ← wake_cmd / template_cmd
wake_cmd    ← "/"? ("wake"/"wakes") SP clock               # a daily check-in
            / "/"? ("wake"/"wakes") SP ("off"/"delete"/"remove"/"stop") SP "#"? INT
            / "/"? ("wakelist" / ("wake" SP "list"))
template_cmd← "/"? "templates"                             # list saved templates
            / "/"? "template" SP ("retire"/"delete"/"remove"/"forget") SP name  {pred: slash | template `name` exists}
            / "/"? "template" SP "#"? INT (SP name)?                              {pred: slash | position INT resolves}   # SAVE listed task
            / "/"? "template" SP name                                             {pred: slash | template `name` exists}  # LOAD a fresh copy

# ── organizing ─────────────────────────────────────────────────────────────
organize    ← lock_cmd / mood_cmd / remcat_cmd
lock_cmd    ← "/unlock"                                                # clear the lock
            / "/lock" (SP lock_target)?                                # slash form: always
            / "lock" SP lock_target            {pred: lock_target names a real category/effort}
            / "/lock" SP WORD                  {pred: WORD is a new one-word name} → MINT that category + lock to it
lock_target ← (category_word / effort_word)+
mood_cmd    ← "/mood" [ :]* TEXT
            / "mood" SP TEXT                   {pred: TEXT carries an emoji or a mood word}   # else "mood lighting" stays a task
remcat_cmd  ← "/remcat" (SP category_word (SP category_word)?)?       # HIDDEN maintenance; absent from /help & menus

# ── suggestion loop & summaries ────────────────────────────────────────────
suggest     ← "/"? "whatdo" (SP "today")?
            / suggest_request                  # "what's next?", "any ideas?", "i'm bored", … (shared/intent.js)
            / "/recall" SP TEXT
            / ("/summary" (SP timeframe)?)
timeframe   ← "today" / "this week" / "last week" / WORD

# ── guides & help ──────────────────────────────────────────────────────────
guide       ← "/"? "guide" SP topic                # ⇒ one topic panel + a "‹ All topics" footer
            / topic SP "guide"                 {pred: `topic` is a real guide}    # "travel guide" still files as a task
            / ("/help" / "/guide" / "guide")   # bare ⇒ the tappable topic HUB (guideMenu), not a wall
            / help_phrase                       # "help", "what can you do", "how does this work" (whole-message) ⇒ the HUB
            / ("/commands" / "commands")        # the full text command list (drift-guard target)
            / ("/rules" / "rules") / ("/howto" / "howto" / "how")
            / ("/me" / "/dossier")
            # NB: the bare/exact guide·help·rules·howto forms also ESCAPE an open dialog (isGuideCommand,
            #     shared/copy.js), so a pending question can't swallow them — task-shaped phrases don't.
topic       ← WORD     {pred: resolves via GUIDE_ALIASES → a live (non-gated) topic}

# ── metrics module (only routes to its handler when enabled in Settings) ────
metrics     ← ("/metrics" / "metrics")
            / "/"? "tally" (SP TEXT)?
            / "/"? "metric" SP "add" SP WORD (SP unit)? (SP rollup)?
            / "/"? "measure" SP WORD SP number (SP TEXT)?
            / "/"? "track" SP WORD SP number (SP TEXT)?
            / "/"? "chart" SP WORD (SP range)?
                                                             # NB: "undo" is app-wide now (undo_cmd) — a tracked
                                                             #   entry is popped off the same stack as everything else
rollup      ← "sum" / "avg" / "last" / "max" / "min"        # default: sum
range       ← INT ("d"/"w"/"m")                              # e.g. 30d

# ── diet module (its own opt-in; separate from metrics, logs into the calories metric) ────
diet        ← "/"? ("eat"/"ate") SP (qty unit? SP ("of" SP)?)? TEXT   # known food/recipe → weight × cal/oz;
            #   unknown → ONE LLM cal/oz guess, confirmed → saved as a canonical food (never re-guessed).
            #   a COMMA/semicolon list ("8oz chicken, half a pepper, 5 mushrooms") is an ad-hoc plate:
            #   each amount binds to its own item, priced like save-meal, logged as ONE one-off entry
            #   (not saved). A stated total for the whole line ("chicken, rice, 600 cal") stays one entry.
            / ("/foods" / "foods")                           # the canonical food list, numbered 1..N
            / "/"? "food" SP "add" SP TEXT SP number unit_tail?   # LAST number = calories ("7up 12" parses)
            / "/"? "food" SP "set" SP ref SP number          # correct a density (ref = listing № or name)
            / "/"? "food" SP ("del"/"delete"/"rm"/"remove") SP ref
            / "/"? "food" SP "show" SP TEXT
            / ("/recipes" / "recipes")
            / "/"? "recipe" SP "new" SP TEXT                 # conversational builder (recipe_build dialog)
            / "/"? "recipe" SP TEXT "=" items ("@" number "oz"? "cooked"?)?   # one-liner; known foods only
            / "/"? "recipe" SP "show" SP TEXT
            / "/"? "recipe" SP ("del"/"delete"/"rm"/"remove") SP TEXT
            / "/"? "weight" SP number                        # point metric for the report's graph
            / "/"? ("calorie(s)" SP)? "target" SP INT        # the daily kcal goal ("target 1800")
                                                             # NB: "undo" is app-wide now (undo_cmd) — the last
                                                             #   portion is popped off the same stack as everything else
qty         ← number / "a" / "an" / "one".."ten" / "half a"  # "eat a chicken breast" asks for the weight
unit        ← "oz"/"ounce(s)"/"g"/"gram(s)"/"lb(s)"/"pound(s)"
unit_tail   ← "/" ("oz"/"g"/"piece"/"each")                  # food add default: per-oz
# NB: a FOOD shadows a RECIPE of the same name in eat's lookup (foods → recipes → guess).

# ── medication module (its own opt-in, ships dark; logger not advisor — never calls the LLM) ────
medication  ← "/"? "med"("s")? SP "add" SP TEXT (SP dose)?     # define/update a med + its kind='med' metric
            / "/"? "med"("s")? SP ("list"/"catalog")           # the med catalog, taken-today marked
            / "/"? "med"("s")? SP "chart" SP TEXT (SP range)?  # per-med adherence chart (works w/o Metrics)
            / "/"? "med"("s")? SP ("del"/"delete"/"rm"/"remove") SP TEXT
            / "/"? "med"("s")? SP "template" SP TEXT "=" med_list   # define a template → med_reminder dialog
            / "/"? "med"("s")? SP "template" SP TEXT SP "remind"("er")? SP (clock / "off")   # set/clear reminder
            / "/"? "med"("s")? SP "template" SP ("del"/"delete"/"rm"/"remove") SP TEXT
            / "/"? "med"("s")? SP "template"("s")?              # list templates
            / "/"? "med"("s")? SP "template" SP TEXT            # show one template
            / "/"? "med"("s")? SP "all"                         # log every scheduled med not yet taken today
            / ("/meds" / "meds")                               # today's adherence view (☑/☐ by template)
            / "/"? "med"("s")? SP TEXT                          # log: a template name → whole template; else a
                                                               #   single med (auto-created on first use)
                                                               # NB: "undo" is app-wide — the last dose pops off
                                                               #   the same stack. There is no "med undo".
dose        ← TEXT                                              # freeform "5mg" / "1 tablet" — NEVER LLM-guessed
med_list    ← TEXT ("," / ";" TEXT)*                            # comma/semicolon-separated med names
clock       ← INT (":" INT)? ("am"/"pm"/"a"/"p")?              # "8", "8am", "8:30", "20:00" → minute_of_day
# NB: "taken today" is derived from the med's metric_values within the 02:00-rollover day, not a stored flag.
#   The daily reminder dedups on LOCAL-MIDNIGHT (schedules convention) so "8am" means 8am.

# ── speed dial (OWNER-authored access-control config; a guest's ONLY line to the house) ──────────
# The owner programs another Telegram account's numbers 0-9, each a free-text HA command (run through the
# same converse() as "ha <command>", against the one HA connection). A pad-holder fires a bare 1-9 or taps;
# a bare "0" is the reserved "show my pad" key (slot 0 fires only via tap or "dial 0"). On first contact,
# a FULL-account pad-holder's pad rides ALONGSIDE their normal first reply (welcomed_at, once — handleMessage
# appends it, so their message still files/answers); a LIMITED account can do NOTHING else (short-circuited in
# route()/handleAction) and so already sees its pad on every message. Owner-only authoring; the guest only ever
# sends a digit, so their input is never free text to HA or an LLM.
speeddial   ← "/"? ("sd"/"speeddial")                                       # the owner board (all pads)
            / "/"? ("sd"/"speeddial") SP "@"? HANDLE                        # show one account's pad
            / "/"? ("sd"/"speeddial") SP "@"? HANDLE SP DIGIT "=" (label "|")? TEXT  # set a slot (0-9)
            / "/"? ("sd"/"speeddial") SP "@"? HANDLE SP DIGIT SP "clear"    # clear one slot
            / "/"? ("sd"/"speeddial") SP "@"? HANDLE SP ("clear"/"remove"/"delete")  # clear / drop the pad
            / "/"? ("sd"/"speeddial") SP "@"? HANDLE SP "limit" SP ("on"/"off")       # lock to speed dial only
            / "/"? ("sd"/"speeddial") SP "@"? HANDLE SP "test" SP DIGIT     # owner fires a slot (verify)
pad_use     ← "0"                                                            # pad-holder: show my pad (reserved "menu" key)
            / [1-9]                                                          # fire slot 1-9 (bare digit)
            / "/"? "dial" SP? "#"? DIGIT                                     # fire slot N incl. 0 (unambiguous form)
            / "/"? ("pad"/"dial")                                           # show my pad
DIGIT       ← [0-9]                                                          # a speed-dial slot
label       ← TEXT                                                          # optional slot label before "|"

# ── start ──────────────────────────────────────────────────────────────────
admin       ← "/start"                          # Telegram's Start button: onboarding (new user) | command list (returning)
            # ("/start 3" is NOT this — it matches done_cmd above and starts task 3)
```

---

## Layer 2 — the inline capture mini-language

When a `body` is captured (via `task_cmd`, `today_cmd`, `note→promote`, or plain `nl_dispatch`),
three kinds of metadata are stripped out of the wording and stored as structured fields. Cues are
removed from the summary; the verbatim text is always preserved as `original_text`
("trap more, not less"). Extraction order is **priority → `on <when>` → `by <when>`**
(`server/ingest.js` → `parseTaskMeta`, then `composeTaskFields`).

```
body        ← phrase (priority / on_when / by_deadline)*

# ── manual priority (P1 = highest) — server: shared/priority.js ─────────────
priority    ← prio_word "-"? "priority"                     # "high priority", "low-priority"
            / "priority" [ :=]* (prio_word / [1-9])         # "priority 1", "priority: high"
            / "p" [1-3]                                     # "p1" = high, "p2" = med, "p3" = low
            / ("urgent" / "asap")                           # strong enough alone
prio_word   ← "highest"/"high"/"top"/"urgent"/"critical"/"asap"/"medium"/"med"/"moderate"/"normal"/"lowest"/"low"/"whenever"/"someday"/"eventually"

# ── "on <when>" — sets a DEADLINE *and* a one-time reminder — deadline.js ────
on_when     ← "on" SP date clock?     {pred: TRAILING only — nothing but punctuation may follow;
                                              and what follows "on" must actually parse as a date,
                                              so "work on the report" / "turn on the lamp" stay text}
                                      # with a clock → due = remind = that moment
                                      # date only    → due = end of day, remind = 09:00 that morning

# ── "by <when>" — sets a DEADLINE only — deadline.js ────────────────────────
by_deadline ← "by"? date_or_time      {pred: TRAILING only — a mid-sentence date is content, not a deadline}
                                      # "today"/"tonight"/"eod" → today, with the small-hours rollover:
                                      # before 5am, "today" means the day you'll be awake for (end of next day)

date        ← "today"/"tonight"/"tomorrow"/"this weekend"/"end of (the) week"
            / ("next" SP)? weekday
            / month SP INT            # "June 30", "jun 3rd"
            / INT "/" INT ("/" INT)?  # M/D or M/D/Y
clock       ← INT (":" INT)? meridiem?    # bare 1–7 skews PM ("by 5" → 5pm)
meridiem    ← "am" / "pm" / "a" / "p" / "a.m." / "p.m."
```

`/today …` is special: it pins the deadline to **end of today** regardless of any date words in the
text, and sets **no** reminder. A dated task surfaces a tappable `📅 /cal_N` link; Fanad never makes
a task recur — you take the `.ics` into your own calendar for that.

**Pasted links.** When a captured `body` contains an `http(s)` URL, the server fetches that page's
preview **once**, at capture — its `og:title`/`og:description` (falling back to `<title>`) — and
stores it on the task (`link_json`). The page context is fed to the classifier so the summary/detail
reflect what the link is about, and the task's title becomes a **clickable link** in every listing
(Telegram/Slack/web/CLI). Paste _only_ a URL and the page title becomes the task name (instead of the
raw link); paste words + a URL and your words stay the title, still linked. The fetch is SSRF-guarded
(public hosts only, 4s timeout, 64 KB cap) and best-effort — a failed fetch just files the task as
before. `LINK_PREVIEW=off` disables it entirely (`server/services/linkpreview.js`). Existing
URL-bearing tasks are backfilled once at startup (`server/linkBackfill.js`).

---

## Layer 3 — the dialog state machine

When Fanad asks a question it arms a dialog state. The next message is routed through
`answersPendingState` (`server/dialog.js`): a recognized **answer** runs the handler; anything that
reads as a **new intent** escapes and clears the state. Escape rules, in order:

- text starting with `/` → always a new intent (escapes);
- a recognized answer for this state → answer;
- `classifyIntent` says it's a question → new intent;
- a confident statement of **more than 3 words** → new intent (a real new task mid-suggestion);
- otherwise → answer (a statement answers Fanad's open question).

| State | Armed after | Recognized answers → effect | Unrecognized |
|---|---|---|---|
| `suggestion_reaction` (react) | `/whatdo` offered a task | yes/affirm → start · done → complete · no → offer (or grooming after 3 refusals) · smaller → smaller one · not-today → snooze to tomorrow · stop → end | re-prompt, stay armed |
| `suggestion_reaction` (offer) | a "no" to a suggestion | smaller/affirm → a smaller one · else → end | end |
| `food_confirm` | `eat <unknown food>` guessed a cal/oz | yes → save food & log · `<number>` → save with that cal/unit & log · `N total` → density from the portion · no → nothing saved or logged | re-prompt |
| `eat_qty` | `eat <known weighed food>` with no amount | `4` / `4 oz` / `120 g` / `half a pound` → log · no → skip | re-prompt |
| `recipe_build` | `recipe new <name>` | `16 oz chicken breast` → add (unknown → inline guess to confirm) · `cooked 28 oz` · `done` · `cancel` | any non-slash line is treated as an ingredient (like `list_nav`) |
| `grooming_choice` | 3+ refusals of one task | reword · break-it-down · snooze (a week) · keep | keep (back off) |
| `task_filter` | `/tasks` with many open | category / effort / all / today → the matching slice | re-ask if still many, else grouped |
| `done_feedback` | a task was completed | high-five / relief / neutral → a learning signal | move on (no trap) |
| `task_reference` | "Did you mean _<task>_?" | start it · mark done · no it's new | treat as new (no trap) |
| `stepping` | a task **with steps** was started (or `/guess` filled them in, or 🪜 Steps was opened — `edit:true`, works on an unstarted task) | done → next step · done N / done all · step … → add a step · stop/pause → leave (steps saved) | escapes; steps stay saved |
| `list_nav` | a **list** was opened (`/lists`, `/list …`, `/sub_N`) | out/up → parent · top → all lists · next/prev → page · del N · rename N … · exit → leave | the line is **added as an item** to the open list |

`done_feedback`, `task_reference`, and `stepping` never trap: an unrecognized reply just moves on,
so the user is never stuck. `list_nav` is the deliberate exception — while a list is open you're curating it,
so any non-navigation line is captured as a new item; you leave with `exit` (or any slash command).

---

## Layer 4 — free-text capture

Anything that reaches step 11 and isn't classified as a question is **kept verbatim as a task**
(or a note, via the `note` verb). This layer has no grammar **on purpose** — it's the "don't
organize, just unload" promise. The deterministic extraction of Layer 2 still runs on whatever was
captured, so "the gutters need clearing by friday p1" files clean with a deadline and priority even
though it was never a command.

---

## Lexicon

The grammar above references word classes whose membership lives in code (so the enum, the
classifier prompt, and the matchers can't drift). Treat these modules as the source of truth:

| Token | Source of truth |
|---|---|
| `category_word`, `WORD` (as a category) | [`shared/categories.js`](shared/categories.js) — `CATEGORY_META.syn`, `closestCategory` |
| `effort_word` | [`server/dialog.js`](server/dialog.js) — `EFFORT_WORD` (trivial · low · medium · high) |
| `prio_word` | [`shared/priority.js`](shared/priority.js) — `WORD_LEVEL` |
| `topic` / guide aliases | [`shared/copy.js`](shared/copy.js) — `GUIDE_ALIASES`, `GUIDES` |
| shortcut letters | [`shared/commands.js`](shared/commands.js) — `SHORTCUTS` (chat.js derives `SHORTCUT_WITH_TEXT` / `SHORTCUT_BARE`; the web legend reads it via `/api/config`) |
| filler / greeting / thanks | [`server/chat.js`](server/chat.js) — `FILLER_RE`, `GREETING_RE`, `THANKS_RE` |
| `suggest_request` phrasings | [`shared/intent.js`](shared/intent.js) — `isSuggestRequest` |
| the argless tap-menu | [`shared/commands.js`](shared/commands.js) — `ARGLESS_COMMANDS` |
| date/clock forms | [`server/services/llm/deadline.js`](server/services/llm/deadline.js) — `parseDeadline`, `parseOnWhen` |

---

## Drift guard

The command index below is **machine-checked** by
[`test/syntax-grammar.test.js`](test/syntax-grammar.test.js): every example is sent through the
live router and must avoid the unknown-command fallback. If you add, rename, or retire a command,
update this block (and the `/commands` prose) — the test fails loudly when the spec and the router disagree.
(Complements [`test/commands-drift.test.js`](test/commands-drift.test.js), which ties the `/commands` text
to the router.) One runnable example per line; `#` lines are comments; the block is delimited so the
test reads exactly these lines.

<!-- drift:begin -->
```
/help
/guide
/commands
/rules
/howto
/me
/tasks
/tasks today
/note buy milk
/task buy milk
/task:health book a checkup
/today call the pharmacy
/step rinse the pan
/guess
/unstep 2
/templates
/template weekly
/done 1
/finish 1
/start 1
/drop 1
/promote 1
/forget 1
/whatdo
/notes
/lists
/list groceries
/sub_1
/recall spare key
/mood 🙂
/lock work
/unlock
/sleeping
/revive 1
/snoozed
/unsnooze 1
/unstart
/undo
/pic 1
/cal 1
/summary
/wake 8:30
/wakelist
/ha
/remcat
/metrics
/tally
/metric add weight lbs
/track weight 182
/measure bp 120
/chart weight 30d
/eat 4oz chicken breast
/eat 8oz chicken, half a pepper, 5 mushrooms
/eat whatever
/foods
/food add chicken breast 45
/recipes
/weight 182
/target 1800
# medication (opt-in): commands route even while off (they offer to turn it on, never "unknown")
med add amlodipine 5mg
med amlodipine
med template morning = amlodipine, metformin
med all
med chart amlodipine
/meds
# speed dial (owner): program another Telegram account's 0-9 Home Assistant pad (the guest fires a bare digit)
sd
sd @alice 1 = turn off the kitchen lights
sd @alice limit on
sd @alice
/menu
```
<!-- drift:end -->
