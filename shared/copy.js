// Canonical onboarding copy — the rules + how-to. Shared by the server brain (Telegram /rules /howto /start
// greetings) AND served to the web client via /api/config, so there's ONE source instead of a hand-synced
// copy in web/src/App.jsx. Plain paragraphs (blank-line separated); both Telegram and the web wrap them.
export const RULES = [
  '✨ The Rules of Fanad',
  'ask of me these rules of three…',
  '',
  '① Make a statement, and I’ll add it to my list.',
  '② Ask a question, and I’ll see what I can do.',
  '③ Answer my question, and so shall it be.',
  '',
  '🌱 A “no” is never the end in Fanad — we’ll find something the right size, or nothing at all.',
  '🙂 And show me how you feel, anytime, with an emoji.',
].join('\n');

export const HOWTO = [
  '✨ How to fill your Fanad',
  '',
  'Use Fanad like an extra memory, or a little notebook. Just wander — through your home, your day, your head — and jot down anything you’d like to change, accomplish, experience, clean up, or tear down. Don’t sort it; that’s my job.',
  '',
  'Got something big? Add it, then add little steps with “step …” and say “start” to walk through them one at a time — “guide steps” shows you how.',
  '',
  '🗓 Tip: for anything that repeats or needs a reminder, give a task a date (“water the plants on sunday”), then tap its 📅 /cal link to download it into your device’s calendar — let it repeat and notify you there. I don’t nag or repeat on a schedule, on purpose; your own calendar is the kinder home for that. “guide reminders” has more.',
  '',
  'The bigger your list, the richer the experience. Start small, add often. 🌱',
].join('\n');

// ── Topic guides — a deeper, friendly walkthrough of ONE feature at a time, reached via "guide <topic>".
// Add a topic by adding an entry to GUIDES + an alias or two below; the command (chat.js) and the `c` menu
// pick it up automatically. Written to be read start-to-finish (some users read every word), so keep them
// warm, concrete, and in order. The first of likely several (future: reminders, calendar, moods, metrics).
export const STEPS_GUIDE = [
  '✨ Guide: Steps — breaking a task into a checklist',
  '',
  'Big task? Split it into small steps and do them one at a time. 🌱',
  '',
  '① Add the task like normal: “bake sourdough”.',
  '② Add steps under it: “step feed the starter”, then “step bake at 230C”. Each one tucks under the task you’re working on — or, when nothing’s started, the task you just added.',
  '   On your list, aim at one: “step 2 rinse the pan” adds a step to item 2. Or open 🪜 Steps under ⋯More on any task — then “step …” lands there. (“substep” and “subtask” work too.)',
  '   Changed your mind about one? “unstep 2” removes step 2 (or “unstep all”). The rest renumber.',
  '③ When you’re ready, say “start”. I’ll show your note, then the steps in order, each with a ☐ box and a tappable button.',
  '   Don’t want to write them yourself? Start the task and tap 💡 Suggest steps (or say “/guess”). This one’s a genuine guess from general know-how, not your notes — so trim it with “unstep 2” and make it yours. 🌱',
  '④ Tick them off: tap a box, or say “done” for the next one, “done 2 3” for a few, or “done all”.',
  '   Finish the last step and the whole task is done. 🎉',
  '',
  'Not now? Say “stop” to pause — your steps stay saved for next time.',
].join('\n');

export const TEMPLATES_GUIDE = [
  '✨ Guide: Templates — reuse a task without it repeating',
  '',
  'Some tasks come around again — a weekly review, a grocery run, a packing list. Save one as a template and pull a fresh copy whenever you like. No schedule, no nagging — you choose the moment. 🌱',
  '',
  '① Build it once: add the task and its steps like normal (“bake sourdough”, then “step feed the starter”…).',
  '② Save it from your list: “/template 3 sourdough” saves item 3 as a template named “sourdough”. Re-save the same name to update it.',
  '③ Use it anytime: “/template sourdough” drops a fresh copy on your list — steps and all, reset to unchecked. Say “start” to walk through it.',
  '④ Tend them: “/templates” lists what you’ve saved; “/template retire sourdough” lets one go.',
  '',
  'A template carries the shape — the wording, category, and steps — but never a deadline or priority. That’s on purpose: a copy should feel fresh and pressure-free, not like a chore you’re already behind on. For things that truly repeat on a clock, your own calendar is the kinder home. 🌱',
].join('\n');

