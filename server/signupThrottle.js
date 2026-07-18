// In-memory per-IP rate/seat tracking for the UNAUTHENTICATED public signup surfaces — the Telegram /demo
// form (routes/demo.js) and the browser demo register (routes/auth.js). A public POST must not be a free
// enumeration or account/whitelist-stuffing loop. Everything lives in a Map keyed by normalized IP; the map
// self-prunes so it can't grow unbounded, and a restart simply resets it — that's fine, the real backstops
// are the global caps (maxVouchedUsers / maxWebDemoAccounts) and the signup switch itself.
//
// One factory builds both shapes from the same primitives:
//  · a request-RATE throttle (fixed `max`): `if (t.over(ip)) reject; t.record(ip);` — every attempt that
//    reaches the door counts, matching the old demo.js throttled() (record on pass, nothing on reject).
//  · a per-IP SEAT cap with a LIVE, owner-tunable limit: `if (t.count(ip) >= liveCap) reject;` and
//    `t.record(ip)` only on a genuine success, so a rejected or idempotent submission costs nothing.
export function createSignupThrottle({ windowMs, max = 0 }) {
  const byIp = new Map(); // normalized ip → [timestamps within the window]
  const fresh = (ip, now) => (byIp.get(ip) || []).filter((t) => now - t < windowMs);

  // Current count within the window, pruning this ip's expired entries as a side effect.
  function count(ip) {
    const now = Date.now();
    const hits = fresh(ip, now);
    byIp.set(ip, hits);
    return hits.length;
  }
  // At/over the fixed `max` (0 = off → never over). Read-only — does NOT record.
  function over(ip) {
    return max > 0 && count(ip) >= max;
  }
  // Stamp one hit now, and opportunistically prune dead keys so the map can't grow unbounded.
  function record(ip) {
    const now = Date.now();
    const hits = fresh(ip, now);
    hits.push(now);
    byIp.set(ip, hits);
    if (byIp.size > 1000) {
      for (const [k, v] of byIp) if (!v.some((t) => now - t < windowMs)) byIp.delete(k);
    }
  }
  return { count, over, record };
}
