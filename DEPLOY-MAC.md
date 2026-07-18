# Deploy Fanad on a Mac mini (always-on home server)

A copy-pasteable guide to run Fanad and LM Studio together on a Mac mini that
stays on 24/7, reachable from your phone and laptop over the LAN and via Telegram.

> Conventions: commands prefixed `$` run in **Terminal.app** on the Mac mini.
> Replace `<...>` placeholders with your own values. Lines tagged ⚠️verify may have
> drifted since this was written — confirm against the current LM Studio / tool docs.

---

## 0. What you're building

```
            ┌────────────────────────── Mac mini (always on) ──────────────────────────┐
            │                                                                            │
 phone ─────┤  LM Studio server  :1234  ◄──── chat model + embedding model (in memory)  │
 laptop ────┤        ▲                                                                   │
 (LAN /     │        │ http://127.0.0.1:1234/v1                                          │
  Tailscale)│  Fanad Node server  :8787  ── serves API + built React web UI        │
            │        │                                                                   │
            │        └── data/  (one SQLite file: chats, embeddings, config)             │
            └────────────────────────────────────────────────────────────────────────────┘
                     ▲                                   ▲
       Telegram bot ─┘ (grammY long-polling,            └─ web UI in a browser
       outbound only — NO inbound ports)
```

The Mac mini is the **single always-on host**. It runs **both** LM Studio (the local
LLM, providing a chat model and an embedding model) **and** the Fanad Node server.
Everything is local: your data lives in one SQLite file under `data/`, and no cloud LLM
is involved. You reach it two ways:

- **Web UI** over your LAN at `http://<mac-mini-ip>:8787` (or via Tailscale off-LAN).
- **Telegram**, which uses outbound long-polling — so it works from anywhere with **no
  inbound ports, no port-forwarding, no firewall holes**.

---

## 1. Prep the Mac mini

Goal: a headless box that auto-logs-in, never sleeps, and comes back after a power blip.

### Auto-login (so apps restart unattended after reboot)
**System Settings → Users & Groups → Automatically log in as → `<your user>`.**
(If FileVault is on, full-disk encryption blocks auto-login at boot — for a headless
home server you generally want FileVault **off**, or you must type the password at every
boot. Decide based on your threat model.)

### Prevent sleep (critical — a sleeping mini = dead server)
GUI: **System Settings → Energy** (or **Battery** on laptops) → set **"Turn display off
after"** as you like, but ensure **"Prevent automatic sleeping when the display is off"**
is enabled, and disable any "Put hard disks to sleep".

Then make it bulletproof from the CLI:

```bash
# Never sleep; actively disable idle sleep even with no display attached
$ sudo pmset -a sleep 0
$ sudo pmset -a disablesleep 1
# Optional: also keep disk + display awake while on power
$ sudo pmset -a displaysleep 0 disksleep 0

# Verify
$ pmset -g
```

### Restart automatically after a power failure
GUI: **System Settings → Energy → "Start up automatically after a power failure"** (ON).
Or CLI:

```bash
$ sudo pmset -a autorestart 1
```

### Running headless
The mini can run with no monitor/keyboard. To administer it remotely:

```bash
# Enable SSH (Remote Login)
$ sudo systemsetup -setremotelogin on
# then from another machine:
#   ssh <user>@<mac-mini-ip>
```

For occasional GUI access (LM Studio is a GUI app), enable **System Settings → General →
Sharing → Screen Sharing**, then connect with macOS **Screen Sharing** / VNC. A
cheap **HDMI dummy plug** can help if an app refuses to render headless, but is rarely
needed here.

Find the mini's LAN IP (you'll use it a lot):

```bash
$ ipconfig getifaddr en0    # Ethernet
$ ipconfig getifaddr en1    # Wi-Fi (try en0 first; pick whichever returns an IP)
```

> Tip: reserve that IP as a **DHCP static lease** in your router so it never changes.

---

## 2. Install Node 24

Fanad uses the built-in `node:sqlite` module, which is **unflagged only on Node ≥ 24**.
You must end up with `node -v` reporting **v24.x or newer**. Pick one method.

