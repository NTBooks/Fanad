// instancePackage.js — the whole-installation backup/migrate artifact. A backup that silently loses files
// (or restores over live data) is discovered exactly when it's needed, so the round trip is proven here
// end-to-end against a REAL DB in a scratch dir: build → validate → restore into a second scratch → every
// byte accounted for, the safety renames happen, and the newer-DB boot guard in migrate() actually fires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-pkg-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { db, migrate, MIGRATIONS } = await import('../server/db.js');
const { zipSync } = await import('../server/zip.js');
const { config } = await import('../server/config.js');
const { buildInstancePackage, validateInstancePackage, restoreInstancePackage, PACKAGE_KIND } = await import('../server/instancePackage.js');
const { insertTask, defaultUserId } = await import('../server/repo.js');

migrate();
const uid = defaultUserId();

// Populate the data dir the way a real install does: DB rows + a config.json + a user image file.
insertTask({ userId: uid, summary: 'pack me up' });
writeFileSync(join(config.dataDir, 'config.json'), '{"note":"non-secret file config"}');
mkdirSync(join(config.dataDir, 'images', String(uid)), { recursive: true });
const IMG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
writeFileSync(join(config.dataDir, 'images', String(uid), 'photo.png'), IMG);

const kekFile = join(tmpdir(), `fanad-pkg-kek-${process.pid}`);
writeFileSync(kekFile, Buffer.alloc(32, 7));

const build = (over = {}) => buildInstancePackage({
  db, dataDir: config.dataDir, kekFile, kekSource: 'temp', appVersion: '1.2.3', ...over,
});

test('build → validate: manifest describes the package and the data dir rides along verbatim', () => {
  const { zip, manifest } = build();
  assert.equal(manifest.kind, PACKAGE_KIND);
  assert.equal(manifest.kekIncluded, false); // default OFF — the checkbox is opt-in
  assert.equal(manifest.schemaVersion, MIGRATIONS.length);
  const v = validateInstancePackage(zip);
  assert.equal(v.kek, null);
  assert.equal(v.schemaVersion, MIGRATIONS.length);
  const names = v.files.map((f) => f.name);
  assert.ok(names.includes('fanad.db'));
  assert.ok(names.includes('config.json'));
  assert.ok(names.includes(`images/${uid}/photo.png`));
  assert.ok(!names.some((n) => n.includes('-wal') || n.includes('-shm')), 'WAL/SHM must not ride the package');
});

test('the checkbox: includeKek puts the raw key file in the package', () => {
  const { zip, manifest } = build({ includeKek: true });
  assert.equal(manifest.kekIncluded, true);
  const v = validateInstancePackage(zip);
  assert.deepEqual(v.kek, Buffer.alloc(32, 7));
});

test('restore into an empty dir reproduces every file, byte for byte', () => {
  const { zip } = build({ includeKek: true });
  const v = validateInstancePackage(zip);
  const destRoot = mkdtempSync(join(tmpdir(), 'fanad-restore-'));
  const dest = join(destRoot, 'data');
  const destKek = join(destRoot, 'data.kek');
  const sum = restoreInstancePackage({ ...v, dataDir: dest, kekFile: destKek });
  assert.equal(sum.ok, true);
  assert.equal(sum.kekIncluded, true);
  assert.equal(sum.previousDataDir, null); // nothing was displaced
  assert.deepEqual(readFileSync(join(dest, 'fanad.db')), readFileSync(join(config.dataDir, 'fanad.db')));
  assert.deepEqual(readFileSync(join(dest, 'images', String(uid), 'photo.png')), IMG);
  assert.deepEqual(readFileSync(destKek), Buffer.alloc(32, 7));
});

test('restore NEVER destroys: an existing data dir and KEK file are renamed aside with a timestamp', () => {
  const { zip } = build({ includeKek: true });
  const v = validateInstancePackage(zip);
  const destRoot = mkdtempSync(join(tmpdir(), 'fanad-restore-'));
  const dest = join(destRoot, 'data');
  const destKek = join(destRoot, 'data.kek');
  mkdirSync(dest);
  writeFileSync(join(dest, 'precious.txt'), 'old install');
  writeFileSync(destKek, Buffer.alloc(32, 9));
  const sum = restoreInstancePackage({ ...v, dataDir: dest, kekFile: destKek, now: Date.now() });
  assert.match(sum.previousDataDir, /data\.pre-restore-\d{8}-\d{6}$/);
  assert.equal(readFileSync(join(sum.previousDataDir, 'precious.txt'), 'utf8'), 'old install');
  const asideKek = readdirSync(destRoot).find((n) => n.startsWith('data.kek.pre-restore-'));
  assert.ok(asideKek, 'displaced KEK file kept');
  assert.deepEqual(readFileSync(join(destRoot, asideKek)), Buffer.alloc(32, 9));
  assert.deepEqual(readFileSync(destKek), Buffer.alloc(32, 7)); // the imported key won
});

test('validate rejects non-backups and tampered packages with clear messages', () => {
  assert.throws(() => validateInstancePackage(zipSync([{ name: 'x.txt', data: Buffer.from('hi') }])), /no manifest/);
  const mk = (manifest, extra = []) => zipSync([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, ...extra,
  ]);
  assert.throws(() => validateInstancePackage(mk({ kind: 'other' })), /wrong manifest kind/);
  assert.throws(() => validateInstancePackage(mk({ kind: PACKAGE_KIND, formatVersion: 99 })), /update Fanad/);
  assert.throws(() => validateInstancePackage(mk({ kind: PACKAGE_KIND, formatVersion: 1 })), /fanad\.db is missing/);
  assert.throws(() => validateInstancePackage(mk({ kind: PACKAGE_KIND, formatVersion: 1 }, [
    { name: 'data/fanad.db', data: Buffer.from('not sqlite at all, but long enough to check the magic bytes......................') },
  ])), /not a SQLite database/);
  assert.throws(() => validateInstancePackage(mk({ kind: PACKAGE_KIND, formatVersion: 1 }, [
    { name: 'stray-root-file', data: Buffer.from('?') },
  ])), /unexpected file/);
});

test('the boot guard: migrate() refuses a DB from a newer Fanad instead of corrupting it', () => {
  const bump = MIGRATIONS.length + 5;
  db.exec(`PRAGMA user_version = ${bump}`);
  try {
    assert.throws(() => migrate(), /created by a newer version/);
  } finally {
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`); // put the scratch DB back
  }
});

test('validate trusts the DB header over an understated manifest schemaVersion', () => {
  const { zip } = build();
  const v0 = validateInstancePackage(zip);
  // Rebuild the same package but with a lying manifest — schemaVersion must come from the header.
  const dbEntry = v0.files.find((f) => f.name === 'fanad.db');
  const lied = zipSync([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ kind: PACKAGE_KIND, formatVersion: 1, schemaVersion: 1 })) },
    { name: 'data/fanad.db', data: dbEntry.data },
  ]);
  const v = validateInstancePackage(lied);
  assert.equal(v.schemaVersion, MIGRATIONS.length);
});
