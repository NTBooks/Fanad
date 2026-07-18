// Save reply attachments to real files — the terminal's honest answer to inline media (
// protocol images don't compose with a hand-rolled scroll viewport, so charts land as PNGs on disk with
// the path printed in the bubble; .ics invites likewise). Files go under the OS temp dir per session.
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = join(tmpdir(), 'fanad-cli');
let seq = 0;

function nextPath(ext) {
  mkdirSync(dir, { recursive: true });
  seq += 1;
  return join(dir, `${Date.now()}-${seq}.${ext}`);
}

// A data: URI (the brain's chart PNGs) → a file path, or null when it isn't one.
export function saveDataUri(dataUri, ext = 'png') {
  const m = /^data:[^;,]+;base64,(.+)$/.exec(String(dataUri || ''));
  if (!m) return null;
  try {
    const file = nextPath(ext);
    writeFileSync(file, Buffer.from(m[1], 'base64'));
    return file;
  } catch {
    return null;
  }
}

// Fetch a server-relative asset (e.g. a /api/tasks/N/event.ics calendar link) with the claim token and
// save it. Resolves to the file path, or null on any failure — saving an attachment must never break chat.
export async function saveServerAsset(client, url, ext) {
  try {
    const r = await fetch(client.base + url, { headers: { Authorization: `Bearer ${client.token}` } });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const file = nextPath(ext);
    writeFileSync(file, buf);
    return file;
  } catch {
    return null;
  }
}
