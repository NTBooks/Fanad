# Fanad

[![CI](https://github.com/NTBooks/Fanad/actions/workflows/ci.yml/badge.svg)](https://github.com/NTBooks/Fanad/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A **local-first, local-LLM RAG life-OS**. You text short snippets to your "future self" (web chat,
Telegram, or Slack); a local LLM you configure (LM Studio) classifies them, and every suggestion is
**grounded in your own data** — the model only ranks and phrases real rows it's given, never invents.
It addresses you as **PastSelf**.

> Status: functional and heavily tested (1,100+ automated tests), in daily use by its author and
> under active development. Single maintainer — expect fast iteration and the occasional rough edge.

## Prerequisites
- **Node 24+** (uses the native built-in `node:sqlite` — no C++ addon; unflagged on Node 24).
- **[LM Studio](https://lmstudio.ai)** running its local server with a chat model **and** an
  embedding model loaded (Developer tab → Start Server).

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

## Privacy
Everything stays on your machine. The only outbound calls are to your local LM Studio and (optionally)
a weather API and the chat channels you enable. No cloud, no telemetry.

## License
[MIT](LICENSE). Do what you like — self-host, modify, redistribute; just keep the copyright notice.