**A. Official installer (simplest):** download the macOS `.pkg` from
<https://nodejs.org> (choose the "24" line) and run it.

**B. Homebrew:**
```bash
$ brew install node@24
# Homebrew keeps versioned formulae unlinked; link it onto PATH:
$ brew link --overwrite --force node@24
```

**C. nvm (if you juggle Node versions):**
```bash
$ curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash   # ⚠️verify version
$ source ~/.zshrc
$ nvm install 24
$ nvm alias default 24
```

Verify:
```bash
$ node -v      # must print v24.x.x or higher
$ npm -v
```

> If you use **nvm**, the launchd job in §5 won't see nvm's shell setup. Use the **full
> path** to the node binary in the plist (find it with `which node` →
> e.g. `~/.nvm/versions/node/v24.x.x/bin/node`). The installer/Homebrew put node at a
> stable path (`/usr/local/bin/node` or `/opt/homebrew/bin/node`), which is simpler for launchd.

---

## 3. Install LM Studio (chat + embedding models)

Fanad needs **two** models loaded at once: a **chat** model and an **embedding**
model.

### Install
- Download from <https://lmstudio.ai> and drag to Applications, **or**
  ```bash
  $ brew install --cask lm-studio        # ⚠️verify cask name
  ```

### Pick models sized to the mini's unified memory
The Mac mini shares one pool of unified memory between OS, app, and model weights. Leave
headroom (the OS + LM Studio itself need several GB), and remember **both** models load
simultaneously. Rough guidance (⚠️verify exact RAM fit per quant):

| Unified memory | Chat model (approx)          | Embedding model        |
|----------------|------------------------------|------------------------|
| 16 GB          | ~7–8B, Q4 quant              | `nomic-embed-text`     |
| 24–32 GB       | ~12–14B, Q4                  | `nomic-embed-text` / `bge` |
| 64 GB+         | larger (e.g. 24–32B) Q4/Q5   | larger embedder OK     |

In the LM Studio UI: open the **search / discover** tab, download one chat model and one
embedding model (search "nomic-embed-text" for a solid small embedder). Note the **exact
model identifier** LM Studio shows for each — you'll paste these into `.env` as
`LMSTUDIO_CHAT_MODEL` and `LMSTUDIO_EMBED_MODEL`.

### Start the server + serve on the LAN
In LM Studio: go to the **Developer / Local Server** tab → **Start Server** (default port
**1234**) → enable **"Serve on Local Network"** so other devices (and the launchd job)
can reach it. Load **both** models so they're resident.

Confirm it answers:
```bash
$ curl http://127.0.0.1:1234/v1/models
```
You should see both your chat and embedding model ids listed.

### Headless / always-on with the `lms` CLI
For an unattended server you don't want to depend on the GUI being open. LM Studio ships
a CLI, `lms` (bootstrap it once from the app, or):

```bash
$ ~/.lmstudio/bin/lms bootstrap        # adds `lms` to PATH; restart shell   ⚠️verify path
```

Then (all ⚠️verify — confirm flags with `lms --help`):

```bash
$ lms server start                     # start the local server headless
$ lms server status                    # check it's up
$ lms load <chat-model-id>             # load chat model into memory
$ lms load <embed-model-id>            # load embedding model
$ lms ps                               # list loaded models
```

To make LM Studio's server survive reboots headlessly, either keep the LM Studio app in
**Login Items** (System Settings → General → Login Items) with "start server on launch"
enabled, or run `lms server start` + `lms load ...` from a small launchd agent of your own.
The simplest reliable setup for most people: add **LM Studio to Login Items**, enable its
**"Start the local server when the app launches"** option, and ensure both models are set
to auto-load. ⚠️verify these toggle names against your LM Studio version.

---

## 4. Install & run Fanad

```bash
# Get the code (clone, or copy the folder onto the mini)
$ git clone <your-fanad-repo-url> ~/Fanad
$ cd ~/Fanad

# Create your env file from the template
$ cp .env.example .env
$ nano .env        # fill values (see below), then Ctrl-O Ctrl-X to save
```

Fill in `.env`. The keys that matter (others can stay as-is):

