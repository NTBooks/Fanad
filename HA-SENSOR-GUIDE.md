# Fanad → Home Assistant Guide

*A practical, agent-oriented runbook for wiring Fanad into Home Assistant: read-only sensors, a
dashboard, charts, a calendar, per-notebook switching, and the privacy story. Written so whoever
(human or agent) does this next skips the walls we walked into. Payload `version: 1`.*

> **Setup assumed:** Fanad runs externally (e.g. Coolify) reached over your LAN; HA holds a
> **read-only** view and all writes stay in Telegram/web. Replace `<fanad-host>`, `<ha-host>`,
> and `<read-token>` throughout with your own. **Never commit a real token or a private URL.**

## 0. Read this first — the traps (each of these cost hours)

- **ApexCharts can't render a heatmap.** `apexcharts-card` accepts a `chart_type` of only
  line/scatter/pie/donut/radialBar; `apex_config.chart.type: heatmap` *silently renders a line*
  and `series[].type: heatmap` is rejected. Use **column** (bars) or **line** for daily history.
- **`resource_template` renders ONCE at setup and never re-renders.** A `rest:` sensor whose URL
  depends on an `input_select` will NOT follow it — not on `update_entity`, not on `rest.reload`,
  not on the scan interval. A dropdown-driven URL needs **trigger template sensors + `rest_command`** (§7).