export const REMINDERS_GUIDE = [
  '✨ Guide: Reminders & dates — deadlines, nudges, and your calendar',
  '',
  'Some things have a “when”. Just say it in plain words and I’ll hold the date for you. 🌱',
  '',
  '① A deadline: end a task with “by <when>” — “renew the passport by friday”, “submit the form by next tuesday”. I’ll mark it due, gently move it up your list, then quietly retire it once it’s passed.',
  '② A nudge on a day: say “on <when>” with a time — “call mom on sunday 6pm”. That sets the deadline AND a one-time reminder, so I’ll ping you once when it’s time.',
  '③ A plain reminder: say “remind me … at <time>” — “remind me to take the bins out at 8pm”, or “remind me to stretch in 30 minutes”. I’ll ping you once when it’s time and leave the task on your list, so it’s a nudge, not a deadline.',
  '④ Onto your calendar: any task with a date shows a tappable “📅 /cal” link (or type “/cal 3” for item 3). I hand you a calendar file to drop into your own calendar — where you can make it repeat if you want.',
  '',
  'I don’t do repeating tasks myself, on purpose — repeats pile up and weigh on you. Your own calendar is the kinder home for those. 🌱',
].join('\n');

export const CAPTURING_GUIDE = [
  '✨ Guide: Capturing & categories — just talk, I’ll sort',
  '',
  'The whole idea: don’t organize, just unload. Anything you’d like to do, change, or remember — say it, and I keep it in your own words. 🌱',
  '',
  '① File a task: just make a statement — “the gutters need clearing”. That’s it, it’s on your list.',
  '② I sort it for you: I quietly pick a category (home, health, admin, fun, self-care…) and a rough effort. You never have to.',
  '③ Steer it if you like: “/task:health book a check-up” files under health. Add “high priority” (or “p1”) right in the sentence to bump it up.',
  '④ Adding a bunch at once? “/lock home” pins everything you add next to that category; “/lock high” pins the effort; “/unlock” when you’re done. A brand-new word like “/lock garden” simply creates that category.',
  '',
  'Don’t sort, don’t tidy — that’s my job. The fuller your list, the more I can help. 🌱',
].join('\n');

export const SUGGESTIONS_GUIDE = [
  '✨ Guide: Suggestions & a gentle “no”',
  '',
  'Not sure what to do? Ask me — and know that “no” is always allowed. 🌱',
  '',
  '① “/whatdo” — I’ll suggest one thing that fits your time, energy, and the moment. Just one, never a wall of them.',
  '② Then you steer: “yes” to start it · “smaller” if it feels too big and I’ll find something lighter · “not today” to tuck it away · “no”, and we’ll find the right size, or nothing at all.',
  '③ Drifting tasks rest: anything untouched for about three weeks quietly goes to sleep, so your list stays calm. “/sleeping” shows them; “/revive 1” wakes one back up.',
  '④ Snoozed tasks wait, they don’t vanish: “/snoozed” shows what you tucked away and when each comes back; “/unsnooze 1” brings one back early. Started the wrong thing? “unstart” puts it back without finishing.',
  '',
  'There’s no failing here. A “no” is just information — never the end. 🌱',
].join('\n');

export const NOTES_GUIDE = [
  '✨ Guide: Notes, recall & photos — a place to set things down',
  '',
  'Not everything is a task. Some things you just want to put down and find later. 🌱',
  '',
  '① Jot a note: “note the spare key is under the blue pot”. It lands in your notes inbox, not your task list.',
  '② Find it again: “/recall spare key” — I search your notes by meaning, not exact words, so rough phrasing still turns it up.',
  '③ See and tend them: “/notes” shows the inbox · “/promote 2” turns note 2 into a real task · “/forget 2” lets it go (or a few at once: “/forget 1 2 3”).',
  '④ Snap a photo: send a picture with a caption and I file it as a task with the photo attached; send one with no caption and it waits in your notes. Later, “/pic 3” sends back the photo on item 3.',
  '',
  'Think of it as a voicemail to your future self. 🌱',
].join('\n');

export const LISTS_GUIDE = [
  '✨ Guide: Lists — nestable lists, separate from your tasks',
  '',
  'Some things aren’t tasks — they’re lists. A grocery run, a trip to pack for, a project broken into parts. Lists live on their own, and any item can open into its own list of sub-items, as deep as you like. 🌱',
  '',
  '① Open them: “/lists” shows your lists. At the top, type a name (“Groceries”) — or “/list Groceries” — to start one.',
  '② Add items: once a list is open, just type — each line becomes an item. “Milk”, “Eggs”, “Bread”.',
  '③ Go deeper: every row has a tappable “/sub_N”. “/sub_2” opens item 2 as its own list; now type to add its sub-items. Or quick-add without going in: “/sub_2 organic”.',
  '④ Move around: “out” steps up a level, “top” jumps back to all your lists, “next”/“prev” page when a list is long. There are buttons for these too.',
  '⑤ Tidy up: “del 2” removes item 2 (and everything under it); “rename 2 New name” relabels it.',
  '⑥ Leave: “exit” closes the lists and goes back to normal chat.',
  '',
  'Lists don’t nag, have no deadlines, and never become suggestions — they’re a calm place to outline, not another to-do pile. For things you actually want to DO, make a task instead. 🌱',
].join('\n');