```ini
PORT=8787
NODE_ENV=production

# Long random string — generate one:  openssl rand -hex 32
SESSION_SECRET=<paste-a-long-random-string>

# LM Studio — base URL is correct as-is; paste the EXACT model ids from §3
LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1
LMSTUDIO_CHAT_MODEL=<chat-model-id>
LMSTUDIO_EMBED_MODEL=<embed-model-id>
LMSTUDIO_API_KEY=lm-studio

# Weather — Open-Meteo needs no key; leave provider as open-meteo
WEATHER_PROVIDER=open-meteo
OPENWEATHER_API_KEY=

# Telegram (optional) — token from @BotFather; leave blank to disable Telegram
TELEGRAM_BOT_TOKEN=<bot-token-or-blank>

# Email magic links — leave blank in dev/home use to log the login link to the console
RESEND_API_KEY=
MAGIC_LINK_FROM=
```

> Get a Telegram token: open Telegram, message **@BotFather**, send `/newbot`, follow the
> prompts, copy the token it gives you into `TELEGRAM_BOT_TOKEN`.
>
> Weather location: Fanad uses Open-Meteo (no key). Set your location/ZIP in the app
> UI after first login (the home/profile area) rather than in `.env`.

Build the web frontend and start the server:

```bash
$ npm install
$ npm run build        # builds the web/ React app into static assets
$ npm start            # serves API + built frontend on PORT (8787)
```

Open **<http://localhost:8787>** on the mini (or `http://<mac-mini-ip>:8787` from another
device). On first run with no Resend key, the magic-link login URL is **printed to the
console** — copy it from the terminal to log in.

The npm scripts use `node --env-file-if-exists=.env`, so `.env` is loaded automatically —
no extra dotenv step. Stop with `Ctrl-C` (once you've confirmed it works, move on to §5 to
keep it running forever).

---

## 5. Keep it always-on (launchd)

