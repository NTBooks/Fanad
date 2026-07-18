// Home Assistant App entrypoint. The Supervisor writes the add-on options a user set in the
// UI to /data/options.json; this maps them onto the env vars Fanad reads (server/config.js,
// see .env.example) and then starts the server. With no options.json — i.e. a plain
// `docker run` — the container env is used as-is, so the same image serves both.
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const OPTIONS = '/data/options.json';

// add-on option key -> the env var Fanad reads. Only bootstrap config lives here; everything
// else is set in Fanad's own Settings UI and stored (encrypted) in the DB, which wins over env.
const MAP = {
  timezone: 'TZ',
  llm_provider: 'LLM_PROVIDER',
  lmstudio_base_url: 'LMSTUDIO_BASE_URL',
  ollama_base_url: 'OLLAMA_BASE_URL',
  allow_cloud_llm: 'LLM_ALLOW_CLOUD',
  kek: 'KEK',
  auth_mode: 'AUTH_MODE',
  auth_reset: 'AUTH_RESET',
};

const env = { ...process.env, PERSIST_DATA: '/data' };

if (existsSync(OPTIONS)) {
  let opts = {};
  try {
    opts = JSON.parse(readFileSync(OPTIONS, 'utf8'));
  } catch (e) {
    console.error(`[entrypoint] could not parse ${OPTIONS}: ${e.message}`);
  }
  for (const [key, envVar] of Object.entries(MAP)) {
    const v = opts[key];
    if (v === undefined || v === null || v === '') continue;
    env[envVar] = typeof v === 'boolean' ? (v ? '1' : '') : String(v);
  }
  // Behind the Supervisor's ingress proxy — trust it so req.ip is the real client.
  if (env.TRUST_PROXY === undefined) env.TRUST_PROXY = '1';
  console.log('[entrypoint] applied Home Assistant add-on options');
}

const child = spawn('node', ['server/index.js'], { stdio: 'inherit', env });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