export const SHORTCUTS_GUIDE = [
  '✨ Guide: Shortcuts — one letter instead of the whole command',
  '',
  'In a hurry? Start a message with a single letter and I’ll read it as the command — you skip typing the rest. 🌱',
  '',
  '• n … → note — “n the spare key is under the blue pot”',
  '• t … → task — “t book the dentist by friday”',
  '• d … → done — “d 3” finishes item 3 (a few at once: “d 1 2 3”)',
  '• k … → drop — “k 3” clears item 3 off your list (kill it; a few at once: “k 1 2 3”)',
  '• u → undo — “u” on its own takes back the last thing I did (a capture, a done, a logged entry…)',
  '• s … → step — “s rinse the pan” adds a step to the task you’re working on (else your last one)',
  '• r … → recall — “r where’s the spare key” searches your notes',
  '• g … → guide — “g steps” opens a topic guide (even “g shortcuts”, this one)',
  '• x … → today — “x call the pharmacy” files it due today',
  '• j … → journal — “j note had dairy at lunch” adds to today’s journal; bare “j” opens your journals (needs the Journal module on)',
  '• h … → manual — “h how do I set a reminder?” asks the manual and answers from it',
  '• w → whatdo — “w” on its own asks me what to do next',
  '',
  'A couple of rules, so a normal sentence is never mistaken for a command:',
  '① The letter has to be the very FIRST thing you type — mid-sentence never counts, so “turn left at the light” is safe.',
  '② For n, t, d, k, s, r, g and x, put the rest right after it. A letter on its own just means itself — “n” still means “no”, not an empty note. (Only “w”, “j” and “h” act on their own.)',
  '',
  'Already here: “c” on its own pops the tappable command menu. (There’s no “y” shortcut on purpose — it reads as “yes”.)',
].join('\n');

// Metrics is the OPTIONAL tracking module (off until turned on in Settings), so this guide is gated the
// same way its commands are — chat.js only resolves + advertises it when Metrics is enabled.
export const METRICS_GUIDE = [
  '✨ Guide: Metrics — tracking a number over time',
  '',
  'Want to keep an eye on a number — weight, sleep, water, mood, anything? Metrics quietly charts it for you. (Turn Metrics on in Settings first.) 🌱',
  '',
  '① Name what you’re tracking: “/metric add weight lbs” — a name and an optional unit. Add how to roll it up if you like: sum, avg, last, max, or min (default: sum).',
  '② Log as you go: “/track weight 182” adds a point over time; “/measure bp 120” notes a one-off. Add a short note on the end if it helps.',
  '③ See it: “/tally” shows your dashboard; “/chart weight 30d” draws it over the last 30 days.',
  '④ Slip up? “undo” takes back the last thing I did — including a tracked entry. (Food and calories have their own module — “guide diet”.)',
  '',
  'Small and steady beats perfect — track only what you actually care about. 🌱',
].join('\n');

// Diet is the OPTIONAL calorie-tracking module (per-user opt-in, separate from Metrics though it logs
// into the calories metric). Gated like the other opt-in guides.
export const DIET_GUIDE = [
  '✨ Guide: Diet — weigh it, log it, done',
  '',
  'The whole trick: weigh your food, know its calories per ounce, multiply. I keep your food list — it ends up surprisingly short — so logging is usually three words. 🌱',
  '',
  '① Log by weight: “eat 4 oz chicken breast”. If I know the food, that’s it — logged, with your day’s total.',
  '② New food? I’ll guess its cal/oz once — reply “yes”, or send the right number (check the package). Either way it’s saved, and I never guess that food again. “foods” shows your list; “food add cheddar 110” teaches me directly.',
  '③ Recipes: “recipe new chili”, tell me what went in (“16 oz ground beef”…), then the COOKED weight of the finished dish. From then on “eat 8 oz chili” just works — weigh the portion, not the ingredients. One-liner: “recipe chili = 16 oz beef, 1 onion @ 28 oz cooked”.',
  '④ The rest: “target 1800” sets your daily goal · “weight 182” tracks your weight · “undo” takes back the last portion (it works app-wide) · the web’s 🍽️ Diet view has the graphs, your food library, and a recipe builder.',
  '',
  'Pieces work too — “eat 2 eggs” — and corrections stick: “food set cheddar 105”. Your numbers, not mine. 🌱',
].join('\n');

