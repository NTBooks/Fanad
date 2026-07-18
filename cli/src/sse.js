// SSE reader for GET /api/stream — pure Node, no Ink. Node has no EventSource, and the browser one
// couldn't send the Authorization header anyway, so the event stream is parsed straight off the fetch
// body. Pokes carry only a type ('chat'/'wakeup'/'config'); the caller re-pulls the
// matching endpoint. Auto-reconnects with capped exponential backoff; onState reports 'live' | 'poll'
// (disconnected — the caller falls back to web poll cadences) | 'dead' (the token itself was rejected).
export function startEventStream({ base, token, onPoke, onState }) {
  let stopped = false;
  let attempt = 0;
  let abort = null;

  (async () => {
    while (!stopped) {
      try {
        abort = new AbortController();
        const r = await fetch(`${base}/api/stream`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          signal: abort.signal,
        });
        if (r.status === 401 || r.status === 403) { onState?.('dead'); return; }
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
        // A server without /api/stream doesn't 404 — Express's SPA catch-all answers 200 text/html
        // (index.html). Naively treating any 200 as a stream made the pill flap live→poll→live forever
        // (the HTML "stream" ends instantly, reconnect succeeds, repeat). Only an actual event stream
        // counts as live; anything else = the endpoint doesn't exist here — settle into polling and
        // re-probe lazily (the server may be upgraded/restarted later).
        const contentType = String(r.headers.get('content-type') || '');
        if (!contentType.includes('text/event-stream')) {
          try { abort.abort(); } catch { /* body already done */ }
          onState?.('poll');
          await new Promise((resolve) => { setTimeout(resolve, 60000); });
          continue;
        }
        onState?.('live');
        attempt = 0;
        // Frames are \n\n-separated; `data: <type>` lines are pokes, `: ping` comments keep-alives.
        let buf = '';
        for await (const chunk of r.body) {
          buf += Buffer.from(chunk).toString('utf8');
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            for (const line of frame.split('\n')) {
              if (line.startsWith('data:')) onPoke?.(line.slice(5).trim());
            }
          }
        }
        throw new Error('stream ended'); // server restart/proxy cut — reconnect below
      } catch {
        if (stopped) return;
        onState?.('poll');
        attempt += 1;
        const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)); // 2s → 4s → … → 30s cap
        await new Promise((resolve) => { setTimeout(resolve, delay); });
      }
    }
  })();

  return () => { stopped = true; try { abort?.abort(); } catch { /* already gone */ } };
}
