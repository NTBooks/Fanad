# Fanad → Home Assistant Sensor Guide

*A practical runbook for wiring Fanad's numbers onto an HA dashboard. Everything here shipped
2026-07-18 (payload `version: 1`). This is just how to do it.*

## 1. Mint a read-only token (once)

The credential for HA is a **read-only claim token** — it can only GET, so the token sitting
in your HA config can never post chat or change anything. Three ways to mint:

- **Web:** Settings → Security → Terminal client tokens → tick **"Enable the terminal
  client"** → tick **Read-only** → Mint. The token shows ONCE (only its hash is stored).
- **Server box:** `npm run token -- --read-only --label ha-dashboard` (or
  `fanad token --read-only`).
- **API:** `POST /api/settings/cli-tokens` with `{"readOnly": true, "label": "ha-dashboard"}`.

Gotchas:
- Tokens only authenticate while **"Enable the terminal client"** stays ticked — flipping it
  off instantly (and reversibly) disables every outstanding token.
- Default TTL is 90 days (`--ttl 0` = never expires). Revoke any time from the same panel.
- The Scope column in the token list tells you which tokens are read-only.

## 2. The endpoint

```
GET http://<fanad-host>:8787/api/ha/summary
Authorization: Bearer fnd1_...
```

One JSON bundle, rebuilt per request. Shape (version 1):

```jsonc
{
  "version": 1,
  "generated_at": "2026-07-18T17:13:48.046Z",
  "day": { "start": 1784354400000, "key": "2026-07-18", "rollover_hour": 2 },
  "mood": null,                      // today's expressed mood emojis, or null
  "tasks": {
    "open": 14,                      // available + in_progress + snoozed, EXCLUDING auto-slept
    "slept": 23,                     // auto-slept (hidden from the app's open list too)
    "snoozed": 0,
    "due_today": 0,                  // due during today's logical day (overlaps overdue — see note)
    "overdue": 0,                    // past due right now
    "cleared_today": 0,              // the "pad empties" number
    "captured_today": 0,
    "next_deadline": null,           // ISO timestamp or null
    "next_reminder": null,
    "active": { "state": "active", "started_at": "..." }   // "idle" when nothing started
  },
  "modules": {                       // a block is null when that module is off for the user
    "timer":   { "count": 0, "next_fire": null },
    "diet":    { "calories_today": 0, "target": 2000, "whatever_day": false,
                 "weight_last": 181.5, "weight_unit": "lbs", "weight_at": "..." },
    "journal": { "journals": 3, "entries_today": 0 },
    "metrics": [ { "id": 1, "name": "water", "unit": "glasses", "aggregation": "sum",
                   "target": null, "today": 0, "count_today": 0 } ],
    "lists":   { "lists": 2, "items": 5 },
    "batches": { "active": true, "batch_no": 5 }
  }
}
```

Rules to remember:

- **Counts only by default.** Task titles, timer labels, and batch names appear ONLY with
  `?titles=1` — and remember anything you expose lands in HA's recorder/logbook and whatever
  voice assistant you wired up. Metric *names* are always included (a "metric #3" sensor is
  useless).
- **"Today" rolls at 02:00**, Fanad's logical day — not midnight. Today-sensors reset then.
- A task due earlier today is in BOTH `due_today` and `overdue` — that's intentional.
- The data follows the token's user and their **current notebook** — if you switch into a
  notebook, the numbers follow.
- `version` only changes when the shape does; pin your templates to it mentally.

## 3. HA REST sensors (copy-paste)

`configuration.yaml` (put the token in `secrets.yaml` as `fanad_token: Bearer fnd1_...`):

