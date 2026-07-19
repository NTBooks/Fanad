# Changelog

All notable changes to Fanad are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