- **`rest_command` loads only at HA startup** (it isn't reloadable) → adding one needs a **restart**.
- **`/local/` is served only if `/config/www` exists at boot.** Create `www` on a running HA and
  `/local/...` still 404s until you **restart** (the static route registers at startup). This looks
  like a custom card that "won't load" — but it's a 404, not a bad config.
- **Swapping a sensor's platform orphans its `entity_id`.** Drop a `rest:` sensor and add a
  `template:` sensor with the same `unique_id`, and HA hands the new one `sensor.x_2` because the
  orphaned registry entry still holds `sensor.x`. Delete the orphan first (§7).
- **HA has no per-entity read ACL.** The admin flag gates config, not entity data — *any* logged-in
  user can `get_states` and read your sensor attributes (task titles, note text). Restrict the
  *dashboard* to admins; keep content out of attributes if that isn't enough (§8).
- **You can't embed an authed Fanad in an iframe panel.** Cross-origin + `SameSite`/third-party
  cookies mean the login won't stick; the panel keeps asking for a token. HA is visibility-only —
  open Fanad in a tab / via the `/web` link instead (§8).
- **The read token can read a *specific* notebook** via `?notebook=<id>` — but only one the token's
  account owns; anything else falls back to the current space (§2, §7).

The rest is how-to. **Treat the YAML as *example*** — HA drifts, so trust the shapes over exact keys.

## 1. Mint a read-only token (once)

The credential for HA is a **read-only claim token** — it can only GET, so the token sitting
in your HA config can never post chat or change anything. Three ways to mint:

- **Web:** Settings → Security → Terminal client tokens → tick **"Enable the terminal
  client"** → tick **Read-only** → set **Expires** to **Never (unlimited)** (a wall dashboard
  shouldn't die in 90 days) → Mint. The token shows ONCE (only its hash is stored).
- **Server box:** `npm run token -- --read-only --label ha-dashboard` (or
  `fanad token --read-only`).
- **API:** `POST /api/settings/cli-tokens` with `{"readOnly": true, "label": "ha-dashboard"}`.

Gotchas:
- Tokens only authenticate while **"Enable the terminal client"** stays ticked — flipping it
  off instantly (and reversibly) disables every outstanding token.
- Default TTL is 90 days; pick a different lifetime from the **Expires** dropdown when minting
  (or `--ttl 0` on the CLI = never expires). Revoke any time from the same panel.
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
  notebook, the numbers follow. To read a **specific** notebook without switching, add
  `?notebook=<id>` (ids from `/api/notebooks`) — or `?notebook=main` for the main space — to
  the read endpoints (`/api/ha/summary`, `/api/tasks`, `/api/diet/report`, `/api/notes`).
  Read-only and safe: the id must be a notebook YOU own, or it falls back to your current space.
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

## 4. Building the dashboard (over the WebSocket API)

Storage-mode dashboards are created/edited over HA's authenticated WebSocket API, not YAML. Auth
handshake: connect `ws://<ha-host>:8123/api/websocket` → on `auth_required` send
`{type:"auth", access_token:"<HA long-lived token>"}` → `auth_ok`. Then the commands you need:

- `lovelace/dashboards/list` → each has `id` (storage id) and `url_path`.
- `lovelace/dashboards/create` `{url_path, title, icon, show_in_sidebar, require_admin, mode:"storage"}`
  — a **new** dashboard, so it can't clobber an existing one.
- `lovelace/config/save` `{url_path, config}` — the full dashboard config (a `views:` object).
- `lovelace/config` `{url_path}` — read it back to verify.
- `lovelace/dashboards/update` `{dashboard_id, require_admin, show_in_sidebar, icon, title}` and
  `lovelace/dashboards/delete` `{dashboard_id}`.

Use the modern **sections** view with `tile` / `heading` cards, plus `markdown` for lists. To show
the actual open-task LIST, point a sensor at `/api/tasks` with `json_attributes: [tasks]`, then a
markdown card filters that attribute:

```yaml
type: markdown
content: >
  {% set ts = state_attr('sensor.fanad_open_tasks','tasks') or [] %}
  {% for t in ts | rejectattr('slept_at') | selectattr('status','in',['available','in_progress','snoozed']) %}
  - {{ '▶ ' if t.status == 'in_progress' else '' }}{{ t.summary }}
  {% endfor %}
```

Note `/api/tasks` returns the whole board (done rows too); filter in the card. It's larger than the
summary — fine in a live attribute, but exclude that sensor from the recorder if you care about DB size.

## 5. Charts with ApexCharts (install + the heatmap trap)

HA has no native heatmap/chiclet card. The community `apexcharts-card` is the usual choice — but it
**cannot draw a heatmap** (see §0). Use **column** bars for daily counts and **line** for trends.

**Installing a custom card on HAOS (no HACS):**
1. Download the card's built JS from its GitHub *release* (jsdelivr can't serve it — the `dist/`
   isn't in the repo). ~1.6 MB.
2. Ensure `/config/www` exists. If newfolder/downloader/save can't create it, the **File-editor
   add-on's `POST <ingress>/api/exec_command {command:"mkdir -p /config/www"}`** does (it's a shell
   hook that works when the file APIs won't create dirs).
3. Write the JS to `/config/www/apexcharts-card.js` via the File-editor ingress `POST api/save`
   (the ingress accepts ~2 MB bodies fine).
4. Register the resource: WS `lovelace/resources/create` `{res_type:"module", url:"/local/apexcharts-card.js"}`.
5. **Restart HA** (so `/local/` is served — see §0), then hard-reload the browser.

A daily bar chart (one bar/day, tight window so recent data fills the card):

```yaml
type: custom:apexcharts-card
graph_span: 9w
header: { show: true, title: Calories / day }
series:
  - entity: sensor.fanad_diet_report      # holds a `days: [{date,total}]` attribute
    type: column
    data_generator: |
      return (entity.attributes.days||[]).map(d => [new Date(d.date+'T12:00:00').getTime(), d.total]);
apex_config: { chart: { height: 150 }, yaxis: [{ min: 0 }], grid: { show: false } }
```

`data_generator` reads a sensor **attribute** (so history shows immediately, no recorder wait).
Validate a card offline before shipping: serve the card JS on localhost, load it in a real browser,
`el.setConfig(cfg)` (catches config errors), then `el.hass = mockHass; append; inspect shadowRoot`
for `.apexcharts-bar-area` vs `path.apexcharts-line` (catches the heatmap trap).

## 6. A calendar of scheduled tasks

Create a **Local Calendar** (config flow, handler `local_calendar`, a `calendar_name`) → entity
`calendar.<name>`. Then sync Fanad's dated tasks in as all-day events with `calendar.create_event`
(`summary`, `start_date`, `end_date` = next day). Mark status in the summary (✓ done / ⚠ missed /
📌 open) so both history and upcoming read clearly. It's a **one-shot sync** — re-run it when tasks
change (or drive it from an automation). A native **Calendar card** then renders it.

## 7. Notebook switching (a dropdown that changes the whole view)

Goal: pick a notebook and the whole board switches to it, read-only, without changing Fanad's real
current notebook. Fanad supports `?notebook=<id>` on the read endpoints (§2). The HA side is the
hard part, because `resource_template` doesn't re-render (§0). The pattern that works:

1. **Helpers:** `input_select.fanad_notebook` (options: `Main` + notebook names) and
   `input_button.fanad_refresh`. Create via WS `input_select/create` / `input_button/create`.
2. **One `rest_command`** for authed GETs:
   ```yaml
   rest_command:
     fanad_get:
       url: "http://<fanad-host>:8787{{ path }}"
       method: GET
       headers: { Authorization: "Bearer <read-token>" }
   ```
3. **Trigger-based template sensors** (this is the key — they re-fetch when the dropdown changes):
   ```yaml
   template:
     - trigger:
         - platform: homeassistant
           event: start
         - platform: state
           entity_id: input_select.fanad_notebook
         - platform: state
           entity_id: input_button.fanad_refresh
         - platform: time_pattern
           minutes: "/1"
       action:
         - variables:
             # selection -> notebook id; hardcode a name->id map (re-sync if notebooks change)
             nb: "{% set m = {'work':12,'home':7} %}{{ m.get(states('input_select.fanad_notebook'),'main') }}"
         - service: rest_command.fanad_get
           continue_on_error: true
           response_variable: summ
           data: { path: "/api/ha/summary?titles=1&notebook={{ nb }}" }
         # ...repeat for /api/tasks, /api/diet/report, /api/notes into tk/dr/nt
       sensor:
         - name: Fanad tasks open
           unique_id: fanad_tasks_open
           state: "{{ summ.content.tasks.open if (summ is defined and summ.content is defined) else none }}"
         # ...the rest read summ/tk/dr/nt .content (rest_command auto-parses JSON into .content)
   ```
   Notes: keep the **same `unique_id`s** as your old rest sensors so the dashboard cards keep
   working; the account's notebook *list* stays a plain `rest:` sensor (it isn't notebook-scoped);
   the **Refresh button presses `input_button.fanad_refresh`** — `homeassistant.update_entity` is a
   no-op on template sensors.
