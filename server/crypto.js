// Encryption for secrets stored at rest in the DB (LLM API keys, Telegram bot token). API keys are very
// stealable, so we never persist them in the clear.
//
// Two keys, distinguished by the stored tag:
//   enc:v1  — encrypted with the off-box ENV KEK (the real one). Intended deployment: the .env lives in a
//             password manager, a loader injects it, and we delete it from process.env so it can't be
//             enumerated from a crash dump, an inheriting child process, or a dependency walking the env.
//   enc:t1  — encrypted with an on-box BOOTSTRAP KEK auto-generated into a key file when no env KEK is set.
//             A stopgap so nothing is ever stored plaintext; when an env KEK later arrives, boot migration
//             re-encrypts every enc:t1 value to enc:v1 and deletes the file (see settings.migrateSecretsAtRest).
//
// Honest threat model: the bootstrap key sits on the same box as the DB, so it gives ~no protection against
// someone who can read the filesystem — its value is avoiding plaintext-at-rest (helps with DB-only leaks:
// a stray backup, a table dump, an injection). The env KEK is the only thing that defends against box theft.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { config } from './config.js';
import { resolveKekFile } from './dataDirPath.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;            // 96-bit nonce — the GCM standard.
const KEYLEN = 32;           // AES-256.
const TAG_ENV = 'enc:v1';    // off-box env KEK
const TAG_TEMP = 'enc:t1';   // on-box bootstrap KEK

// Sibling of the data dir (NOT inside it), so a backup of data/ doesn't also grab the key. Override with
// KEK_FILE to move it off the box's backup set entirely — that's where the bootstrap key's value really is.
// Resolution shared with the pre-boot setup wizard / restore CLI via dataDirPath.js.
function defaultKekFile() { return resolveKekFile(config.dataDir); }

function parseKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  return key.length === KEYLEN ? key : null;
}

// Module state, (re)computed by initKek(). initKek is exported as a test seam so a "restart" with a
// different env KEK can be simulated in one process.
let envKek = null;        // 32B or null
let tempKek = null;       // 32B or null — loaded from / written to the key file
let active = null;        // the key new writes use (env KEK if present, else bootstrap)
let activeTag = null;     // TAG_ENV | TAG_TEMP
let source = 'none';      // 'env' (off-box) | 'temp' (on-box stopgap) | 'none' (no encryption)
let rekeyPending = false; // env KEK present AND a bootstrap key is still around → enc:t1 values to migrate off
let keyFile = null;
const warned = new Set(); // per-message, not one global flag — distinct diagnostics must each get their one line
function warnOnce(m) { if (!warned.has(m)) { console.warn(`[crypto] ${m}`); warned.add(m); } }

export function initKek({ envRaw = process.env.KEK, file = defaultKekFile() } = {}) {
  delete process.env.KEK;   // gone from the env no matter what happens below (anti-enumeration)
  envKek = null; tempKek = null; active = null; activeTag = null; source = 'none'; rekeyPending = false;
  keyFile = file;

  if (envRaw != null && String(envRaw).trim() !== '') {
    envKek = parseKey(envRaw);
    if (!envKek) throw new Error('KEK must decode to 32 bytes (a 256-bit key): base64 or 64-char hex.');
  }

  // Load an existing bootstrap key file (needed to read / migrate any enc:t1 values).
  if (existsSync(file)) {
    let buf = null;
    try { buf = readFileSync(file); } catch { /* unreadable */ }
    if (!buf || buf.length !== KEYLEN) {
      throw new Error(`Bootstrap key file ${file} is corrupt (expected ${KEYLEN} bytes) — refusing to start.`);
    }
    tempKek = buf;
  }

  if (envKek) {
    active = envKek; activeTag = TAG_ENV; source = 'env';
    rekeyPending = tempKek != null;     // migrate enc:t1 → enc:v1, then retire the file
  } else if (tempKek) {
    active = tempKek; activeTag = TAG_TEMP; source = 'temp';
  } else {
    // No env KEK and no file yet → generate a bootstrap key so we never store plaintext.
    const k = randomBytes(KEYLEN);
    try {
      writeFileSync(file, k, { mode: 0o600 });   // 0600 on POSIX; Windows ignores mode (ACLs differ)
      tempKek = k; active = k; activeTag = TAG_TEMP; source = 'temp';
    } catch {
      warnOnce(`Could not write the bootstrap key file (${file}) — secrets will be stored UNENCRYPTED.`);
      source = 'none';   // can't persist the key → don't encrypt, or we'd lose the data next boot
    }
  }
  return source;
}

initKek();

export function kekPresent() { return active != null; }
export function kekSource() { return source; }     // 'env' | 'temp' | 'none'
export function needsRekey() { return rekeyPending; }
export function isEncrypted(v) { return typeof v === 'string' && /^enc:(v1|t1):/.test(v); }

function keyForTag(tag) { return tag === TAG_ENV ? envKek : tag === TAG_TEMP ? tempKek : null; }

export function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === '') return plaintext;
  if (!active) { warnOnce('No KEK available — secret stored UNENCRYPTED.'); return plaintext; }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, active, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `${activeTag}:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(value) {
  if (value == null || value === '') return value;
  if (!isEncrypted(value)) return value;        // legacy plaintext / non-secret → as-is
  const parts = value.split(':');               // ['enc', v1|t1, iv, authTag, ct] — base64 has no ':'
  const key = keyForTag(`${parts[0]}:${parts[1]}`);
  if (!key) { warnOnce(`Found a ${parts[1]} secret but its key isn't available — cannot decrypt.`); return null; }
  try {
    const decipher = createDecipheriv(ALGO, key, Buffer.from(parts[2], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[3], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64')), decipher.final()]).toString('utf8');
  } catch {
    console.warn('[crypto] Failed to decrypt a stored secret (wrong key, or it was tampered with).');
    return null;
  }
}

// Re-encrypt one stored value under the ACTIVE key: lifts enc:t1 → enc:v1 when an env KEK arrives, and
// upgrades any legacy plaintext. Returns { value, status: 'unchanged' | 'rekeyed' | 'failed' }. On a value
// we can't decrypt (missing/wrong key) it returns 'failed' and leaves the value untouched — never clobbers.
export function rekeySecret(value) {
  if (value == null || value === '' || !active) return { value, status: 'unchanged' };
  if (isEncrypted(value) && value.startsWith(`${activeTag}:`)) return { value, status: 'unchanged' };
  if (!isEncrypted(value)) return { value: encryptSecret(value), status: 'rekeyed' }; // plaintext → encrypted
  const dec = decryptSecret(value);              // tagged with the OTHER key
  if (dec == null) return { value, status: 'failed' };
  return { value: encryptSecret(dec), status: 'rekeyed' };
}

// After migration has re-encrypted everything under the env KEK: drop the bootstrap key file + key.
export function finishRekey() {
  try { if (keyFile && existsSync(keyFile)) rmSync(keyFile); } catch { /* best effort */ }
  tempKek = null; rekeyPending = false;
}