We'll run Fanad as a per-user **LaunchAgent** so macOS restarts it on boot and if it
ever crashes. (LM Studio's server is kept up separately — see §3.)

Create `~/Library/LaunchAgents/com.fanad.app.plist` with this content. **Edit the two
absolute paths** (`<USER>` and the node binary path from `which node`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.fanad.app</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>--env-file-if-exists=.env</string>
        <string>server/index.js</string>
    </array>

    <!-- Run from the repo so .env and data/ resolve relative to it -->
    <key>WorkingDirectory</key>
    <string>/Users/<USER>/Fanad</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>

    <!-- Logs -->
    <key>StandardOutPath</key>
    <string>/Users/<USER>/Library/Logs/fanad.out.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/<USER>/Library/Logs/fanad.err.log</string>
</dict>
</plist>
```

> The first `ProgramArguments` string is the **node binary path**. Confirm yours with
> `which node`:
> - Apple-Silicon Homebrew → `/opt/homebrew/bin/node`
> - Intel Homebrew / nodejs.org installer → `/usr/local/bin/node`
> - nvm → the full `~/.nvm/versions/node/v24.x.x/bin/node` path
> Use an **absolute** node path here; launchd does not load your shell profile.

Load and start it:

```bash
# Load (modern syntax). 'gui/<uid>' targets your logged-in session.
$ launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.fanad.app.plist
# or the classic form:
$ launchctl load ~/Library/LaunchAgents/com.fanad.app.plist

# Force it to start right now / restart after editing the plist
$ launchctl kickstart -k gui/$(id -u)/com.fanad.app

# Check status / tail logs
$ launchctl print gui/$(id -u)/com.fanad.app | head -n 30
$ tail -f ~/Library/Logs/fanad.err.log
```

To stop / unload (e.g. before an update):
```bash
$ launchctl bootout gui/$(id -u)/com.fanad.app
# or: launchctl unload ~/Library/LaunchAgents/com.fanad.app.plist
```

> Keep **LM Studio's server** up too (§3): app in Login Items with "serve on launch", or
> your own `lms server start` agent. Fanad will fail chat/embeddings if LM Studio
> isn't running.

### Alternative: pm2
If you prefer a Node process manager:

```bash
$ npm install -g pm2
$ cd ~/Fanad
$ pm2 start "npm start" --name fanad
$ pm2 save
$ pm2 startup        # prints a sudo command — run it to install the boot launchd item
```

(Use **either** launchd **or** pm2, not both, or two copies will fight over port 8787.)

---

## 6. Access it

### On the LAN (home)
From any device on the same network:
```
http://<mac-mini-LAN-IP>:8787
```
e.g. `http://192.168.1.50:8787`. Bookmark it on your phone.

### Telegram (works anywhere, no networking setup)
With `TELEGRAM_BOT_TOKEN` set, Fanad uses **grammY long-polling** — the mini reaches
out to Telegram, so there are **no inbound ports to open** and it works from outside your
home with zero firewall/router changes. Just message your bot. Ideal for a home server.

### Secure access off the LAN — use Tailscale (recommended)
Do **not** port-forward 8787 to the public internet. Instead put the mini on a private
mesh VPN:

```bash
$ brew install --cask tailscale        # ⚠️verify cask name
# launch Tailscale, sign in, then on the mini:
$ tailscale ip -4                      # shows the mini's 100.x.y.z address
```
Install Tailscale on your phone/laptop, sign in to the **same account**, and reach the mini
at `http://<tailscale-100.x.y.z>:8787` from anywhere — encrypted, no ports exposed.
(Optionally `tailscale serve` to put it behind HTTPS. ⚠️verify command.)

**Cloudflare Tunnel** is an alternative if you want a public hostname without exposing
ports (`cloudflared tunnel ...`) — more setup; Tailscale is simpler for personal use.

---

## 7. Maintain

### Update to a new version
```bash
$ cd ~/Fanad
$ launchctl bootout gui/$(id -u)/com.fanad.app    # stop (or: pm2 stop fanad)
$ git pull
$ npm install
$ npm run build
$ launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.fanad.app.plist
$ launchctl kickstart -k gui/$(id -u)/com.fanad.app   # relaunch
# pm2 equivalent:  pm2 restart fanad
```

### Back up your data
All state is a SQLite file in `~/Fanad/data/`. Back it up regularly:

```bash
# Quick consistent copy (safe even while running):
$ sqlite3 ~/Fanad/data/<dbfile>.db ".backup '~/Backups/fanad-$(date +%F).db'"
# (find the filename with:  ls -la ~/Fanad/data/ )
```
Also enable **Time Machine** on the mini so `data/` is captured automatically. To migrate
to a new machine, copy the whole `data/` folder and your `.env`.

### Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Chat/answers error; logs say connection refused to `:1234` | **LM Studio unreachable.** Confirm `curl http://127.0.0.1:1234/v1/models` works; restart LM Studio's server (`lms server start`) and ensure "Serve on Local Network" is on. |
| Replies fail or embeddings error, but server is up | **No model loaded.** `lms ps` should list both your chat and embed models. Load them, and check the ids match `LMSTUDIO_CHAT_MODEL` / `LMSTUDIO_EMBED_MODEL` in `.env`. |
| `EADDRINUSE: :8787` on start | **Port in use.** Another copy is running. `lsof -i :8787` then `kill <pid>`, or you're running launchd **and** pm2 — keep only one. Change `PORT` if 8787 is genuinely taken. |
| App didn't come back after reboot | **Launchd job not loaded.** `launchctl print gui/$(id -u)/com.fanad.app`. Check `~/Library/Logs/fanad.err.log`. Common causes: wrong node path in the plist, wrong `WorkingDirectory`, or `auto-login` is off so the GUI session (and the LaunchAgent) never started. |
| `node:sqlite` errors / "module not found" | **Node too old.** `node -v` must be ≥ 24; the launchd plist must point at the v24 binary, not an older one on PATH. |
| Web UI loads but login link never arrives | In home/dev use the **magic link is printed to the console** — check `~/Library/Logs/fanad.out.log`. Set `RESEND_API_KEY` + `MAGIC_LINK_FROM` only if you want emailed links. |
| Can't reach it from another device | Confirm both are on the same LAN and you used the mini's IP (`ipconfig getifaddr en0`), not `localhost`. For off-LAN use Tailscale (§6). |

---

*Built for a Mac mini home server: LM Studio + Fanad, always on, reachable over LAN
and Telegram.*
