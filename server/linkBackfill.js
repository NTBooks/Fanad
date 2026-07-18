// One-shot startup backfill for tasks captured BEFORE link previews existed (or while LINK_PREVIEW was
// off): any open task whose text carries a URL but has no stored preview gets fetched now, so old rows
// grow the clickable title too. Self-terminating with zero bookkeeping: even a failed fetch writes a
// link_json record (status 'error'/'blocked'/'timeout'), and the query only selects link_json IS NULL —
// the next boot finds nothing to do. Fire-and-forget from index.js; never throws, never blocks boot.
import { listTasksNeedingLinkBackfill, setTaskLink } from './repo.js';
import { extractUrl, fetchLinkPreview } from './services/linkpreview.js';
import { chooseTaskTitle } from './ingest.js';
import { config } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function backfillLinkPreviews({ delayMs = 250 } = {}) {
  if (!config.linkPreview.enabled) return { scanned: 0, filled: 0 };
  let scanned = 0; let filled = 0;
  try {
    const rows = listTasksNeedingLinkBackfill(); // LIKE-prefiltered; extractUrl below is the real check
    for (const t of rows) {
      const found = extractUrl(t.original_text || t.summary || '');
      if (!found) continue;
      if (scanned++ > 0) await sleep(delayMs); // sequential + spaced — a backfill must not hammer anyone
      const preview = await fetchLinkPreview(found.url, config.linkPreview);
      // Title upgrade for the narrow safe case only: the task was a bare pasted URL AND its title today IS
      // that raw URL — replacing it with the fetched page title is a strict improvement. A title the user
      // (or the LLM) actually wrote is never touched, and no classification is re-run here.
      const bareUrlTitle = found.isBare && String(t.summary || '').trim() === found.url;
      const newTitle = (bareUrlTitle && preview.title) ? chooseTaskTitle(preview.title, null) : null;
      setTaskLink(t.user_id, t.id, JSON.stringify(preview), newTitle);
      filled++;
    }
    if (filled) console.log(`[linkBackfill] stored link previews for ${filled} existing task(s)`);
  } catch (err) {
    console.error('[linkBackfill] failed:', err.message);
  }
  return { scanned, filled };
}