// Timer is the OPTIONAL one-shot countdown module (per-user opt-in, like metrics/notes/lists), so this
// guide is gated the same way its commands are — chat.js only resolves + advertises it when Timer is on.
export const TIMER_GUIDE = [
  '✨ Guide: Timer — a one-shot ding, not another task',
  '',
  'Pasta on the stove, laundry in the machine, a break that should end — set a timer and forget it. Nothing lands on your list; I just ping you once when time’s up. 🌱',
  '',
  '① Set one: “timer 10 minutes”. Combine amounts if you like — “timer 1h 30m” — or speak it: “timer half an hour”.',
  '② Label it: any extra words become the label — “timer 12 min pasta” dings with “pasta”, so you know which one rang.',
  '③ See what’s running: “timer” lists them, soonest first, each with a cancel button.',
  '④ Cancel: “timer off 1” stops the first one (or tap its ✕ button).',
  '',
  'A timer is for the next little while — a minute up to a few days. For a nudge on a DAY (“friday 3pm”), give a task a date instead: “call mom on friday 3pm” — see “guide reminders”. 🌱',
].join('\n');

// Journal is the OPTIONAL trend-journal module (per-user opt-in) — the heaviest AI feature: daily
// checklist + note, AI summaries by day/week/month, and gentle long-term pattern spotting. Gated like
// the other opt-in guides — chat.js only resolves + advertises it when Journal is on.
export const JOURNAL_GUIDE = [
  '✨ Guide: Journal — a daily checklist I read for trends',
  '',
  'Some problems only show up over weeks — the food that doesn’t sit right, the sleep that slips, the limp your dog only gets some mornings. A journal is a small daily habit I can actually read back over. 🌱',
  '',
  '① Start one: “journal new food” (name it anything — a pet’s name works too).',
  '② Give it a daily checklist: save any task as a template first (“/template 3 morning-checks”), then “journal template morning-checks”. The steps become each day’s checklist — snapshotted, so later template edits don’t rewrite your journal.',
  '③ Each day: “entry” opens today (tap items, or “check 1 2”), and “journal note had dairy at lunch, headache by 3pm” adds the day’s note. The note is where trends hide — jot symptoms, food, mood, anything.',
  '④ Read it back: “journal today” · “journal yesterday” · “journal week” · “journal month” — I summarize what you logged, and file each day’s final word overnight.',
  '⑤ Spot patterns: “journal trends” — I look across the weeks for things that travel together (“headaches on 4 of the 5 days after dairy”) and tell you what might be worth watching. Patterns, not diagnoses — a doctor (or vet) is the next step if one worries you.',
  '',
  'Several journals are fine (“journal new pepper” for the dog); “journal use <name>” picks the default. Shortcut: j — “j note …”, bare “j” opens them. An unticked box is data too, never guilt. 🌱',
].join('\n');

// Batches is the OPTIONAL process-batch module (per-user opt-in): each run of a repeatable process —
// a brew, a bake, a batch of soap — gets its own numbered checklist (snapshotted from a template), a
// dated log, and an outcome. No AI, no reminders: the batch moves only when the user says so. Gated
// like the other opt-in guides — chat.js only resolves + advertises it while Batches is on.
export const BATCHES_GUIDE = [
  '✨ Guide: Batches — one checklist + diary per run',
  '',
  'Some things you make again and again — sourdough, kombucha, soap — and batch #7 is only better than #3 if you can read back what you did. A batch is one run: its own steps, its own dated log, its own verdict. 🌱',
  '',
  '① Write the directions once: save any task with steps as a template (“/template 3 sourdough”). The template IS the recipe card.',
  '② Start a run: “batch new sourdough” — the steps are snapshotted in as run #1’s checklist (later template edits never touch a batch already going).',
  '③ While it runs: “batch” shows the current run (tap steps, or “batch check 1 2”), and “batch log fed the starter, smells lively” adds a dated line — days or weeks of them.',
  '④ Tweak as you learn: “batch add cold-proof overnight” · “batch edit 2 autolyse 45 min” · “batch rm 5”. The run is a working copy — change its steps freely.',
  '⑤ Graduate the winners: “batch save” files the tweaked steps as a new recipe version (“sourdough #2”, auto-numbered — the original stays put). “batch new sourdough” then starts from your latest version.',
  '⑥ Close it: “batch done tangy, best crumb yet” files the outcome. Two runs of the same thing at once is fine — “batch new sourdough” again just opens the next run.',
  '⑦ Read it back: “batch history sourdough” and “batch versions sourdough” — every run + every recipe version. A bad experiment? “batch reject sourdough #3” drops that version from the lineage (“batch unreject …” restores it).',
  '',
  'Bare “batches” lists your processes. No reminders, ever — a batch moves when you say so. 🌱',
].join('\n');