```yaml
rest:
  - resource: http://YOUR_FANAD_HOST:8787/api/ha/summary
    headers:
      Authorization: !secret fanad_token
    scan_interval: 300
    sensor:
      - name: Fanad tasks open
        unique_id: fanad_tasks_open
        icon: mdi:notebook-edit-outline
        value_template: "{{ value_json.tasks.open }}"
      - name: Fanad tasks due today
        unique_id: fanad_tasks_due_today
        icon: mdi:calendar-today
        value_template: "{{ value_json.tasks.due_today }}"
      - name: Fanad overdue
        unique_id: fanad_overdue
        icon: mdi:alert-circle-outline
        value_template: "{{ value_json.tasks.overdue }}"
      - name: Fanad cleared today
        unique_id: fanad_cleared_today
        icon: mdi:check-circle-outline
        value_template: "{{ value_json.tasks.cleared_today }}"
      - name: Fanad next deadline
        unique_id: fanad_next_deadline
        device_class: timestamp
        value_template: "{{ value_json.tasks.next_deadline }}"
      - name: Fanad active task
        unique_id: fanad_active_task
        icon: mdi:progress-wrench
        value_template: "{{ value_json.tasks.active.state }}"
      # Module blocks are null when off — default '0'/'unknown' guards keep HA quiet:
      - name: Fanad calories today
        unique_id: fanad_calories_today
        unit_of_measurement: kcal
        state_class: measurement
        value_template: "{{ (value_json.modules.diet or {}).get('calories_today', 0) }}"
      - name: Fanad weight
        unique_id: fanad_weight
        state_class: measurement
        value_template: "{{ (value_json.modules.diet or {}).get('weight_last') }}"
        unit_of_measurement: lbs
      - name: Fanad timer next fire
        unique_id: fanad_timer_next_fire
        device_class: timestamp
        value_template: "{{ (value_json.modules.timer or {}).get('next_fire') }}"
```

Useful dashboard bits on top:

```yaml
# Conditional card — only appears when something is overdue
type: conditional
conditions:
  - condition: numeric_state
    entity: sensor.fanad_overdue
    above: 0
card:
  type: markdown
  content: "🔴 **{{ states('sensor.fanad_overdue') }} overdue** — go look at Fanad."
```

```yaml
# Automation: announce overdue count at 9am
triggers:
  - trigger: time
    at: "09:00:00"
conditions:
  - condition: numeric_state
    entity: sensor.fanad_overdue
    above: 0
actions:
  - action: assist_satellite.announce
    target: { entity_id: assist_satellite.YOUR_SATELLITE }
    data:
      message: "You have {{ states('sensor.fanad_overdue') }} overdue items on the pad."
```

## 4. Live updates (instead of polling harder)

`GET /api/stream` (same Bearer token) is an SSE channel. It emits a `counts` event whenever
the summary numbers change (task/timer/diet mutations, debounced to one event per change
burst). HA's REST platform can't consume SSE natively — that's what the future companion
integration is for — but anything custom (AppDaemon, pyscript, Node-RED) can hold the stream
open and refresh the REST sensors via `homeassistant.update_entity` on each `counts` event:

```yaml
# Node-RED / AppDaemon pseudo-flow
SSE http://FANAD:8787/api/stream  --(event: counts)-->  action: homeassistant.update_entity
                                                        target: sensor.fanad_tasks_open ...
```

Keep `scan_interval: 300` as the fallback either way.

## 5. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401` | "Enable the terminal client" is off, token revoked/expired, or missing `Bearer ` prefix |
| `403 This token is read-only.` | Working as designed — you used the read token on a POST |
| Numbers look "wrong" around midnight–2am | Logical day: today-counters reset at 02:00, not 00:00 |
| Diet/timer sensors `unknown` | That module is off for the token's user (`optin diet` / `optin timer`) — blocks are null when off, use the `or {}` guards above |
| Counts differ from the raw DB | `open` excludes auto-slept tasks on purpose (matches the app's open list; see `tasks.slept`) |
| Titles missing | By design; add `?titles=1` to the resource URL only if you accept titles in HA's recorder |
| Sensors went stale | Token hit its 90-day TTL — mint a fresh one, or mint with `--ttl 0` |

## 6. What's next (not built yet)

The HACS companion integration (`fanad-hacs`) will replace the YAML with a config flow (host
+ read-only token), native sensors fed by
the SSE stream, `todo` entities, and `fanad_timer_fired` events. The endpoint contract above
is what it will consume — it won't change shape without bumping `version`.
