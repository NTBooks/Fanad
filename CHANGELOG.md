# Changelog

All notable changes to Fanad are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.1] - 2026-07-19

### Added
- Shareable no-login "remote control" links: the host can mint a link (`/r/<token>`) that exposes just
  one guest's speed-dial pad (its 0-9 buttons) as a responsive page, hand it to someone with no Telegram
  account or login, and revoke it any time. Fail-closed by design: minting and use both require web login
  (auth mode `simple`), only the predefined pad slots fire, requests are per-token rate limited and
  noindex/no-store, and the share token authenticates nothing on the API. Manage them in Settings, Access:
  1 / 7 / 30-day expiry, an optional label, and an active-link list with revoke.

## [0.5.0] - 2026-07-19

### Added
- Home Assistant notebook selector: the read endpoints accept `?notebook=<id|main>`, so a read-only
  token can pull a specific owned notebook's data without switching the account's current notebook.
  A Home Assistant dashboard can now offer a notebook picker. Reads only; unknown or foreign ids fall
  back safely to the account's own current space.
- Speed dial in the web sidebar: a pad-holder's 0-9 pad now appears at the top of the wide-screen left
  hint bar, and each row sends "dial N". A bare "0" is the reserved "show my pad" key.

### Changed
- Zero-checkout CLI connect: the connect line handed back with a token is now
  `npx github:NTBooks/Fanad <server> <token>`, so the CLI client runs from a fresh terminal (Node 24+)
  with nothing pre-installed. npx fetches, caches, and builds it on first run.
- A full-account pad-holder now sees their speed-dial pad alongside their normal first reply, rather
  than the pad replacing that first message.

### Fixed
- A locked-down (speed-dial-only) account is now denied `vouch` in the central access gate, so it
  cannot grow the whitelist beyond its own lockdown.

## [0.4.0] - 2026-07-19

### Added
- Self-service access token: the chat `token` command (also `create` / `new` / `mint` / `get token`)
  mints a read-only, never-expiring claim token scoped to your own account, behind a yes/no confirm
  with a warning. It is the credential a Home Assistant dashboard needs to read your Fanad data, so
  any authorized user can now get one without the owner-only web panel. Shown once.
- Web Settings, Security: an "Expires" dropdown (30 / 90 / 365 days / Never) when minting a token,
  exposing the never-expiring option the backend already supported.

## [0.3.0] - 2026-07-19

### Added
- **Medication module** (opt-in): a calm adherence logger modeled on the Diet module. Log
  doses, keep per-medication metrics (hidden from the daily tally), set up templates and daily
  reminders, and review it all in a web view. A logger, not an advisor.
- **Speed dial** (owner-curated Home Assistant pads): program another Telegram account's 0-9
  pad, mapping each slot to a Home Assistant command you authored. They send a bare digit (or
  tap a button) and it fires only that command. An optional "speed-dial only" lock restricts an
  account to its pad, with no tasks or chat.
- First-run reaction demo in the web UI: a self-playing reel that teaches the "command pad, not
  a chatbot" model, with a replay button.
- Browser (non-Telegram) demo signup: the signup link opens the create-account panel directly.
- The docs site (brochure, manual, cheatsheet, how-tos) is now published to GitHub Pages.

### Changed
- The web shortcut legend nests sub-shortcuts under their parent for a cleaner map.

### Fixed
- The reaction-demo reel runs slower and pauses on hover or focus.
- Stale quick-reply chips are cleared on a contentless acknowledgement.

## [0.2.1] - 2026-07-18

### Home Assistant
- Add-on auto-pairing: when running as a Home Assistant App, Fanad reaches HA core through the
  Supervisor proxy using the injected `SUPERVISOR_TOKEN` — so ringing the house works with no
  long-lived token to paste. A URL/token set in Settings still overrides it.

## [0.2.0] - 2026-07-18

First public release.

### Core
- Local-first capture → classify → act loop: text short snippets and a local LLM
  (LM Studio or Ollama) classifies them; every suggestion is grounded in your own
  data, never invented.
- Tasks board (Available / In progress / Done), notes, nestable lists, one-shot
  timers, and light journaling — all opt-in per user.
- SQLite storage via the native `node:sqlite` (no C++ addon); secrets encrypted
  at rest (AES-256-GCM) under a key-encryption key.
- Cloud LLM providers are hard-gated off by default (`LLM_ALLOW_CLOUD`); local
  providers keep everything on your machine. No telemetry.

### Channels
- Always-on web chat + rich web UI.
- Telegram bot (long-polling, no public URL).
- Slack bot (Socket Mode).

### Home Assistant
- Read-only `GET /api/ha/summary` aggregate endpoint for HA dashboards, with
  read-only claim tokens and a debounced `counts` SSE poke.

### Distribution
- `npx github:NTBooks/Fanad` one-liner and a Windows installer.
- MIT licensed.

[0.2.1]: https://github.com/NTBooks/Fanad/releases/tag/v0.2.1
[0.2.0]: https://github.com/NTBooks/Fanad/releases/tag/v0.2.0
