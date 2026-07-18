// Where the data dir + KEK file live — the PATH RESOLUTION only, split out of config.js/crypto.js.
//
// IMPORTANT: this module must import NOTHING from the app (node builtins only) and have no side effects.
// The first-run setup wizard (server/scripts/setup-server.js) and the restore-backup CLI resolve these
// paths BEFORE the app can boot — importing config.js there would mkdir the data dir, cache config.json,
// and fail-fast on a missing persist mount. Keep this file free of app imports.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Persistent storage root. On a container deploy (e.g. Coolify) the filesystem is ephemeral — the DB and
// the encryption key would be lost on every redeploy unless a volume is mapped. PERSIST_DATA names that
// mount (default /persist); map a volume to it in the platform. The DB + KEK then live under it and survive.
export function resolvePersistDir() { return process.env.PERSIST_DATA || '/persist'; }

// Where DB + KEK live. Explicit DATA_DIR wins (dev/tests/custom). Else use the persistent mount when it's
// actually present; otherwise fall back to the repo's local data dir (local dev).
export function resolveDataDir() {
  const persistDir = resolvePersistDir();
  return process.env.DATA_DIR || (existsSync(persistDir) ? join(persistDir, 'data') : join(root, 'data'));
}

// Sibling of the data dir (NOT inside it), so a backup of data/ doesn't also grab the key. Override with
// KEK_FILE to move it off the box's backup set entirely.
export function resolveKekFile(dataDir = resolveDataDir()) {
  return process.env.KEK_FILE || `${dataDir}.kek`;
}