// Home Assistant is the OPTIONAL house-bridge module (per-user opt-in; the owner pairs the connection in
// Settings). Fanad stays the brain — timers/reminders live HERE — and the house becomes an output: a
// voice satellite speaks the ding, a script can ring a siren, phones get a push. Plus "ha <command>"
// pipes anything to HA's own assistant, and dated tasks can be pushed onto a house calendar.
export const HOMEASSISTANT_GUIDE = [
  '✨ Guide: Home Assistant — your dings ring the house',
  '',
  'Home Assistant has no reminders of its own that survive a restart — Fanad does. With this module on, the timers and reminders you already set here also ring the HOUSE: a voice speaker announces them, a script can flash lights or sound a siren, your phone gets a push. 🌱',
  '',
  '① Pair it (owner, once): in HA create a long-lived access token (your profile → Security), then paste the URL + token in Settings → Home Assistant and pick the outputs. “ha test” rings them so you know it works.',
  '② That’s it for dings — “timer 12 min pasta” and “dentist on friday 3pm” now announce in the house when they fire, on top of the normal chat ding.',
  '③ Talk to the house: “ha turn off the kitchen light”, “ha is the garage door open” — anything after “ha” goes straight to Home Assistant’s own assistant and its answer comes back.',
  '④ House calendar: on a dated task, “ha cal 3” (or the 🏠 button next to 📅 /cal_3) drops it onto the house calendar — needs the Local Calendar integration in HA and a calendar picked in Settings.',
  '⑤ Check on it: bare “ha” shows the connection, outputs, and whether the last ring got through.',
  '',
  'Fanad never reads your house — no sensors, no presence, nothing comes back except what HA answers when you ask. The house is an output, not an input. 🌱',
].join('\n');

export const GUIDES = {
  steps: STEPS_GUIDE,
  templates: TEMPLATES_GUIDE,
  reminders: REMINDERS_GUIDE,
  capturing: CAPTURING_GUIDE,
  suggestions: SUGGESTIONS_GUIDE,
  notes: NOTES_GUIDE,
  lists: LISTS_GUIDE,
  shortcuts: SHORTCUTS_GUIDE,
  metrics: METRICS_GUIDE,
  diet: DIET_GUIDE,
  timer: TIMER_GUIDE,
  journal: JOURNAL_GUIDE,
  batches: BATCHES_GUIDE,
  homeassistant: HOMEASSISTANT_GUIDE,
};

// Spoken name → topic key, so "guide subtasks", "reminder guide", "photo guide" all resolve. Aliases must
// be unique across topics (each maps to exactly one guide).
export const GUIDE_ALIASES = {
  steps: 'steps', step: 'steps', substep: 'steps', substeps: 'steps',
  subtask: 'steps', subtasks: 'steps', checklist: 'steps', checklists: 'steps',
  templates: 'templates', template: 'templates', reuse: 'templates', reusable: 'templates',
  blueprint: 'templates', recurring: 'templates', repeat: 'templates', repeating: 'templates',
  reminders: 'reminders', reminder: 'reminders', remind: 'reminders',
  deadline: 'reminders', deadlines: 'reminders', date: 'reminders', dates: 'reminders',
  due: 'reminders', calendar: 'reminders', cal: 'reminders', schedule: 'reminders', when: 'reminders',
  capturing: 'capturing', capture: 'capturing', categories: 'capturing', category: 'capturing',
  sort: 'capturing', sorting: 'capturing', lock: 'capturing', locking: 'capturing', tags: 'capturing', tag: 'capturing',
  suggestions: 'suggestions', suggestion: 'suggestions', whatdo: 'suggestions', next: 'suggestions',
  stuck: 'suggestions', overwhelm: 'suggestions', overwhelmed: 'suggestions',
  sleeping: 'suggestions', sleep: 'suggestions', revive: 'suggestions',
  notes: 'notes', note: 'notes', recall: 'notes', remember: 'notes', memory: 'notes',
  photo: 'notes', photos: 'notes', pic: 'notes', pics: 'notes', picture: 'notes', pictures: 'notes', promote: 'notes',
  lists: 'lists', list: 'lists', sublist: 'lists', sublists: 'lists', nested: 'lists', nesting: 'lists',
  outline: 'lists', outliner: 'lists',
  shortcuts: 'shortcuts', shortcut: 'shortcuts', letters: 'shortcuts', letter: 'shortcuts',
  abbreviation: 'shortcuts', abbreviations: 'shortcuts', abbrev: 'shortcuts',
  metrics: 'metrics', metric: 'metrics', track: 'metrics', tracking: 'metrics', tally: 'metrics',
  chart: 'metrics', charts: 'metrics', measure: 'metrics', stats: 'metrics', numbers: 'metrics',
  diet: 'diet', food: 'diet', foods: 'diet', eat: 'diet', eating: 'diet', calorie: 'diet',
  calories: 'diet', recipe: 'diet', recipes: 'diet', weight: 'diet', weigh: 'diet',
  timer: 'timer', timers: 'timer', countdown: 'timer', countdowns: 'timer', ding: 'timer',
  journal: 'journal', journals: 'journal', diary: 'journal', trend: 'journal', trends: 'journal',
  symptom: 'journal', symptoms: 'journal',
  batches: 'batches', batch: 'batches', brew: 'batches', brewing: 'batches',
  ferment: 'batches', fermentation: 'batches', bake: 'batches', baking: 'batches',
  ha: 'homeassistant', homeassistant: 'homeassistant', house: 'homeassistant',
  announce: 'homeassistant', announcements: 'homeassistant', siren: 'homeassistant',
};
export const GUIDE_TOPICS = Object.keys(GUIDES);

