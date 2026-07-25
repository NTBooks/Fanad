# Fanad

[![CI](https://github.com/NTBooks/Fanad/actions/workflows/ci.yml/badge.svg)](https://github.com/NTBooks/Fanad/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A **local-first, local-LLM RAG life-OS**. You text short snippets to your "future self" (web chat,
Telegram, or Slack); a local LLM you configure (LM Studio or Ollama) classifies them, and every suggestion is
**grounded in your own data** — the model only ranks and phrases real rows it's given, never invents.
It addresses you as **PastSelf**.

> Status: functional and heavily tested, in daily use by its author and under active development.
> Single maintainer — expect fast iteration and the occasional rough edge.

## Prerequisites
- **Node 24+** (uses the native built-in `node:sqlite` — no C++ addon; unflagged on Node 24).
- A **local model server**: [LM Studio](https://lmstudio.ai) (the easy default; Developer tab →
  Start Server) or [Ollama](https://ollama.com), with a chat model **and** an embedding model
  loaded. No model hardware? See the `mock` provider below, or the triple-locked cloud option
  under Privacy.

## Setup

**One-liner (technical users, any platform):**
```bash
npx github:NTBooks/Fanad
```
This copies the app into `./fanad` (no clone needed — `--dir <path>` to change), opens the browser
setup wizard, installs dependencies, builds the web UI, and starts the server. Inside a checkout the
same CLI works as `npx fanad` (wizard if `.env` is missing, then start), `npx fanad setup`, or
`npx fanad start`.

**Windows installer (no Node needed):** download **`FanadSetup-<version>.exe`** from the releases
page and run it. The installer isn't code-signed yet, so SmartScreen shows an "unknown publisher"
warning — click **More info → Run anyway**. It installs Fanad under `%LOCALAPPDATA%\Fanad` with its
own private Node.js runtime (no admin rights, nothing added to PATH, your existing Node is
untouched) and adds **Fanad Setup** and **Start Fanad Server** to the Start Menu. Setup opens the
same browser wizard and writes `.env`; uninstalling keeps your data, settings, and encryption key.
To build the installer yourself, run `installer\build-installer.ps1` (needs
[Inno Setup 6](https://jrsoftware.org/isinfo.php): `winget install JRSoftware.InnoSetup`).

**Windows from a checkout:** double-click **`installer.bat`** — it opens a browser wizard (zero npm
dependencies, so it works before `npm install`) that asks for the essentials (Telegram token, LLM
provider, encryption key) and writes `.env`. If `.env` already exists it refuses; delete the file to
redo setup. Then double-click **`run.bat`**, which checks for Node 24+, installs dependencies and
builds the web UI on first run, and starts the server. (`npm run setup` launches the same wizard
from a terminal on any platform.)

**Home Assistant OS (add-on):** Fanad ships as a Home Assistant App (add-on) so it runs on the
same box as HA and appears in your sidebar via ingress (no ports to open, no reverse proxy).
In HA: **Settings → Apps → App store → ⋮ → Repositories** (Add-on store on older versions) → add
`https://github.com/NTBooks/fanad-ha`, then install and start Fanad. Data lives in `/data` and
rides along in HA backups. Running plain Docker instead? Same image:
```bash
docker run -p 8787:8787 -v fanad_data:/persist ghcr.io/ntbooks/fanad-app
```
Fanad itself is light (Node + SQLite, fine on a Pi 4); point it at an LM Studio or Ollama box
elsewhere on your network, or start with the `mock` provider and wire the model later.

Manual setup:
```bash
cp .env.example .env        # fill in as needed; .env is gitignored
npm install                 # installs server + web (workspace) deps
npm run build               # build the React/Vite frontend
npm run dev                 # start the server (serves API + built frontend)
# in another terminal during UI work:
npm run web:dev             # Vite dev server with /api proxy
```

## Layout
```
server/   Node + Express: ingest pipeline, node:sqlite, LM Studio + weather services, RAG, scheduler
web/      React + Vite frontend (also the always-on web-chat channel)
shared/   enums/events shared by server + web
data/     local-only runtime state (SQLite DB, config) — gitignored
```

## Run it without a model (or test it)
No LM Studio yet? Set **`LLM_PROVIDER=mock`** (and `EMBED_PROVIDER=mock`) in `.env` to run with a
built-in deterministic stub classifier — handy for trying the flow before wiring up a real model.
Run the tests with **`npm test`** (Node 24; on Node 22.5–23 use `node --experimental-sqlite --test test/`).

Working today: text a snippet → it's classified into a categorized task → manage it on the
Available / In progress / Done board → ask **"What should I do?"** for a data-grounded pick → finish it.
Gentle by design — no streaks, no guilt.

**Setup is in-app — no `.env` editing required.** Open the **⚙ Settings** screen to connect a model:
choose the provider (LM Studio is the easy local default), set the server address, hit **Test connection**
to list the loaded models, pick your **chat** and **embedding** models, and Save. Config is stored in the
app's database.

## Chat channels (optional)
Fanad also runs as a bot so you can capture from your phone. Enable a channel in **⚙ Settings** — tokens
are stored encrypted in the app's database (no `.env` editing required). Both channels expose the same
features (capture, task cards, buttons, reminders, lists, `.ics` export); the web chat is always on.

**Telegram.** Create a bot with [@BotFather](https://t.me/BotFather), copy its token, paste it into
**Settings → Telegram**, and Enable. (Long-polling — no public URL needed.)

**Slack.** Runs in **Socket Mode**, so no public URL or webhook is required (works behind NAT, like the
Telegram bot). Easiest setup is from a manifest at **[api.slack.com/apps](https://api.slack.com/apps)**:

1. **Create New App → From a manifest** → pick your workspace → paste the YAML below (it turns on Socket
   Mode, **interactivity** (required for the buttons), the scopes, events, and the DM Messages tab in one go).
   *(Already have an app? Paste the same YAML on its **App Manifest** page instead.)*
2. **Basic Information → App-Level Tokens → Generate Token** with the `connections:write` scope → copy the
   **`xapp-…`** token.
3. **Install App → Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-…`). Reinstall after any
   later manifest/scope change.
4. Paste both tokens into **⚙ Settings → Slack**, tick **Enable**, Save → you'll see **“Bot is live ✓”**.
   Then DM the bot. (Tokens may also be supplied via `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN`.)

<details><summary><strong>Slack app manifest (YAML)</strong></summary>

```yaml
display_information:
  name: Fanad
features:
  bot_user:
    display_name: Fanad
    always_online: true
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - im:history
      - im:write
      - im:read
      - reactions:write
      - reactions:read
      - files:write
      - files:read
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - message.im
      - reaction_added
      - reaction_removed
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
```
</details>

**Commands on Slack use `$`, not `/`.** Slack *reserves* a leading `/` (it’s swallowed client-side as a slash
command), so on Slack the command sigil is **`$`**. The bot shows `$`-prefixed commands everywhere (`$tasks`,
`$forget 3`, `$done_1`) and accepts them when you type them. Two ways to drive Fanad:
- **Tap the buttons** on cards — the primary path; always works.
- **Type a `$` command** (`$whatdo`, `$done 1`, `$forget 3`) — or drop the sigil entirely for the casual forms
  (`whatdo`, `done 1`, `mood 😴`), which also work.

(Telegram and the web keep the usual `/` sigil — the `$` swap is Slack-only.)

**Access (either channel).** Leave the allowlist blank and the **first person to message claims the bot**
(trust-on-first-use); everyone else is silently ignored. Or set an allowlist — Telegram `@handles`, Slack
user IDs (`Uxxxx`) or `@handles`. Any allowed user can grow the list with **`vouch @name`** in chat
(Slack: pick them from the `@` menu); revoke from **Settings → Access**.

## Modules (all opt-in)
Tasks are always on; everything else is a per-user module that starts **off**, so a fresh account
sees only the scratchpad. Type `modules` in chat to see what's available and toggle by tapping, or
`optin <name>` / `optout <name>`:

- **Notes** and nestable **Lists** (an outliner for packing lists, projects, shopping)
- **Metrics** (numbers you track in one line, with charts)
- **Timer** (one-shot server timers: "timer 12 min for the oven", from any phone in the family)
- **Diet** ("eat skyr 140cal" teaches a typical serving; foods, meals, recipes, reports,
  off-record "eat whatever" days)
- **Medication** (an adherence logger, not an advisor; templates + daily reminders)
- **Journal** (a trend journal with daily/weekly/monthly AI summaries)
- **Batches** (process runs with auto-versioned recipe templates)
- **Notebooks** (separate private sub-spaces with their own tasks, notes, and lists)
- **Home Assistant** (below)

The owner can also enable or disable any module system-wide for the whole install (the `system`
command, or Settings). Everyday safety net: `undo` (or a bare `u`) takes back the last thing the
bot did, app-wide.

## The web app
The web chat is always on and everything the bots do works there too, plus GUI views a phone can't
do: a **kanban board** for tasks, notes wall, metric charts, lists outliner, templates, diet report
with inline edits, the journal, and batches (each view toggles GUI/Text), with themes (including
the pixel-sim day/night Ocean) and wide-screen side panels. From Telegram or Slack, type `/web`
for a one-time sign-in link that opens the browser already signed in as you.

**Web login is optional.** By default there's no login (fine on localhost or a trusted LAN). Turn
it on in Settings → Security to expose the UI beyond that: scrypt passwords plus mandatory TOTP
2FA, database-backed sessions, an optional IP allowlist and registration toggle. It's also the
prerequisite for speed-dial share links (below).

**Terminal client.** Type `cmd` in any chat and Fanad mints a ready-to-paste
`npx github:NTBooks/Fanad <server> <token>` line: a full-screen chat client in your console, no
checkout needed. Owner opt-in; tokens are minted with an expiry you choose and revocable in
Settings → Security.

## Backup & restore
Set `BACKUP_MODE=1` and Settings → Data & privacy grows a **Backup** button that downloads the
whole installation as one zip (database, uploads, optionally the encryption key). Restore it onto
a fresh box by dragging the zip into the setup wizard, or with `npm run restore`. (On HA OS,
native Home Assistant backups already cover `/data`.)

## Home Assistant (optional module)
Wherever Fanad runs (as the HA add-on or on any other box), it can bridge to your Home Assistant.
Opt in with `optin ha`; the owner pairs HA once in **⚙ Settings → Home Assistant** (paste the HA URL
plus a long-lived access token from your HA profile's *Security* page; stored encrypted like every
other secret), then `ha test` rings every output to prove the wiring.

- **Your dings ring the house.** HA has no reminders that survive a restart; Fanad does. Timers and
  reminders you set here also announce on voice satellites/media players, can fire a script you name
  (wire a siren or lights there), and push to phones via the HA companion app.
- **`ha <command>` from anywhere.** Anything after `ha` goes verbatim to your own HA Assist agent
  (`ha turn off the kitchen light`, `ha run goodnight`). Remote control through Telegram's outbound
  connection: no open ports, no cloud tunnel. `/ha` shows connection status.
- **`ha cal <n>`** pushes a dated task onto a house calendar (needs HA's *Local Calendar*
  integration and a calendar picked in Settings).
- **Dashboards (the other direction).** `GET /api/ha/summary` is a read-only JSON bundle for HA REST
  sensors: open tasks, due today, overdue, next deadline, plus a block per enabled module. Counts
  and timestamps only unless you add `?titles=1`. Pair it with a read-only token (type `token` in
  any chat, or Settings → Security), which can never post or change anything. `GET /api/stream`
  (SSE, same token) emits a `counts` event when the numbers change, so you can skip polling.

Fanad never reads your house: no sensors, no presence. The house is an output, not an input, and
house commands are deterministic passthrough to your own Assist agent, never model output.

### Speed Dial: give someone a few house buttons
Owner-managed pads of numbers `0`–`9`, each mapped to one HA command you write. The pad-holder sends
(or taps) a digit and only that command runs: how you hand a houseguest, a kid, or a roommate a few
house controls without the run of your whole Home Assistant. Pad-holders never get free-text
`ha <command>`, so their words never reach HA.

- `sd @sam 1 = Kitchen | turn off the kitchen lights` sets a number (label optional);
  `sd @sam limit on` locks that account to the pad only; `sd @sam test 1` test-fires it;
  `sd` lists every pad. Or manage it all in **Settings → Access** (expand an account's row).
- **Toggles:** give a number an optional second *OFF* command and one button turns the device on,
  then off, alternating each press, on every surface.
- **Remote-control links (no Telegram needed):** generate a no-login web link (1/7/30-day expiry,
  revocable) from a person's row and text it to a guest; they get a simple page of just their
  buttons. Requires web login to be enabled, so the rest of the app stays locked.
- **Local accounts:** for family who don't use Telegram at all, add a *local* account (a name, not
  an @handle). It's pad-only, never reaches the bot, and its remote link may be minted
  never-expiring: the link is their account. Each row also prints a 🖨 hand-out card of their
  numbers, like an old speed-dial card.

## Docs
The full **[manual](https://ntbooks.github.io/Fanad/manual.html)** and printable
**[cheat sheet](https://ntbooks.github.io/Fanad/cheatsheet.html)** are published from `site/` via
GitHub Pages, and the app serves them itself too (📖 in the web header; `/manual` in chat answers
questions straight from the book). Running on Home Assistant? Start at the
**[HA guide](https://ntbooks.github.io/Fanad/hacs.html)**.

## Privacy
Everything stays on your machine. The only outbound calls are to your local model server, your own
Home Assistant if you pair it, and (optionally) a weather API and the chat channels you enable.
No cloud, no telemetry. Secrets (chat tokens, API keys) are stored encrypted (AES-256-GCM).
BYO cloud model keys exist for people without local-model hardware, but they only work behind an
explicit `LLM_ALLOW_CLOUD` flag: off by default, hard-blocked at runtime, hidden in the UI when
off. `/requestdeletion` in chat erases an account completely (confirm-gated, with an optional
export first).

## License
[MIT](LICENSE). Do what you like — self-host, modify, redistribute; just keep the copyright notice.
