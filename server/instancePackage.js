// Instance package: the whole-installation backup/migrate artifact — one zip holding everything under the
// data dir (SQLite DB, config.json, images, retention archives) plus an optional copy of the KEK file and
// a manifest. Built by the BACKUP_MODE-gated export route; restored by the first-run setup wizard or the
// restore-backup CLI onto a box where the server is NOT running.
//
// Layout:
//   manifest.json                 (root — see buildManifest)
//   kek                           (root, optional — raw copy of the KEK file; the export checkbox)
//   data/**                       (verbatim copy of the data dir, minus -wal/-shm)
//
// IMPORTANT: this module must import NOTHING from the app except zip.js (node builtins otherwise). The
// setup wizard runs BEFORE `npm install` and before any .env exists — importing config.js/db.js/crypto.js
// here would mkdir dirs, open the DB, and read env at load. Everything the live server knows (db handle,
// dataDir, kekFile, kekSource) is passed IN by the caller instead.
import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { zipSync, unzipSync } from './zip.js';

export const PACKAGE_KIND = 'fanad-instance-package';
export const FORMAT_VERSION = 1;

// Everything a hostile/oversized upload is screened against. 4 GiB is also the zip32 format ceiling.
const MAX_TOTAL_BYTES = 4 * 2 ** 30;

// Filesystem-safe local timestamp (no colons — Windows-friendly), same shape as retention.js's stampFor
// (duplicated: retention.js imports config.js, which this module must never do).
const pad = (n) => String(n).padStart(2, '0');
function stamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// The DB files that must NOT ride the package: after a TRUNCATE checkpoint the main file is complete, and
// a copied -wal/-shm pair from a live server would be torn anyway.
const EXCLUDE_AT_ROOT = new Set(['fanad.db-wal', 'fanad.db-shm']);

function walkDataDir(dataDir) {
  const entries = [];
  const walk = (dir, rel) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (rel === '' && EXCLUDE_AT_ROOT.has(d.name)) continue;
      const abs = join(dir, d.name);
      const r = rel === '' ? d.name : `${rel}/${d.name}`;
      if (d.isDirectory()) walk(abs, r);
      else if (d.isFile()) entries.push({ name: `data/${r}`, data: readFileSync(abs) });
    }
  };
  walk(dataDir, '');
  return entries;
}

// Build the package. MUST be called from a fully synchronous handler: the caller checkpoints via the
// process's single DatabaseSync connection and we read the files in the same tick, so nothing can write
// in between (single-threaded sync — that's the whole consistency argument).
export function buildInstancePackage({ db, dataDir, kekFile, kekSource, appVersion, includeKek = false, now = Date.now() }) {
  // Fold the WAL into the main DB file so data/fanad.db alone is the complete database. busy !== 0 means
  // some OTHER connection holds a lock (e.g. an out-of-process script) — refuse rather than ship a torn copy.
  const ck = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if (Number(ck.busy) !== 0) throw new Error('database is busy (another process holds a lock) — try again in a moment');
  const schemaVersion = Number(db.prepare('PRAGMA user_version').get().user_version);

  const entries = walkDataDir(dataDir);
  const kekIncluded = includeKek && existsSync(kekFile);
  const totalBytes = entries.reduce((a, e) => a + e.data.length, 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error('data dir exceeds the 4 GiB zip limit — back it up manually');

  const manifest = {
    kind: PACKAGE_KIND,
    formatVersion: FORMAT_VERSION,
    exportedAt: now,
    appVersion,
    schemaVersion,
    kekIncluded,
    kekSource, // 'env' | 'temp' | 'none' — tells the restoring side what key material it needs
    fileCount: entries.length,
    totalBytes,
  };
  const all = [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') }];
  if (kekIncluded) all.push({ name: 'kek', data: readFileSync(kekFile) });
  all.push(...entries);
  return { zip: zipSync(all, now), manifest };
}

// Parse + screen an uploaded package. Throws with a user-showable message on anything off. Returns the
// manifest, the data/** entries (data/ prefix stripped → relative paths), and the kek buffer if present.
// Schema-version acceptability is NOT decided here (this module can't know MIGRATIONS.length without
// importing db.js) — migrate() hard-fails at boot on a too-new DB; callers may soft-warn via appVersion.
export function validateInstancePackage(buf) {
  const entries = unzipSync(buf, { maxTotalBytes: MAX_TOTAL_BYTES });

  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  if (!manifestEntry) throw new Error('not a Fanad backup: no manifest.json in the zip');
  let manifest;
  try { manifest = JSON.parse(manifestEntry.data.toString('utf8')); } catch { throw new Error('not a Fanad backup: manifest.json is not valid JSON'); }
  if (manifest.kind !== PACKAGE_KIND) throw new Error('not a Fanad backup: wrong manifest kind');
  if (Number(manifest.formatVersion) > FORMAT_VERSION) {
    throw new Error(`this backup uses package format v${manifest.formatVersion}; this Fanad only reads up to v${FORMAT_VERSION} — update Fanad first`);
  }

  let kek = null;
  const files = [];
  for (const e of entries) {
    if (e.name === 'manifest.json') continue;
    if (e.name === 'kek') { kek = e.data; continue; }
    if (!e.name.startsWith('data/')) throw new Error(`unexpected file in backup: ${JSON.stringify(e.name)}`);
    files.push({ name: e.name.slice('data/'.length), data: e.data });
  }

  const dbEntry = files.find((f) => f.name === 'fanad.db');
  if (!dbEntry) throw new Error('not a Fanad backup: data/fanad.db is missing');
  // SQLite header sanity: magic string, and the schema version at byte 60 (big-endian) should agree with
  // the manifest — a mismatch means the zip was hand-edited or corrupted in a way the CRCs can't see.
  if (dbEntry.data.length < 100 || !dbEntry.data.subarray(0, 16).equals(Buffer.from('SQLite format 3\0', 'latin1'))) {
    throw new Error('backup is damaged: data/fanad.db is not a SQLite database');
  }
  const headerSchemaVersion = dbEntry.data.readUInt32BE(60);
  const schemaVersion = Math.max(Number(manifest.schemaVersion) || 0, headerSchemaVersion);

  return { manifest, files, kek, schemaVersion };
}

// Write a validated package to disk. The server must NOT be running (nothing holds the DB open) — this is
// only ever called by the setup wizard and the restore-backup CLI. Existing state is never destroyed:
// a non-empty data dir (and any existing KEK file) is renamed aside with a timestamp first.
export function restoreInstancePackage({ files, kek, manifest, dataDir, kekFile, now = Date.now() }) {
  const s = stamp(now);
  let previousDataDir = null;
  if (existsSync(dataDir) && readdirSync(dataDir).length > 0) {
    previousDataDir = `${dataDir}.pre-restore-${s}`;
    renameSync(dataDir, previousDataDir);
  }
  mkdirSync(dataDir, { recursive: true });
  for (const f of files) {
    // unzipSync already rejected traversal ('..', absolute, '\') — f.name is a safe relative posix path.
    const abs = join(dataDir, ...f.name.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.data);
  }
  if (kek) {
    if (existsSync(kekFile)) renameSync(kekFile, `${kekFile}.pre-restore-${s}`);
    writeFileSync(kekFile, kek, { mode: 0o600 });
  }
  return {
    ok: true,
    fileCount: files.length,
    kekIncluded: Boolean(kek),
    kekSource: manifest.kekSource || 'none',
    appVersion: manifest.appVersion || null,
    schemaVersion: Number(manifest.schemaVersion) || 0,
    previousDataDir,
  };
}