// Friendly one-tap labels for the guide hub, in newcomer reading order (most useful first). Keys match
// GUIDES; the hub builder (server/menu.js) shows only the ones whose feature is live (metrics is gated).
export const GUIDE_LABELS = {
  capturing: '📝 Capturing',
  suggestions: '💡 What to do',
  steps: '🪜 Steps',
  reminders: '🗓 Reminders',
  notes: '📷 Notes & photos',
  lists: '📑 Lists',
  templates: '♻️ Templates',
  shortcuts: '⚡ Shortcuts',
  metrics: '📊 Metrics',
  diet: '🍽️ Diet',
  timer: '⏲ Timer',
  journal: '📔 Journal',
  batches: '🧪 Batches',
  homeassistant: '🏠 Home Assistant',
};

// Resolve a spoken topic to its canonical key (or null). chat.js uses this to gate config-dependent guides.
export function guideKey(topic) {
  return GUIDE_ALIASES[String(topic || '').trim().toLowerCase()] || null;
}
// Resolve a spoken topic to its guide text, or null if there's no guide by that name.
export function guideFor(topic) {
  const key = guideKey(topic);
  return key ? GUIDES[key] : null;
}

// ── The command reference, split into tappable SECTIONS (the /commands hub) instead of one wall of text.
// Each section is one button on the hub keyboard (server/menu.js → commandHubMenu) and expands IN PLACE to
// its lines (chat.js). Keys are stable — they ride in the m:cmd:<key> token — and labels carry the voice.
// commands-drift.test.js enforces that every argless command appears in SOME section, so when you add a new
// command, list it in one of these. Static on purpose (no gating): the metrics line carries its own "turn on
// in Settings" note, exactly as the old wall did.
// A section (or an individual line) may carry an optional `feature` — the toggle that must be ON for it to
// show. liveSections() (below) drops anything whose feature is off, so the /commands reference matches what's
// actually installed. Sections/lines with no `feature` are the always-on core (Tasks). Feature keys: 'notes',
// 'lists', 'metrics', 'vouch' (Tasks are core — never gated). A line may be a plain string OR { feature, text }.
export const COMMANDS_INTRO = 'Everything I can do — tap a section: ✨';
export const COMMAND_SECTIONS = [
  {
    key: 'tasks',
    label: '▶ Tasks',
    lines: [
      '• /tasks — counts by kind; pick one to see the top 10, then “next” for more · /tasks all — everything · /tasks today — due today',
      '• /today call the pharmacy — file it due today (or just “x call the pharmacy”)',
      '• /done 3 · /start 3 — finish or start item 3 (a few: /done 1 2 3) · /drop 3 — clear it off your list',
      '• unstart — put the task you started back on the list without finishing it (or /unstart 2 by position)',
      '• undo — take back the last thing I did (a capture, a done, a drop, a snooze, a logged entry, a timer…)',
      '• /whatdo — what should I do right now? (then reply yes · no · smaller) · /whatdo today — only what’s due today',
      '• /sleeping — tasks that drifted off (untouched ~3 weeks) · /revive 1 — bring one back',
      '• /snoozed — tasks you tucked away, with when each wakes · /unsnooze 1 — bring one back now',
      '• /lock work — pin a category for the next adds (also /lock high; a new one-word name creates that category) · /unlock',
      '• /pic 3 — resend the photo on item 3 (rows with a photo show a tappable 📷 /pic link)',
    ],
  },
  {
    key: 'capture',
    label: '➕ Capture & steps',
    lines: [
      '• Just talk to me — a statement becomes a task; a question runs a command.',
      '• /task:health dentist by friday — add a task with a category + deadline (I’ll prioritize it, then retire it)',
      '• Add extras inline: “…high priority” (or p1) sets a manual priority.',
      '• step buy milk — add a step under the task you’re working on, else your last one (“step 2 …” targets a listed one; “unstep 2” removes one); then “start” walks you through them — see “guide steps”',
      '• /guess — once a task is started, I’ll guess the steps for you (my own best guess, not your notes); tick with “done”, edit with “step …” / “unstep 2”',
      '• /template 3 weekly — save task 3 as a reusable blueprint; “/template weekly” starts a fresh copy · /templates · “guide templates”',
    ],
  },
  {
    key: 'notes',
    label: '📝 Notes',
    feature: 'notes',
    lines: [
      '• /note buy milk — jot something to recall later, kept separate from your tasks',
      '• /notes — your inbox · /recall <words> — find a note by meaning · /promote 2 — make note 2 a task · /forget 2 — delete it',
      '• A photo with no caption waits in your notes; “guide notes” has more.',
    ],
  },
  {
    key: 'lists',
    label: '📑 Lists',
    feature: 'lists',
    lines: [
      '• /lists — open your lists (each item can hold its own nested sub-lists) · at the top, type a name or “/list Groceries” to start one',
      '• /sub_1 — open item 1 to view and add its sub-items (a tappable “/sub_N” link sits on every row); “/sub_1 milk” quick-adds under it',
      '• Inside a list: type to add an item · “out” up a level · “top” back to all lists · “next”/“prev” to page · “del 2” · “rename 2 …” · “exit” to leave',
      '• Lists are separate from tasks — no deadlines, no nagging, never a suggestion; “guide lists” has the full walk-through.',
    ],
  },
  {
    key: 'time',
    label: '⏰ Reminders & calendar',
    lines: [
      '• “…by friday” sets a deadline; “…on friday 3pm” sets a deadline + a one-time reminder.',
      '• /cal 3 — add item 3 to your calendar (dated rows show a tappable 📅 /cal link; recur it there if you like)',
      '• /wake 8:30 — a gentle check-in at that time · /wakelist · /wake off 2',
      { feature: 'timer', text: '• /timer 10 minutes — a one-shot ding when time’s up (label it: “timer 12 min pasta”) · bare “timer” lists what’s running · “timer off 1” cancels · “guide timer”' },
    ],
  },
  {
    key: 'journal',
    label: '📔 Journal',
    feature: 'journal',
    lines: [
      '• journal new food — start a named trend journal (several are fine — a pet’s works too) · bare “journal” lists yours · journal use <name> picks the default',
      '• journal template <template> — snapshot one of your /templates as its daily checklist',
      '• /entry — open today’s entry · check 1 2 / uncheck 2 — tick items · journal note <text> — add to today’s note (shortcut: “j note …”)',
      '• journal today · yesterday · week · month — AI summaries of what you logged · journal trends — gentle long-term patterns (not medical advice)',
      '• journal delete <name> — ⚠️ erase a journal and its entries (I’ll ask you to confirm) · “guide journal” walks it through',
    ],
  },
  {
    key: 'batches',
    label: '🧪 Batches',
    feature: 'batches',
    lines: [
      '• batch new <name> — start a run from your latest saved version (directions snapshotted from your /templates) · bare “batches” lists your processes',
      '• batch — show the current run · batch check 1 2 / batch uncheck 2 — tick its steps',
      '• batch add <text> · batch edit <n> <text> · batch rm <n> — tweak the run’s steps as you go',
      '• batch save — graduate the tweaked steps into a new recipe version (“<name> #2”, auto-numbered; the original stays)',
      '• batch log <text> — add a dated line to the run’s diary (days or weeks of them)',
      '• batch done <how it went> — close the run with its outcome · batch history <name> — every past run',
      '• batch versions <name> — the recipe lineage · batch reject <name> #<n> / batch unreject <name> #<n> — drop a bad version, or restore it',
      '• batch delete <name> — ⚠️ erase a process’s runs and logs (I’ll ask you to confirm) · “guide batches” walks it through',
    ],
  },
  {
    key: 'homeassistant',
    label: '🏠 Home Assistant',
    feature: 'homeassistant',
    lines: [
      '• Your timers and reminders ring the HOUSE too — a voice satellite announces them, a script can sound a siren, phones get a push (the owner pairs it in Settings → Home Assistant).',
      '• ha <command> — talk to Home Assistant’s own assistant: “ha turn off the kitchen light”, “ha is the garage door open”',
      '• /ha — connection + outputs status · ha test — ring every enabled output now',
      '• ha cal 3 — push dated item 3 onto the house calendar (dated rows’ 📅 /cal reply also shows a 🏠 button) · “guide ha” walks it through',
    ],
  },
  {
    key: 'me',
    label: '📊 Me & metrics',
    lines: [
      '• /mood 🙂 — set how you’re feeling (a word like “overwhelmed” works too)',
      '• /me — what I’ve learned · /summary [today | this week | last week]',
      { feature: 'metrics', text: '• Metrics: /track water 3 · /measure bp 120 · /tally · /chart water 30d · “guide metrics” explains it' },
      { feature: 'diet', text: '• Diet: /eat 4oz chicken breast (I learn your foods — no re-guessing) · /foods · /food add cheddar 110 · /recipes · recipe new chili · /weight 182 · /target 1800 · undo · “guide diet”' },
      '• /requestdeletion — ⚠️ permanently erase ALL of your data. I’ll ask you to confirm first; it can’t be undone.',
    ],
  },
  {
    key: 'modules',
    label: '🧩 Modules',
    lines: [
      '• You start with just Tasks. Optional surfaces stay off until you turn them on — so the chat stays calm.',
      '• modules — see what’s on or off, and tap to toggle.',
      '• optin lists · optin notes · optin metrics · optin vouch · optin notebook · optin timer · optin journal · optin batches · optin ha — turn one on. optout lists — hide it again (your data is kept; opt back in any time).',
      { feature: 'notebook', text: '• notebook <name> — open a separate, private space with its own tasks, notes & lists (like a fresh notebook); “notebook” lists yours, “notebook main” returns to your default space.' },
    ],
  },
  {
    key: 'help',
    label: '❔ Help',
    lines: [
      '• /howto — get started · /rules — the rules · /guide — tappable topic guides · /commands — this menu',
      '• /manual <question> — ask the manual anything and I’ll answer from it (shortcut: “h how do I set a reminder?”); bare “h” shows how',
      { feature: 'vouch', text: '• /vouch @username — let someone you trust into this bot (I keep a record of who vouched them); bare “vouch” lists who you’ve let in. The owner can revoke access in Settings.' },
      '• /web — a one-time link that opens Fanad in your browser, signed in as you (needs the admin to set a Site URL and turn on web login)',
      '• /cmd — from the browser: mint a terminal-client token and get the ready-to-paste `fanad <server> <token>` connect command (shown once; revoke in Settings → Security)',
      '• Topic guides — a deep dive on one thing; tap /guide to pick one (e.g. “guide steps”)',
      '• Shortcuts: lead a message with a letter to skip the command — n→note, t→task, d→done, s→step, r→recall, g→guide, x→today, j→journal, h→manual (e.g. “n spare key”), or just “w” for whatdo. “guide shortcuts” has the details.',
      '• c (or /menu) — pop the tappable command menu (works mid-question to back out of it)',
      '• Tip: the leading slash is optional — “mood 🙂”, “sleeping”, “done 3” all work without it.',
    ],
  },
];

