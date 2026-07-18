// server/zip.js — the dependency-free zip writer + reader. The writer's spec-correctness is proven against
// an independent reader in retention.test.js; here the READER is on trial, because unzipSync parses
// archives we did NOT write (an instance backup uploaded to the setup wizard) and must treat them as
// hostile: path traversal in entry names, declared sizes that lie, corrupted bytes, zip64 markers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, crc32 } from '../server/zip.js';

const buf = (s) => Buffer.from(s, 'utf8');
const entries = (names) => names.map((name, i) => ({ name, data: buf(`payload ${i} of ${name}`) }));

test('round-trip: unzipSync returns exactly what zipSync wrote, byte for byte', () => {
  const original = [
    { name: 'manifest.json', data: buf('{"kind":"x"}') },
    { name: 'data/fanad.db', data: Buffer.from([0, 1, 2, 3, 255, 254, 0, 7]) }, // binary survives
    { name: 'data/images/1/photo.png', data: Buffer.alloc(4096, 0xab) },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ];
  const out = unzipSync(zipSync(original, Date.now()));
  assert.equal(out.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assert.equal(out[i].name, original[i].name);
    assert.deepEqual(out[i].data, original[i].data);
  }
});

test('an empty archive round-trips to an empty list', () => {
  assert.deepEqual(unzipSync(zipSync([], Date.now())), []);
});

test('directory entries (trailing slash) are skipped, not returned', () => {
  const zip = zipSync([{ name: 'dir/', data: Buffer.alloc(0) }, { name: 'dir/file', data: buf('x') }], Date.now());
  const out = unzipSync(zip);
  assert.deepEqual(out.map((e) => e.name), ['dir/file']);
});

test('path traversal names are rejected outright', () => {
  for (const name of ['../evil', 'a/../../evil', '/etc/passwd', 'C:/windows/evil', 'a\\evil', 'a/..', 'nul\0byte']) {
    const zip = zipSync(entries([name]), Date.now());
    assert.throws(() => unzipSync(zip), /unsafe entry name/, `expected rejection for ${JSON.stringify(name)}`);
  }
  // Names that merely CONTAIN dots are fine — only real '..' segments escape.
  const ok = unzipSync(zipSync(entries(['a..b/file', 'weird...name']), Date.now()));
  assert.equal(ok.length, 2);
});

test('entry-count and size caps are enforced before any inflation', () => {
  const zip = zipSync(entries(['a', 'b', 'c']), Date.now());
  assert.throws(() => unzipSync(zip, { maxEntries: 2 }), /too many entries/);
  assert.throws(() => unzipSync(zip, { maxEntryBytes: 4 }), /entry too large/);
  assert.throws(() => unzipSync(zip, { maxTotalBytes: 20 }), /total size cap/);
});

test('a lying declared size is caught: cap checked against the claim, mismatch caught after inflate', () => {
  const zip = zipSync([{ name: 'liar', data: Buffer.alloc(100, 1) }], Date.now());
  // Inflate the claim: patch the central directory's uncompressed-size field to pretend it's huge.
  const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt32LE(2 ** 31, cd + 24);
  assert.throws(() => unzipSync(zip), /entry too large|size mismatch/);
  // Shrink the claim below reality: passes the cap, must still die on the post-inflate size check.
  zip.writeUInt32LE(10, cd + 24);
  assert.throws(() => unzipSync(zip), /size mismatch/);
});

test('corrupted entry bytes are caught by the CRC re-check', () => {
  const data = Buffer.alloc(64, 7);
  const zip = zipSync([{ name: 'f', data }], Date.now());
  // Flip a bit inside the compressed stream (starts right after the 30-byte local header + 1-byte name).
  zip[31 + 3] ^= 0x01;
  assert.throws(() => unzipSync(zip), /CRC mismatch|size mismatch|Z_DATA_ERROR|invalid/);
});

test('zip64 markers are rejected with a clear error', () => {
  const zip = zipSync([{ name: 'f', data: buf('x') }], Date.now());
  const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt32LE(0xffffffff, cd + 24); // uncompressed size = zip64 escape value
  assert.throws(() => unzipSync(zip), /zip64/);
});

test('garbage input fails cleanly, not with a crash', () => {
  assert.throws(() => unzipSync(Buffer.from('not a zip at all')), /not a zip|not found/);
  assert.throws(() => unzipSync(Buffer.alloc(0)), /not a zip/);
  assert.throws(() => unzipSync(Buffer.alloc(4096, 0x5a)), /not found/);
});

test('crc32 matches the known IEEE vector', () => {
  assert.equal(crc32(buf('123456789')), 0xcbf43926); // the classic CRC-32 check value
});

test('an unzip survives a trailing archive comment (EOCD not at the very end)', () => {
  const zip = zipSync(entries(['a/b.txt']), Date.now());
  const comment = buf('appended by some tool');
  const withComment = Buffer.concat([zip, comment]);
  withComment.writeUInt16LE(comment.length, zip.length - 2); // EOCD comment-length field
  const out = unzipSync(withComment);
  assert.equal(out[0].name, 'a/b.txt');
});
