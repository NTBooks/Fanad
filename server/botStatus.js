// The connected chat bot's public identity (e.g. Telegram's @username from getMe), set by a channel
// adapter when it comes up and cleared when it stops. Lives in its own tiny module so the web routes
// can read it without importing a channel adapter (which would drag in grammY and risk an import cycle).
let identity = null; // { platform: 'telegram' | 'slack', username } | null

export function setBotIdentity(next) { identity = next || null; }
export function getBotIdentity() { return identity; }
