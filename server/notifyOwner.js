// Fire-and-forget push to the deployment owner's own Telegram chat — the "someone vouched someone in"
// heads-up. Lives in its own module (not chat.js) because chat.js must not import channels/telegram.js:
// telegram.js → telegram-handler.js → chat.js is already an import chain, and closing that loop makes the
// cycle load-order-sensitive. The Telegram sender is resolved lazily (dynamic import) for the same reason,
// and is injectable so tests can observe delivery. Best-effort by contract: a failed push logs and is
// dropped — it must NEVER break the action that triggered it.
import { getTelegramConfig } from './settings.js';

let sender = null;
export function setOwnerNotifier(fn) { sender = fn; } // tests: capture instead of sending

export function notifyOwner(text) {
  const ownerId = getTelegramConfig().ownerId;
  if (ownerId == null) return; // unclaimed box — nobody to tell
  Promise.resolve()
    .then(async () => {
      const send = sender || (await import('./channels/telegram.js')).sendTelegram;
      return send(text, ownerId);
    })
    .catch((err) => console.error('owner notification failed (dropped):', err.message));
}
