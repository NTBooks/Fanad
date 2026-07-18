// Data-retention export — the optional "keep a copy before we erase it" half of /requestdeletion.
// When retention is ON (settings.getRetentionConfig), the delete flow first snapshots EVERYTHING we hold
// on a user into a single zip in their on-disk folder, so an operator who must keep records (compliance)
// has them. OFF by default: a deletion request then wipes the data with no retained copy (privacy-first).
//
// TODO(privacy): once a retention PERIOD is decided, enforce + document it here AND in the privacy policy
// (what we keep, where, and for how long). The zip below is the artifact that disclosure must describe.
//
// The zip is built with Node's built-in zlib only (server/zip.js) — no archive dependency — so the project
// keeps its tiny dependency surface. The format is a standard DEFLATE zip (readable by any unzip tool).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { collectUserData } from './repo.js';
import { zipSync } from './zip.js';

export { zipSync }; // long-time home of the zip writer — re-exported for existing importers/tests

// The user's own folder on the data volume (same place the DB lives). Retention zips land here.
export function userDir(userId) {
  return join(config.dataDir, 'users', String(userId));
}

const pad = (n) => String(n).padStart(2, '0');
// A filesystem-safe local timestamp (no colons — Windows-friendly): 20260622-143005.
export function stampFor(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// SQLite hands BLOBs back as Uint8Array and very large integers as BigInt; make both JSON-safe so a row
// with an embedding vector (or a huge id) still serializes cleanly.
function jsonSafe(_key, value) {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Uint8Array) return { __blob_base64: Buffer.from(value).toString('base64') };
  return value;
}

// Snapshot every row we hold on a user into a timestamped zip in their folder, BEFORE deletion. Each table
// becomes its own pretty-printed JSON file (account.json is the identity row). Returns { path, bytes,
// files } so the caller can tell the user a copy was kept. Throws on a filesystem error — the caller decides
// whether to proceed with the wipe anyway.
export function archiveUserData(userId, ts = Date.now()) {
  const data = collectUserData(userId);
  const entries = [
    { name: 'account.json', data: Buffer.from(JSON.stringify(data.user, jsonSafe, 2), 'utf8') },
  ];
  for (const [table, rows] of Object.entries(data.tables)) {
    entries.push({ name: `${table}.json`, data: Buffer.from(JSON.stringify(rows, jsonSafe, 2), 'utf8') });
  }
  // Each notebook (an isolated sub-user space) gets its own folder in the zip, so its data is preserved too.
  for (const nb of data.notebooks || []) {
    const dir = `notebooks/${nb.notebook?.notebook_name || nb.notebook?.id}`;
    entries.push({ name: `${dir}/notebook.json`, data: Buffer.from(JSON.stringify(nb.notebook, jsonSafe, 2), 'utf8') });
    for (const [table, rows] of Object.entries(nb.tables)) {
      entries.push({ name: `${dir}/${table}.json`, data: Buffer.from(JSON.stringify(rows, jsonSafe, 2), 'utf8') });
    }
  }
  const dir = userDir(userId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `deletion-export-${stampFor(ts)}.zip`);
  const zip = zipSync(entries, ts);
  writeFileSync(path, zip);
  return { path, bytes: zip.length, files: entries.length };
}
