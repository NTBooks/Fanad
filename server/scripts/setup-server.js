// Fanad first-run setup wizard: a tiny local web form that writes the .env the real server reads.
// Launched by installer.bat BEFORE `npm install` has ever run, so this file must stick to node
// built-ins only (no express). Binds 127.0.0.1 only — the form collects secrets.
// If .env already exists the wizard refuses to run (delete .env to redo setup); the write itself
// uses the 'wx' flag so nothing is ever overwritten even in a race.
import http from 'node:http';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { exec } from 'node:child_process';
// These three are the ONLY app modules a pre-`npm install` script may import — each is deliberately kept
// free of app imports and load-time side effects (see the header comment in each file).
import { validateInstancePackage, restoreInstancePackage } from '../instancePackage.js';
import { resolveDataDir, resolveKekFile } from '../dataDirPath.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// --env-path / --port / --no-open (or SETUP_ENV_PATH / SETUP_PORT): test/dev seams so the wizard
// can run against a scratch file without touching the real repo .env or popping a browser.
const argv = process.argv.slice(2);
const argValue = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const envPath = argValue('--env-path') || process.env.SETUP_ENV_PATH || join(root, '.env');
const setupPort = Number(argValue('--port') || process.env.SETUP_PORT) || 8899;
const noOpen = argv.includes('--no-open');

