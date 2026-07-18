# Deploying Fanad to Coolify (Nixpacks)

Fanad deploys as a single process (Express API + the built React frontend) from a **private GitHub
repo**, built with **Nixpacks**. The container filesystem is **ephemeral** — the SQLite DB and the
encryption key only survive redeploys if you map a **persistent volume**. That, plus a few env vars, is
the whole job.

Files in the repo that make this work:
- [`nixpacks.toml`](nixpacks.toml) — pins **Node 24** and the build/start commands (see note below).
- [`.dockerignore`](.dockerignore) — keeps `node_modules`, `.env`, `data/`, and `*.kek` out of the build.

> **Why `nixpacks.toml` is required:** Nixpacks' Node provider otherwise falls back to **Node 18**, which
> doesn't have the built-in `node:sqlite` module this app uses (it'd crash on boot). The toml pins
> `nodejs_24` from a nixpkgs archive that contains it. **Verified locally:** Nixpacks builds the image,
> it runs Node 24, boots in production with a volume, and `/api/health` reports `persist.mounted: true`.

---

## 1. Create the application

1. In Coolify: **Project → New Resource → Application**.
2. **Source = Private Repository (with GitHub App)** — recommended. Install the Coolify GitHub App on
   the repo so Coolify can clone it and auto-deploy on push.
   - Alternative: **Private Repository (with deploy key)** — add Coolify's generated SSH key as a
     read-only **Deploy key** on the repo (GitHub → Settings → Deploy keys).
3. **Build Pack = Nixpacks** (the default). Coolify will pick up `nixpacks.toml` automatically.
4. **Branch** = `main` (or whichever you deploy from).

## 2. Port & domain

