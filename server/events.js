// The in-process event bus behind GET /api/stream: repo chokepoints announce that
// something changed for a user ('chat' / 'wakeup', or a null-user broadcast for 'config'), and each
// connected SSE client with a matching id gets poked. A poke carries NO data — the client re-calls the
// existing endpoints (/api/chat/new?after=, /api/wakeups, /api/config), which preserves drain-on-read
// semantics for wakeups, reuses all existing serialization, and makes polling a trivially identical
// fallback. Module-level singleton; imports nothing from the app, so any module may emit without cycles.
import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
bus.setMaxListeners(0); // one listener per connected client — unbounded by design, not a leak

// userId null = broadcast (global config changes concern every connected client).
export function emitUserEvent(userId, type) {
  bus.emit('event', { userId: userId == null ? null : Number(userId), type: String(type) });
}

// Subscribe for one or more user ids (a request's identity AND its current notebook — over-poking a
// hint channel is harmless, missing a poke is a 5s-poll wait). Returns the unsubscribe.
export function subscribeUserEvents(userIds, fn) {
  const ids = new Set([].concat(userIds).map(Number).filter(Number.isFinite));
  const handler = (ev) => { if (ev.userId === null || ids.has(ev.userId)) fn(ev.type); };
  bus.on('event', handler);
  return () => bus.off('event', handler);
}
