// The CLI's local config cache: { lastServer, servers: { "<url>": { token, lastMessageId } } }.
// The token IS the credential, so the file is user-private: %APPDATA%\fanad\cli.json on
// Windows (the profile is already per-user), chmod 600 under $XDG_CONFIG_HOME/fanad/cli.json elsewhere.
// Caching after the first connect is what makes `fanad <server>` (token omitted) reconnect — and keeps
// the token out of shell history on every later launch.
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const dir = process.platform === 'win32'
  ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'fanad')
  : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'fanad');
const file = join(dir, 'cli.json');

export function loadConfig() {
  try { return JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2));
  if (process.platform !== 'win32') { try { chmodSync(file, 0o600); } catch { /* best effort */ } }
  return next;
}

// Per-server slot helpers (one cached token per server URL).
export function serverSlot(cfg, server) {
  return (cfg.servers || {})[server] || {};
}
export function saveServerSlot(server, patch) {
  const cfg = loadConfig();
  const servers = { ...(cfg.servers || {}) };
  servers[server] = { ...(servers[server] || {}), ...patch };
  return saveConfig({ lastServer: server, servers });
}