- **Ports Exposes = `8787`** (the app's default `PORT`).
- Set a **Domain** (e.g. `https://fanad.yourdomain.com`). Coolify's proxy terminates TLS and forwards
  to `8787`.
- **Health check path = `/api/health`** (returns `200` JSON, no auth).

## 3. Persistent storage  ← the important part

The DB (`fanad.db`), the encryption key file (`data.kek` when no `KEK` env is set), and `config.json`
all live under one directory. Map a volume so they survive redeploys. (Captured photos are NOT stored on
disk — they stay on Telegram and the DB keeps only a reusable `file_id` reference.)

In **Storages → Add → Volume Mount**:
- **Name:** `fanad-persist` (any name)
- **Mount Path:** `/persist`

A Nixpacks image runs as **root**, so either a Docker Volume or a host Bind Mount works with no
permission fuss. The Docker Volume (default) is simplest.

The app **fails fast on boot in production if `/persist` isn't mounted** — it refuses to silently write
to ephemeral storage. If the first deploy crashes with *"PERSIST_DATA directory ... does not exist"*,
the volume mount is missing — add it and redeploy.

Everything lands under the volume:
- `/persist/data/fanad.db` — database
- `/persist/data.kek` — bootstrap encryption key (only when `KEK` env is unset)
- `/persist/data/config.json`

## 4. Configuration: what goes in env vs. what you set in the app

Most "secrets" are **not** Coolify env vars. The **LLM provider/base-URL/model/API-key** and the
**Telegram bot token** are set in the app's **Settings UI** after it's running — they're stored
**encrypted** (under the `KEK`) in the DB on the `/persist` volume. The matching env vars exist only as
an optional fallback/bootstrap; the in-app values win.

### Env vars you DO set in Coolify (under **Environment Variables**)

These can't be set in the UI. (`NODE_ENV=production` is set by Nixpacks automatically.)

| Variable | Value | Why |
|---|---|---|
| `PERSIST_DATA` | `/persist` | Matches the volume mount (also the default). |
| `KEK` | base64 of 32 random bytes | The key everything else is encrypted under. **Set this BEFORE entering any secrets in the UI**, so they're encrypted under a real off-box key, not the on-box bootstrap key. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. (Blank = auto bootstrap key on the volume; protects DB-only leaks, not server theft. Adding `KEK` later re-keys everything on next boot.) |
| `TRUST_PROXY` | `1` | Behind Coolify's proxy, `req.ip` is otherwise the proxy container — the **web IP allowlist** and the **login rate limit** need the real client address. Also lets the session cookie pick up `Secure` over https. |
| `LLM_ALLOW_CLOUD` | `1` | **Only if you want a cloud LLM.** Gate flag — without it, cloud providers don't even appear in Settings and are hard-blocked at runtime. Leave unset for local-only. |
| `RESEND_API_KEY` + `MAGIC_LINK_FROM` | from Resend | Real email magic links (not UI-settable). Blank = links are logged to the server console. |
| `USER_IMPERSONATION` | `1` | Only for a single-operator host. **Leave OFF on anything networked** — the web layer has no auth, so ON lets any client act as any user. |

> **Do NOT set** `SETUP_MODE` (force-disabled in prod anyway) or `DEBUG_LOG` (would expose raw server
> logs to any client) in production.

### Web login (recommended on any networked deploy)

The web UI ships **open** (auth mode `none` — anyone who can reach the URL is the root user). On a
networked deploy, turn on the built-in login:

1. Deploy, open the web UI, go to **Settings → Security**.
2. Set a **username + password**, then **Enroll 2FA** — scan the QR with an authenticator app
   (Google Authenticator, Authy, 1Password…) and verify a code. 2FA is **required**, not optional.
3. Flip **Auth mode** to `simple` (the dropdown unlocks only once the credentials above are complete —
   no self-lockout). Your current tab stays signed in; every other client now gets a login screen.
4. Optional: tick **Allow new users to register** to let others create their own (fully separate)
   accounts, and/or add a **Web IP allowlist** (one IP/CIDR per line; `localhost` always works;
   `/api/health` stays open for Coolify's healthcheck). Set `TRUST_PROXY=1` or the allowlist will see
   the proxy's IP instead of the client's.

Telegram/Slack channels are not affected by web login. Only the root user can change Settings while
login is on.

**Locked out** (lost authenticator, lost KEK)? Set env `AUTH_RESET=1` and redeploy/restart: web login is
forced off (credentials and 2FA are preserved), letting you back into Settings. Remove the var afterwards.
Alternatively `AUTH_MODE` (`none`|`simple`) seeds the default mode before any in-app choice is made.

### Configured in the app's Settings UI (persisted, encrypted, on the volume)

- **LLM provider, base URL, chat/embed models, API key.** The default targets LM Studio on
  `127.0.0.1:1234`, which **does not exist on the Coolify host** — so decide this before real use:
  - **Your own LM Studio over the network:** provider `lmstudio`, base URL
    `http://<your-lmstudio-host>/v1` (verify it's live; an embedding model must be loaded for RAG).
  - **A cloud provider:** set `LLM_ALLOW_CLOUD=1` in env first, then pick openai/gemini and paste the key.
  - **Ollama** somewhere reachable: provider `ollama`, base URL `http://<host>:11434/v1`.
- **Telegram bot token** (from @BotFather) — paste it in Settings to enable the Telegram channel.

> You *can* still seed any of these via env on first boot (`LLM_PROVIDER`, `LMSTUDIO_BASE_URL`,
> `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, …) — handy for a hands-off deploy — but the UI is the normal
> path and overrides env once set.

## 5. Deploy & verify

1. Click **Deploy**. The first Nixpacks build downloads the Node 24 nix package and runs `npm ci` — a
   few minutes; later builds are cached.
2. Open `https://<your-domain>/api/health`. You want:
   - `"ok": true`
   - `"persist": { "mounted": true }` — **confirms the volume is wired up.**
   - `"encryptsSecrets": true` — stored secrets are encrypted at rest.
   - `"llm": { "reachable": true, "ok": true }` — your provider answers and has a model loaded.

   Health is deliberately terse — it's unauthenticated, so it reports booleans only. The full detail
   (data dir, KEK source: `env` if you set `KEK` — best — or `temp` for the bootstrap key) is printed
   in the app log on every boot: Coolify → your app → **Logs**, look for the `[startup]` line.
3. Open the domain root to load the web UI.

## 6. Redeploys, backups, moving hosts

- **Redeploys** rebuild the image; the `/persist` volume is untouched, so data persists.
- **Backup, the easy way:** set env `BACKUP_MODE=1`, redeploy, and download the whole instance
  (DB + settings + photos, optionally the key file) from **Settings → Data & privacy → Backup** as one
  zip. Turn the flag back off afterwards — while it's on with web login off, anyone reaching the app can
  download everything. Details in the manual under *Instance backup & migrate*.
- **Backup, by hand** = copy the whole `/persist/data` directory **plus** `/persist/data.kek` (if using
  the bootstrap key). The DB alone isn't enough — encrypted secrets can't be read without the key.
- **Restoring a backup zip here** (no setup wizard on a container): stop the app, then in the container's
  terminal run `npm run restore -- /persist/backup.zip` (upload the zip to the volume first, e.g. via
  Coolify's terminal) and start it again. Env decides where it lands (`PERSIST_DATA`/`DATA_DIR`); an
  existing data dir is renamed aside, never deleted. If the source used an env `KEK`, set the same `KEK`
  here — the backup never contains it.
- **Moving servers:** copy the entire `/persist` contents to the new volume (or use the backup zip
  above). If you migrate to an env `KEK`, set it and redeploy — the app re-keys every secret on boot and
  retires the bootstrap file.

## Maintaining the Node pin

`nixpacks.toml` pins `nodejs_24` via `nixpkgsArchive = ac62194c…` (the nixos-25.05 channel). If you ever
need a newer Node, bump that archive to a nixpkgs commit that has the version you want, or drop the pin
once Coolify's bundled Nixpacks supports your target Node version natively (test with `nixpacks plan .`).
