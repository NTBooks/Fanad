// Float32 vector <-> SQLite BLOB, plus cosine similarity. Brute-force in JS (no sqlite-vec).
export function toBlob(vec) {
  const f = new Float32Array(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

export function fromBlob(blob) {
  const u = Uint8Array.from(blob);            // fresh, 0-offset copy (safe Float32Array view)
  const f = new Float32Array(u.buffer, 0, Math.floor(u.byteLength / 4));
  return Array.from(f);
}

export function cosine(a, b) {
  if (!a || !b) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
