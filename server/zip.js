// Minimal zip writer + reader on Node's built-in zlib — no archive dependency, keeping the project's tiny
// dependency surface. The format is a standard DEFLATE zip (readable/writable by any zip tool).
//
// IMPORTANT: this module must import NOTHING from the app (node builtins only). The first-run setup wizard
// (server/scripts/setup-server.js) runs BEFORE `npm install` and before any .env exists, and it uses
// unzipSync to restore an instance backup — so this file has to evaluate standalone.
import { deflateRawSync, inflateRawSync } from 'node:zlib';

// CRC-32 (IEEE), table-driven — required by the zip local/central headers.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// DOS time/date packed for a zip header (2-second resolution, year from 1980).
function dosDateTime(ts) {
  const d = new Date(ts);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

// Build a standard DEFLATE zip from [{ name, data:Buffer }] → a single Buffer. Minimal but spec-correct
// (local headers + central directory + end-of-central-directory), enough for any unzip tool to open.
export function zipSync(entries, ts = Date.now()) {
  const { time, date } = dosDateTime(ts);
  const parts = [];     // file segments, in order
  const central = [];   // central-directory records
  let offset = 0;       // running offset of the next local header

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const comp = deflateRawSync(e.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);     // local file header signature
    local.writeUInt16LE(20, 4);             // version needed
    local.writeUInt16LE(0, 6);              // flags
    local.writeUInt16LE(8, 8);              // method = deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);             // extra length
    parts.push(local, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);        // central directory header signature
    cd.writeUInt16LE(20, 4);                // version made by
    cd.writeUInt16LE(20, 6);                // version needed
    cd.writeUInt16LE(0, 8);                 // flags
    cd.writeUInt16LE(8, 10);                // method
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);                // extra length
    cd.writeUInt16LE(0, 32);                // comment length
    cd.writeUInt16LE(0, 34);                // disk number start
    cd.writeUInt16LE(0, 36);                // internal attrs
    cd.writeUInt32LE(0, 38);                // external attrs
    cd.writeUInt32LE(offset, 42);           // local header offset
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);        // end of central directory signature
  eocd.writeUInt16LE(0, 4);                 // this disk
  eocd.writeUInt16LE(0, 6);                 // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);    // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);   // total entries
  eocd.writeUInt32LE(cdBuf.length, 12);     // central dir size
  eocd.writeUInt32LE(offset, 16);           // central dir offset
  eocd.writeUInt16LE(0, 20);                // comment length
  return Buffer.concat([...parts, cdBuf, eocd]);
}

// ── Reader ──────────────────────────────────────────────────────────────────────────────────────────────
// unzipSync parses archives we did NOT write (an instance backup uploaded to the setup wizard), so unlike
// the writer it treats its input as hostile: entry names are screened against path traversal, declared
// sizes are checked against caps BEFORE inflating (a tiny zip can claim terabytes), and every entry's
// CRC-32 is re-verified after inflation.

const ZIP64_MARKER = 0xffffffff;

// A name from an archive may be used as a relative filesystem path by callers, so anything that could
// escape the extraction root is rejected outright: absolute paths, drive letters, backslash separators
// (zip spec mandates '/'), '..' segments, NUL bytes.
function assertSafeName(name) {
  const bad =
    name.length === 0 || name.includes('\0') || name.includes('\\')
    || name.startsWith('/') || /^[a-zA-Z]:/.test(name)
    || name.split('/').some((seg) => seg === '..');
  if (bad) throw new Error(`zip: unsafe entry name ${JSON.stringify(name)}`);
}

// Parse a zip Buffer → [{ name, data:Buffer }]. Directory entries (trailing '/') are skipped. Only
// methods 0 (store) and 8 (deflate) are accepted; zip64 archives are rejected (zipSync never writes them
// and a backup that big exceeds our caps anyway).
export function unzipSync(buf, { maxEntries = 100_000, maxEntryBytes = 4 * 2 ** 30, maxTotalBytes = 4 * 2 ** 30 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('zip: not a zip archive');

  // Find the end-of-central-directory record: scan backwards over at most 64 KiB of trailing comment.
  let eocd = -1;
  const scanFloor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= scanFloor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: end-of-central-directory record not found');

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === ZIP64_MARKER || cdOffset === ZIP64_MARKER) throw new Error('zip: zip64 archives are not supported');
  if (count > maxEntries) throw new Error(`zip: too many entries (${count} > ${maxEntries})`);
  if (cdOffset + cdSize > eocd) throw new Error('zip: central directory out of bounds');

  const out = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central directory record');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (compSize === ZIP64_MARKER || rawSize === ZIP64_MARKER || localOffset === ZIP64_MARKER) throw new Error('zip: zip64 archives are not supported');
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry — paths are implied by file names
    assertSafeName(name);
    if (method !== 0 && method !== 8) throw new Error(`zip: unsupported compression method ${method} in ${JSON.stringify(name)}`);
    // Declared-size caps come FIRST — never inflate something that claims to be bigger than we allow.
    if (rawSize > maxEntryBytes) throw new Error(`zip: entry too large ${JSON.stringify(name)}`);
    total += rawSize;
    if (total > maxTotalBytes) throw new Error('zip: archive exceeds total size cap');

    // The local header repeats name/extra with its own lengths — read them to find the data offset.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`zip: bad local header for ${JSON.stringify(name)}`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) throw new Error(`zip: entry data out of bounds for ${JSON.stringify(name)}`);
    const comp = buf.subarray(dataStart, dataStart + compSize);

    const data = method === 0 ? Buffer.from(comp) : inflateRawSync(comp, { maxOutputLength: maxEntryBytes });
    if (data.length !== rawSize) throw new Error(`zip: size mismatch in ${JSON.stringify(name)}`);
    if (crc32(data) !== crc) throw new Error(`zip: CRC mismatch in ${JSON.stringify(name)}`);
    out.push({ name, data });
  }
  return out;
}
