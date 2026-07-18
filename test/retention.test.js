// retention.js — the "keep a copy before we erase it" half of /requestdeletion. deletion.test.js proves a
// zip file APPEARS during the flow; nothing proved the zip is a valid archive or that its contents are
// complete. A corrupt or partial export is the worst kind of bug: it's only discovered at the exact moment
// the data it should have preserved is gone forever. So this verifies the artifact itself, with an
// INDEPENDENT zip reader (not zipSync's own code): spec-correct structure, CRCs re-checked via node:zlib's
// crc32, one JSON file per USER_TABLES table, notebook subfolders, and BLOB-safe serialization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { inflateRawSync, crc32 } from 'node:zlib';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-retention-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { zipSync, archiveUserData, userDir } = await import('../server/retention.js');
const {
  defaultUserId, insertTask, insertNote, insertMessage, insertEmbedding, createNotebook, USER_TABLES,
} = await import('../server/repo.js');
const { fromBlob } = await import('../server/rag/vector.js');

migrate();
const uid = defaultUserId();

// Independent minimal zip reader: walk the end-of-central-directory → central directory → each local
// header, inflate every entry, and re-verify its CRC-32 with zlib's own implementation. If zipSync drifts
// from the spec in a way any of these fields would betray, this reader (and any real unzip tool) breaks.
function readZip(buf) {
  const eocd = buf.length - 22; // we never write an archive comment, so EOCD is exactly the last 22 bytes
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'end-of-central-directory signature');
  const count = buf.readUInt16LE(eocd + 10);
  assert.equal(buf.readUInt16LE(eocd + 8), count, 'per-disk and total entry counts agree');
  let off = buf.readUInt32LE(eocd + 16);
  assert.equal(buf.readUInt32LE(eocd + 12), eocd - off, 'central directory size matches its actual extent');
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50, 'central-directory record signature');
    const crc = buf.readUInt32LE(off + 16);
    const compLen = buf.readUInt32LE(off + 20);
    const rawLen = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    // Follow the offset back to the local header — the reader real unzip tools use for the bytes.
    assert.equal(buf.readUInt32LE(localOff), 0x04034b50, `local header signature for ${name}`);
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const data = inflateRawSync(buf.subarray(dataStart, dataStart + compLen));
    assert.equal(data.length, rawLen, `uncompressed size for ${name}`);
    assert.equal(crc32(data), crc, `CRC-32 for ${name} (re-computed independently)`);
    entries.push({ name, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test('zipSync produces a spec-correct archive an independent reader can fully round-trip', () => {
  const original = [
    { name: 'account.json', data: Buffer.from(JSON.stringify({ id: 1, name: 'ünïcode ✓' }), 'utf8') },
    { name: 'notebooks/wörk/tasks.json', data: Buffer.from('[]', 'utf8') },
    // Incompressible binary data — exercises the compressed-size bookkeeping on the worst case.
    { name: 'blob.bin', data: Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256)) },
  ];
  const entries = readZip(zipSync(original, Date.now()));
  assert.equal(entries.length, original.length);
  for (const [i, e] of entries.entries()) {
    assert.equal(e.name, original[i].name, 'entry names survive (UTF-8, subfolders)');
    assert.ok(e.data.equals(original[i].data), `bytes round-trip exactly for ${e.name}`);
  }
});

test('zipSync with no entries is still a valid (empty) archive', () => {
  const zip = zipSync([], Date.now());
  assert.equal(zip.length, 22, 'exactly one end-of-central-directory record');
  assert.equal(readZip(zip).length, 0);
});

test('archiveUserData exports EVERY table, the identity row, and each notebook — and the zip opens', () => {
  // Fill enough tables that a scoping bug would show, including a notebook (an isolated sub-user space).
  const task = insertTask({ userId: uid, summary: 'water the ficus' });
  insertNote({ userId: uid, text: 'the spare key is under the pot' });
  insertMessage({ userId: uid, text: 'hello future self' });
  const nb = createNotebook(uid, 'work').notebook;
  insertTask({ userId: nb.id, summary: 'file the quarterly report' });

  const ts = new Date(2026, 5, 22, 14, 30, 5).getTime(); // fixed local time → deterministic filename
  const out = archiveUserData(uid, ts);

  // The zip lands in the USER's folder with a filesystem-safe (colon-free) local timestamp.
  assert.equal(dirname(out.path), userDir(uid));
  assert.ok(out.path.endsWith('deletion-export-20260622-143005.zip'), `stamped filename, got: ${out.path}`);
  assert.equal(out.bytes, statSync(out.path).size, 'reported bytes match the file on disk');

  const entries = readZip(readFileSync(out.path));
  assert.equal(entries.length, out.files, 'reported file count matches the archive');
  const byName = new Map(entries.map((e) => [e.name, e.data]));

  // account.json is the identity row; every USER_TABLES table gets its own JSON file. A table missing
  // here means the export silently dropped a whole class of the user's data.
  assert.equal(JSON.parse(byName.get('account.json')).id, uid);
  for (const t of USER_TABLES) {
    assert.ok(byName.has(`${t}.json`), `${t}.json must be exported`);
    assert.ok(Array.isArray(JSON.parse(byName.get(`${t}.json`))), `${t}.json parses as a row array`);
  }
  assert.ok(JSON.parse(byName.get('tasks.json')).some((r) => r.summary === 'water the ficus'));

  // The notebook's data is preserved in its own folder — it's erased alongside the parent, so an export
  // that skipped it would destroy the sub-space with no copy.
  assert.equal(JSON.parse(byName.get('notebooks/work/notebook.json')).notebook_name, 'work');
  assert.ok(JSON.parse(byName.get('notebooks/work/tasks.json')).some((r) => r.summary === 'file the quarterly report'));

  // Exact bookkeeping: identity + one file per table, plus (notebook.json + one per table) per notebook.
  assert.equal(out.files, 1 + USER_TABLES.length + (1 + USER_TABLES.length));

  // BLOB safety: an embedding vector (SQLite hands it back as a Uint8Array) must serialize as base64 and
  // decode back to the same floats — JSON.stringify on a raw Uint8Array would emit a useless index map.
  insertEmbedding({ userId: uid, ownerType: 'task', ownerId: task.id, vector: [0.25, -1.5, 3] });
  const again = readZip(readFileSync(archiveUserData(uid, ts + 1000).path));
  const embRows = JSON.parse(again.find((e) => e.name === 'embeddings.json').data);
  const row = embRows.find((r) => r.owner_id === task.id);
  assert.ok(row.vector.__blob_base64, 'BLOB column serialized as { __blob_base64 }');
  assert.deepEqual(fromBlob(Buffer.from(row.vector.__blob_base64, 'base64')), [0.25, -1.5, 3]);
});