// The command reference filtered to the features that are ON. Drops a whole section whose `feature` is off,
// and any single line tagged with an off `feature`; normalizes every surviving line to a plain string and
// drops a section left empty. `isOn(featureKey) -> boolean` is supplied by the server (chat.js reads the
// live settings); the default keeps everything, so callers that don't gate (e.g. the pure menu test) are
// unchanged. This is what makes the /commands + /guide help show "only installed features."
export function liveSections(isOn = () => true) {
  const out = [];
  for (const s of COMMAND_SECTIONS) {
    if (s.feature && !isOn(s.feature)) continue;
    const lines = s.lines
      .filter((l) => typeof l === 'string' || !l.feature || isOn(l.feature))
      .map((l) => (typeof l === 'string' ? l : l.text));
    if (lines.length) out.push({ key: s.key, label: s.label, lines });
  }
  return out;
}

// Whole-message help requests — NOT "help me move the couch" / "help please book a table", which stay
// tasks (the alternatives are pinned to the start AND end of the message). Shared by the router (chat.js)
// and the dialog-escape guard (dialog.js) so the two can't drift.
export const HELP_RE = /^(help|halp|help me|help please|what can (you|i) do|how do (you|i) work|how does (this|it|fanad) work)[\s!.?]*$/i;

// Is this message one of the deterministic guide/help/rules/howto COMMANDS (the exact navigational forms,
// leading slash optional) — as opposed to a task that merely contains those words ("help me …", "travel
// guide")? Mirrors chat.js's routing so these can escape an open question instead of being read as its
// answer, WITHOUT changing what gets captured as a task.
export function isGuideCommand(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const bare = t.toLowerCase().replace(/^\//, '');
  if (['guide', 'rules', 'howto', 'how'].includes(bare)) return true;
  if (HELP_RE.test(t)) return true;
  if (/^\/?guide\s+.+$/i.test(t)) return true;                       // "guide <anything>" is always a guide command
  const m = /^(.+?)\s+guide$/i.exec(t);                              // "<topic> guide" only when <topic> is a real guide
  return !!(m && guideFor(m[1]));
}

// After /requestdeletion wipes the account: the one step Fanad CANNOT do — each channel keeps its own
// copy of the conversation until the user clears it there. Keyed by channel so the wording matches where
// they actually are (a Telegram chat is deletable; a Slack DM mostly isn't; the web is just their screen).
export const DELETION_CHANNEL_REMINDER = {
  telegram: '\n\n📵 One thing only you can do: delete this Telegram chat. Clear the whole history — your messages and mine — so no copy lingers on Telegram’s side.',
  slack: '\n\n📵 One thing only you can do: this Slack DM keeps its own history on Slack’s side. Delete my messages there (or ask your workspace admin about retention) if you want that copy gone too.',
  web: '\n\n📵 One thing only you can do: clear this conversation on your end too, if you want it gone from your screen.',
};