4. **Migrating from `rest:` to `template:` sensors (the `_2` trap):** after saving the new config,
   `rest.reload` (orphans the old rest sensors), then **delete each orphaned entry** (WS
   `config/entity_registry/remove {entity_id}`) to free `sensor.fanad_*`, THEN **restart** (loads
   `rest_command` + the template sensors, which now claim the freed ids). Validate first with
   `homeassistant.check_config` and read `persistent_notification/get` — the supervisor `/core/check`
   WS proxy can return an empty `unknown_error` for a plain token and is not a reliable signal.

## 8. Privacy (who can actually see this)

- **Entity states have no per-user ACL in core HA.** Non-admins can't open Developer Tools, but any
  authenticated account can `get_states` (and mint its own long-lived token) and read your
  `sensor.fanad_*` attributes — including task titles and note text. The admin flag only gates config.
- **Lock the dashboard, not the data.** Set `require_admin: true` (WS `lovelace/dashboards/update`)
  so non-admins don't see it in the sidebar/UI. If you need to defeat even an API query, **keep
  content out of attributes** (counts-only sensors) — that's the only way to hide it from other accounts.
- **No embedded app panel.** Embedding an authed, cross-origin, http Fanad in an HA iframe fails on
  browser cookie policy (§0). Keep HA as the read-only view; reach the app via Telegram `/web`.

## 9. Live updates (instead of polling harder)

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

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401` | "Enable the terminal client" is off, token revoked/expired, or missing `Bearer ` prefix |
| `403 This token is read-only.` | Working as designed — you used the read token on a POST |
| Numbers look "wrong" around midnight–2am | Logical day: today-counters reset at 02:00, not 00:00 |
| Diet/timer sensors `unknown` | That module is off for the token's user (`optin diet` / `optin timer`) — blocks are null when off, use the `or {}` guards above |
| Counts differ from the raw DB | `open` excludes auto-slept tasks on purpose (matches the app's open list; see `tasks.slept`) |
| Titles missing | By design; add `?titles=1` to the resource URL only if you accept titles in HA's recorder |
| Sensors went stale | Token hit its 90-day TTL — mint a fresh one, or mint with `--ttl 0` |
| Custom card won't load / "Configuration error" | `/local/<card>.js` 404s — `www` was created after boot; **restart** (§0, §5). If it loads but a chart is wrong, it's the ApexCharts heatmap trap — use column/line |
| Notebook dropdown changes nothing | `resource_template` doesn't re-render (§0) — you need trigger template sensors + `rest_command` (§7) |
| New sensors came up as `sensor.x_2` | Orphaned old registry entries still hold `sensor.x` — delete them, then restart (§7) |
| A trigger template sensor is `unknown` | Its `rest_command` isn't loaded (needs a **restart**), or the fetch failed — check the `continue_on_error` / `is defined` guards |

## 11. What's next (not built yet)

The HACS companion integration (`fanad-hacs`) will replace the YAML with a config flow (host
+ read-only token), native sensors fed by
the SSE stream, `todo` entities, and `fanad_timer_fired` events. The endpoint contract above
is what it will consume — it won't change shape without bumping `version`.