const CLOUD = new Set(['openai', 'gemini', 'anthropic']);
const CHAT_PROVIDERS = new Set(['lmstudio', 'ollama', 'openai', 'gemini', 'anthropic']);
const EMBED_PROVIDERS = new Set(['lmstudio', 'ollama', 'openai', 'gemini']); // Anthropic has no embeddings API

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Soft newer-version heads-up for restored backups. The HARD guard lives in db.js migrate() — a DB with a
// too-new schema refuses to boot; this wizard can't know MIGRATIONS.length (importing db.js would open the
// DB), so it can only compare app versions and warn.
const localVersion = (() => {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || null; } catch { return null; }
})();
function newerThanLocal(v) {
  if (!v || !localVersion) return false;
  const a = String(v).split('.').map(Number);
  const b = String(localVersion).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

// One KEY=VALUE line. Values are single-line by construction; quote only when the env-file parser
// would otherwise choke (spaces, #). Node's --env-file understands double quotes.
function envLine(key, value) {
  const v = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (v === '') return `${key}=`;
  return /[\s#"']/.test(v) ? `${key}="${v.replace(/"/g, '\\"')}"` : `${key}=${v}`;
}

// Pure .env renderer — exported for tests. `f` is the flat form-field object.
export function buildEnvFile(f = {}) {
  const chat = CHAT_PROVIDERS.has(f.llm_provider) ? f.llm_provider : 'lmstudio';
  const embed = EMBED_PROVIDERS.has(f.embed_provider) ? f.embed_provider : 'lmstudio';
  const cloudOn = CLOUD.has(chat) || CLOUD.has(embed);
  const port = Math.min(65535, Math.max(1, parseInt(f.port, 10) || 8787));
  // One base-URL field serves both local providers; file it under the var matching the local one in
  // use. Blank = provider-aware default (LM Studio :1234, Ollama :11434) filled in at runtime.
  const usesOllama = chat === 'ollama' || embed === 'ollama';
  const on = (v) => (v ? '1' : '');
  return [
    `# ── Fanad environment — written by the Fanad setup wizard ──`,
    `# To redo setup: delete this file and run the wizard again (installer.bat, or the "Fanad Setup" shortcut).`,
    `# Every variable is documented in .env.example; secrets can also be set in the web Settings.`,
    ``,
    `# Server`,
    envLine('PORT', port),
    ``,
    `# ── LLM provider (chat + embeddings can differ) ──`,
    envLine('LLM_ALLOW_CLOUD', on(cloudOn)),
    envLine('LLM_PROVIDER', chat),
    envLine('EMBED_PROVIDER', embed),
    ``,
    `# Local server (LM Studio / Ollama). Blank base URL = provider default (:1234 / :11434).`,
    envLine('LMSTUDIO_BASE_URL', usesOllama ? '' : f.base_url),
    envLine('OLLAMA_BASE_URL', usesOllama ? f.base_url : ''),
    envLine('LMSTUDIO_CHAT_MODEL', f.chat_model),
    envLine('LMSTUDIO_EMBED_MODEL', f.embed_model),
    envLine('LMSTUDIO_API_KEY', 'lm-studio'),
    ``,
    `# Cloud LLMs (bring your own key; only used when a provider above points at one)`,
    envLine('OPENAI_API_KEY', f.openai_key),
    envLine('OPENAI_CHAT_MODEL', f.openai_chat_model || 'gpt-4o-mini'),
    envLine('OPENAI_EMBED_MODEL', f.openai_embed_model || 'text-embedding-3-small'),
    envLine('GEMINI_API_KEY', f.gemini_key),
    envLine('GEMINI_CHAT_MODEL', f.gemini_chat_model || 'gemini-2.5-flash'),
    envLine('GEMINI_EMBED_MODEL', f.gemini_embed_model || 'text-embedding-004'),
    envLine('ANTHROPIC_API_KEY', f.anthropic_key),
    envLine('ANTHROPIC_CHAT_MODEL', f.anthropic_chat_model || 'claude-sonnet-4-6'),
    ``,
    `# ── Secret encryption key (32 bytes base64). Blank = on-box bootstrap key file (weaker). ──`,
    envLine('KEK', f.kek),
    envLine('KEK_FILE', ''),
    ``,
    `# ── Channels — leave blank to disable ──`,
    envLine('TELEGRAM_BOT_TOKEN', f.telegram_token),
    envLine('SLACK_BOT_TOKEN', f.slack_bot_token),
    envLine('SLACK_APP_TOKEN', f.slack_app_token),
    envLine('SLACK_SIGNING_SECRET', ''),
    ``,
    `# Weather (open-meteo needs NO key)`,
    envLine('WEATHER_PROVIDER', f.weather_provider === 'openweather' ? 'openweather' : 'open-meteo'),
    envLine('OPENWEATHER_API_KEY', f.weather_provider === 'openweather' ? f.openweather_key : ''),
    ``,
    `# ── Web login: enable later in Settings → Security. AUTH_RESET=1 is lockout recovery. ──`,
    envLine('AUTH_MODE', ''),
    envLine('AUTH_RESET', ''),
    ``,
    `# Dev/host toggles — read .env.example before enabling either`,
    envLine('DEBUG_LOG', on(f.debug_log)),
    envLine('USER_IMPERSONATION', on(f.user_impersonation)),
    ``,
  ].join('\n');
}

const PAGE_SHELL = (body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fanad setup</title>
<style>
  :root{--bg:#0e1116;--card:#161b23;--line:#2a3140;--text:#e6e9ef;--dim:#8b93a3;--accent:#e8a13c;--ok:#3fb37f;--danger:#e05d5d}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,'Segoe UI',sans-serif}
  .wrap{max-width:660px;margin:0 auto;padding:32px 16px 64px}
  h1{font-size:26px;margin:0}
  h1 .dot{color:var(--accent)}
  .tagline{color:var(--dim);margin:4px 0 28px}
  section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:16px}
  h2{font-size:15px;margin:0 0 4px;color:var(--accent);letter-spacing:.4px;text-transform:uppercase}
  .hint{color:var(--dim);font-size:13px;margin:0 0 14px}
  label{display:block;font-size:13px;color:var(--dim);margin:12px 0 4px}
  input[type=text],input[type=number],select{width:100%;background:#0b0e13;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px 11px;font:inherit}
  input.mono{font-family:Consolas,ui-monospace,monospace;font-size:13px}
  input:focus,select:focus{outline:none;border-color:var(--accent)}
  .row{display:flex;gap:12px}.row>div{flex:1}
  .kekrow{display:flex;gap:8px}.kekrow input{flex:1}
  .check{display:flex;gap:10px;align-items:flex-start;margin:12px 0 0}
  .check input{margin-top:4px}.check span{font-size:13px;color:var(--dim)}
  .check b{color:var(--text);font-weight:600}
  button{background:var(--accent);color:#1a1408;border:0;border-radius:8px;padding:10px 18px;font:inherit;font-weight:700;cursor:pointer}
  button.ghost{background:transparent;color:var(--accent);border:1px solid var(--accent);font-weight:600;white-space:nowrap}
  button:hover{filter:brightness(1.1)}
  .submit{width:100%;padding:14px;font-size:16px;margin-top:8px}
  details{margin-top:4px}summary{cursor:pointer;color:var(--dim);font-size:13px}
  .warn{color:var(--danger)}
  .done{width:64px;height:64px;border-radius:50%;background:var(--ok);color:#08130d;font-size:34px;display:flex;align-items:center;justify-content:center;margin-bottom:16px}
  code{background:#0b0e13;border:1px solid var(--line);border-radius:5px;padding:1px 6px;font-size:13px}
  ul{padding-left:20px}li{margin:6px 0}
  .hidden{display:none}
  #dropzone{border:2px dashed var(--line);border-radius:10px;padding:22px;text-align:center;color:var(--dim);cursor:pointer;transition:border-color .15s,color .15s}
  #dropzone.drag,#dropzone:hover{border-color:var(--accent);color:var(--text)}
  .ok-text{color:var(--ok)}
</style></head><body><div class="wrap">
<h1>Fanad<span class="dot">.</span> setup</h1>
<p class="tagline">Get it out of your head.</p>
${body}
</div></body></html>`;

const FORM_PAGE = PAGE_SHELL(`
<section>
  <h2>Moving from another server?</h2>
  <p class="hint">Drop a Fanad backup zip here (made on the old server under Settings &rarr; Data &rarr; Backup) and everything — tasks, notes, settings, photos — is restored before this install's first start. Fresh install? Just skip this.</p>
  <div id="dropzone">Drop the backup zip here, or click to choose a file</div>
  <input type="file" id="backup-file" accept=".zip,application/zip" class="hidden">
  <p id="restore-status" class="hint hidden"></p>
  <p id="restore-warn" class="hint warn hidden"></p>
</section>

<form method="post" action="/save" autocomplete="off">
  <section>
    <h2>Server</h2>
    <p class="hint">Everything here can be changed later — edit <code>.env</code> or use the web Settings.</p>
    <label for="port">Web UI port</label>
    <input type="number" id="port" name="port" value="8787" min="1" max="65535">
  </section>

  <section>
    <h2>Telegram bot</h2>
    <p class="hint">Optional. Message <b>@BotFather</b> on Telegram, send <code>/newbot</code>, and paste the token it gives you. Leave blank to use the web UI only (you can add it later).</p>
    <label for="telegram_token">Bot token</label>
    <input type="text" class="mono" id="telegram_token" name="telegram_token" placeholder="123456789:AAF...">
  </section>

  <section>
    <h2>AI brain</h2>
    <p class="hint">Local providers (LM Studio, Ollama) keep your notes on this machine. Cloud providers send them off the box — picking one turns the cloud gate on for you.</p>
    <div class="row">
      <div>
        <label for="llm_provider">Chat provider</label>
        <select id="llm_provider" name="llm_provider">
          <option value="lmstudio" selected>LM Studio (local)</option>
          <option value="ollama">Ollama (local)</option>
          <option value="openai">OpenAI (cloud)</option>
          <option value="gemini">Google Gemini (cloud)</option>
          <option value="anthropic">Anthropic Claude (cloud)</option>
        </select>
      </div>
      <div>
        <label for="embed_provider">Embeddings provider</label>
        <select id="embed_provider" name="embed_provider">
          <option value="lmstudio" selected>LM Studio (local)</option>
          <option value="ollama">Ollama (local)</option>
          <option value="openai">OpenAI (cloud)</option>
          <option value="gemini">Google Gemini (cloud)</option>
        </select>
      </div>
    </div>
    <div id="local-block">
      <label for="base_url">Local server URL <span style="font-weight:400">(blank = default: LM Studio :1234, Ollama :11434)</span></label>
      <input type="text" class="mono" id="base_url" name="base_url" placeholder="http://127.0.0.1:1234/v1">
      <div class="row">
        <div>
          <label for="chat_model">Chat model (blank = server default)</label>
          <input type="text" class="mono" id="chat_model" name="chat_model" placeholder="e.g. llama3.2">
        </div>
        <div>
          <label for="embed_model">Embedding model</label>
          <input type="text" class="mono" id="embed_model" name="embed_model" placeholder="e.g. nomic-embed-text">
        </div>
      </div>
    </div>
    <div id="openai-block" class="hidden">
      <label for="openai_key">OpenAI API key</label>
      <input type="text" class="mono" id="openai_key" name="openai_key" placeholder="sk-...">
      <div class="row">
        <div><label for="openai_chat_model">Chat model</label>
        <input type="text" class="mono" id="openai_chat_model" name="openai_chat_model" placeholder="gpt-4o-mini"></div>
        <div><label for="openai_embed_model">Embedding model</label>
        <input type="text" class="mono" id="openai_embed_model" name="openai_embed_model" placeholder="text-embedding-3-small"></div>
      </div>
    </div>
    <div id="gemini-block" class="hidden">
      <label for="gemini_key">Gemini API key</label>
      <input type="text" class="mono" id="gemini_key" name="gemini_key" placeholder="AIza...">
      <div class="row">
        <div><label for="gemini_chat_model">Chat model</label>
        <input type="text" class="mono" id="gemini_chat_model" name="gemini_chat_model" placeholder="gemini-2.5-flash"></div>
        <div><label for="gemini_embed_model">Embedding model</label>
        <input type="text" class="mono" id="gemini_embed_model" name="gemini_embed_model" placeholder="text-embedding-004"></div>
      </div>
    </div>
    <div id="anthropic-block" class="hidden">
      <label for="anthropic_key">Anthropic API key</label>
      <input type="text" class="mono" id="anthropic_key" name="anthropic_key" placeholder="sk-ant-...">
      <label for="anthropic_chat_model">Chat model</label>
      <input type="text" class="mono" id="anthropic_chat_model" name="anthropic_chat_model" placeholder="claude-sonnet-4-6">
    </div>
  </section>

  <section>
    <h2>Encryption</h2>
    <p class="hint">API keys and bot tokens stored in the database are encrypted with this key (AES-256-GCM). A key was generated for you — keep it, and keep a copy of this <code>.env</code> somewhere safe (a password manager). If you clear it, Fanad falls back to an on-box bootstrap key (weaker: doesn't protect against theft of the whole machine).</p>
    <label for="kek">Encryption key (KEK) — 32 bytes, base64</label>
    <div class="kekrow">
      <input type="text" class="mono" id="kek" name="kek">
      <button type="button" class="ghost" id="gen-kek">Regenerate</button>
    </div>
    <p id="kek-note" class="hint warn hidden" style="margin-top:8px"></p>
  </section>

  <section>
    <details>
      <summary>Optional extras — Slack, weather, developer toggles</summary>
      <label for="slack_bot_token">Slack bot token (Socket Mode)</label>
      <input type="text" class="mono" id="slack_bot_token" name="slack_bot_token" placeholder="xoxb-...">
      <label for="slack_app_token">Slack app-level token</label>
      <input type="text" class="mono" id="slack_app_token" name="slack_app_token" placeholder="xapp-...">
      <label for="weather_provider">Weather provider</label>
      <select id="weather_provider" name="weather_provider">
        <option value="open-meteo" selected>Open-Meteo (no key needed)</option>
        <option value="openweather">OpenWeather (needs a key)</option>
      </select>
      <div id="weather-key" class="hidden">
        <label for="openweather_key">OpenWeather API key</label>
        <input type="text" class="mono" id="openweather_key" name="openweather_key">
      </div>
      <label class="check"><input type="checkbox" name="debug_log" value="1">
        <span><b>Debug log panel</b> — tee server logs into the web UI. Dev only; exposes raw logs to any client.</span></label>
      <label class="check"><input type="checkbox" name="user_impersonation" value="1">
        <span><b class="warn">User impersonation</b> — web header dropdown to act as ANY user. Single-operator hosts only; anyone who can reach the server gets every account.</span></label>
    </details>
  </section>

  <button type="submit" class="submit">Save &amp; finish setup</button>
</form>
<script>
  const $ = (s) => document.querySelector(s);
  const CLOUD = ['openai', 'gemini', 'anthropic'];
  function refresh() {
    const chat = $('#llm_provider').value, embed = $('#embed_provider').value;
    $('#local-block').classList.toggle('hidden', CLOUD.includes(chat) && CLOUD.includes(embed));
    $('#openai-block').classList.toggle('hidden', chat !== 'openai' && embed !== 'openai');
    $('#gemini-block').classList.toggle('hidden', chat !== 'gemini' && embed !== 'gemini');
    $('#anthropic-block').classList.toggle('hidden', chat !== 'anthropic');
    $('#weather-key').classList.toggle('hidden', $('#weather_provider').value !== 'openweather');
  }
  function genKek() {
    const b = crypto.getRandomValues(new Uint8Array(32));
    $('#kek').value = btoa(String.fromCharCode(...b));
  }
  $('#llm_provider').addEventListener('change', refresh);
  $('#embed_provider').addEventListener('change', refresh);
  $('#weather_provider').addEventListener('change', refresh);
  $('#gen-kek').addEventListener('click', genKek);
  genKek();
  refresh();

  // ── restore-from-backup drop zone ──
  const drop = $('#dropzone'), backupFile = $('#backup-file');
  const rStatus = $('#restore-status'), rWarn = $('#restore-warn'), kekNote = $('#kek-note');
  function say(el, text) { el.textContent = text; el.classList.toggle('hidden', !text); }
  async function doRestore(file) {
    if (!file) return;
    say(rWarn, ''); say(kekNote, '');
    rStatus.classList.remove('ok-text');
    say(rStatus, 'Restoring "' + file.name + '"…');
    let out;
    try {
      const res = await fetch('/restore', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: file });
      out = await res.json();
    } catch (err) { out = { ok: false, error: String(err) }; }
    if (!out.ok) { say(rStatus, 'Restore failed: ' + (out.error || 'unknown error')); return; }
    rStatus.classList.add('ok-text');
    say(rStatus, '✓ Backup restored (' + out.fileCount + ' files). Now finish the form below — it writes the settings this server starts with.');
    if (out.kekSource === 'env') {
      // The old box's secrets are locked to ITS env KEK — a freshly generated key cannot read them.
      $('#kek').value = '';
      say(kekNote, 'This backup’s stored secrets (API keys, bot tokens, login 2FA) are encrypted with the OLD server’s key. Paste that server’s KEK above — do not generate a new one, or those secrets will be unreadable.');
    } else if (out.kekSource === 'temp' && !out.kekIncluded) {
      say(kekNote, 'The backup did not include the old server’s encryption key file. Copy "data.kek" from the old server to sit beside this install’s data folder, or stored secrets (API keys, bot tokens, login 2FA) will be unreadable.');
    } else if (out.kekIncluded) {
      say(rWarn, ''); // key rode along and was installed — nothing to do
    }
    if (out.warning) say(rWarn, out.warning);
  }
  drop.addEventListener('click', () => backupFile.click());
  backupFile.addEventListener('change', () => doRestore(backupFile.files[0]));
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => doRestore(e.dataTransfer.files[0]));
</script>`);

const alreadyRanPage = () => PAGE_SHELL(`
<section>
  <h2>Setup already ran</h2>
  <p>A configuration file already exists:</p>
  <p><code>${esc(envPath)}</code></p>
  <p class="hint">Nothing was changed. To run setup again, delete that file and re-run <code>installer.bat</code> (or the "Fanad Setup" shortcut) — or just edit it directly (see <code>.env.example</code> for every option).</p>
</section>`);

const successPage = (f) => {
  const tips = [];
  const chat = f.llm_provider, embed = f.embed_provider;
  if (chat === 'lmstudio' || embed === 'lmstudio')
    tips.push('Start <b>LM Studio</b>, load a model, and turn its local server on (default <code>http://127.0.0.1:1234</code>).');
  if (chat === 'ollama' || embed === 'ollama')
    tips.push('Make sure <b>Ollama</b> is running and you have pulled a chat model (<code>ollama pull llama3.2</code>) and an embedding model (<code>ollama pull nomic-embed-text</code>).');
  if (String(f.telegram_token || '').trim())
    tips.push('Open Telegram and send your bot a message to say hello.');
  tips.push(`Start Fanad with <b>run.bat</b> (or the <b>Start Fanad Server</b> shortcut), then open <code>http://localhost:${Math.min(65535, Math.max(1, parseInt(f.port, 10) || 8787))}</code>.`);
  return PAGE_SHELL(`
<section>
  <div class="done">✓</div>
  <h2>Setup complete</h2>
  <p>Your configuration was written to <code>${esc(envPath)}</code>.</p>
  <p class="hint">This wizard has shut down — you can close this tab.</p>
  <ul>${tips.map((t) => `<li>${t}</li>`).join('')}</ul>
</section>`);
};

// Exported for tests: an http.Server wired to the wizard routes. onSaved fires after a successful
// (or already-ran) POST so the CLI entrypoint can shut down; tests pass a no-op.
export function createSetupServer(onSaved = () => {}) {
  return http.createServer((req, res) => {
    const html = (code, body) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      return html(200, existsSync(envPath) ? alreadyRanPage() : FORM_PAGE);
    }
    // Restore an instance backup (the zip from Settings → Data → Backup on another server) BEFORE the
    // first boot: no server is running here and nothing holds the DB open, so a restore is just files.
    // Existing state is never destroyed — restoreInstancePackage renames a non-empty data dir aside.
    if (req.method === 'POST' && req.url === '/restore') {
      if (existsSync(envPath)) {
        req.resume(); // drain (don't destroy — the client still needs to read the response)
        return json(409, { ok: false, error: 'Setup already ran (.env exists). Delete it and re-run setup to restore a backup.' });
      }
      const chunks = [];
      let size = 0;
      let refused = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > 2 ** 30) { // 1 GiB upload cap — matches the package's own size limits
          refused = true;
          json(413, { ok: false, error: 'Backup exceeds the 1 GiB upload limit.' });
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (refused) return;
        try {
          const v = validateInstancePackage(Buffer.concat(chunks));
          const dataDir = resolveDataDir();
          const sum = restoreInstancePackage({ ...v, dataDir, kekFile: resolveKekFile(dataDir) });
          const warning = newerThanLocal(sum.appVersion)
            ? `This backup came from Fanad v${sum.appVersion}, newer than this install (v${localVersion}). If the server refuses to start after setup, update Fanad and start it again.`
            : null;
          console.log(`Restored backup into ${dataDir} (${sum.fileCount} files${sum.kekIncluded ? ', including the encryption key' : ''}).`);
          json(200, { ...sum, warning });
        } catch (err) {
          json(400, { ok: false, error: err.message });
        }
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/save') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
      req.on('end', () => {
        const f = Object.fromEntries(new URLSearchParams(body));
        try {
          writeFileSync(envPath, buildEnvFile(f), { flag: 'wx' }); // 'wx' = never overwrite
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
          html(409, alreadyRanPage());
          return onSaved(false);
        }
        html(200, successPage(f));
        onSaved(true);
      });
      return;
    }
    html(404, PAGE_SHELL('<section><h2>Not found</h2></section>'));
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {}); // best effort — the URL is printed to the console either way
}

function main() {
  if (existsSync(envPath)) {
    console.log(`Setup already ran: ${envPath} exists.`);
    console.log('Delete that file and run setup again (installer.bat, or the "Fanad Setup" shortcut) to redo it.');
    return;
  }
  const server = createSetupServer((saved) => {
    console.log(saved ? `\nWrote ${envPath} — setup complete. Start Fanad with run.bat or the "Start Fanad Server" shortcut.`
      : `\n${envPath} appeared while the wizard was open — nothing was overwritten.`);
    server.close();
    setTimeout(() => process.exit(saved ? 0 : 1), 300).unref(); // let the response flush
  });
  // The setup port is nobody's contract — if it's taken, walk forward a few and use what's free.
  let attempts = 0;
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempts < 10) {
      attempts += 1;
      server.listen(setupPort + attempts, '127.0.0.1');
    } else throw err;
  });
  server.listen(setupPort, '127.0.0.1', () => {
    const url = `http://localhost:${server.address().port}/`;
    console.log(`\nFanad setup wizard running at ${url}`);
    console.log('Complete the form in your browser. Press Ctrl+C to cancel.');
    if (!noOpen) openBrowser(url);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
