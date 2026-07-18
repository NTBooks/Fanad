# Changelog

All notable changes to Fanad are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
