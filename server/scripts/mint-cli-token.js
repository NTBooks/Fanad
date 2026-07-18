// Mint / list / revoke CLI claim tokens — the `fanad <server> <token>` terminal client's credentials
// Runs on the server host (it opens the DB directly), so possession of the box is the
// authorization; the web mirror is the owner-gated Security panel.
//
//   node --env-file-if-exists=.env server/scripts/mint-cli-token.js [--user <id>] [--label <text>] [--ttl <days>] [--read-only]
//   node --env-file-if-exists=.env server/scripts/mint-cli-token.js --list
//   node --env-file-if-exists=.env server/scripts/mint-cli-token.js --revoke <id>
//
// Default: mint for root with a 90-day TTL. --ttl 0 = never expires. The raw token prints ONCE, here —
// only its hash is stored, so there is no way to see it again (mint a new one instead).
import { migrate } from '../db.js';
import { mintCliToken, listCliTokens, revokeCliToken, CLI_TOKEN_DEFAULT_TTL_DAYS } from '../auth.js';
import { defaultUserId, getUser } from '../repo.js';
import { getSiteConfig, getAuthConfig } from '../settings.js';
import { config } from '../config.js';

migrate(); // idempotent — ensure schema exists when run standalone (the app migrates at startup).

// The terminal client is an owner OPT-IN (default off). Box access = top trust, so the script still
// works — but a token minted while the switch is off won't authenticate, and silence there would read
// as a broken client. Say so loudly instead.
if (!getAuthConfig().cliEnabled) {
  console.warn('⚠ The terminal client is DISABLED on this server — tokens will not work until it\'s enabled');
  console.warn('  (web Settings → Security → Terminal client tokens → “Enable the terminal client”).\n');
}

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : (args[i + 1] ?? '');
};
const has = (name) => args.includes(`--${name}`);

const fmtWhen = (ms) => (ms == null ? '—' : new Date(Number(ms)).toISOString().slice(0, 16).replace('T', ' '));
const stateOf = (t) => {
  if (t.revoked_at != null) return 'revoked';
  if (t.expires_at != null && Number(t.expires_at) <= Date.now()) return 'expired';
  return 'live';
};

if (has('help') || has('h')) {
  console.log('Usage: fanad token [--user <id>] [--label <text>] [--ttl <days>] [--read-only] | --list | --revoke <id>');
  console.log('  --read-only  GET-only token for dashboards / Home Assistant (cannot write anything)');
  process.exit(0);
}

if (has('list')) {
  const tokens = listCliTokens();
  if (!tokens.length) { console.log('No CLI tokens minted yet.'); process.exit(0); }
  console.log('id  user  state    scope  label                 created           last used         expires');
  for (const t of tokens) {
    const name = getUser(Number(t.user_id))?.display_name || '';
    console.log([
      String(t.id).padEnd(3), `${t.user_id}${name ? ` (${name})` : ''}`.padEnd(5), stateOf(t).padEnd(8),
      (t.scope === 'read' ? 'read' : 'full').padEnd(6),
      String(t.label || '—').slice(0, 20).padEnd(21), fmtWhen(t.created_at).padEnd(17),
      fmtWhen(t.last_used_at).padEnd(17), t.expires_at == null ? 'never' : fmtWhen(t.expires_at),
    ].join(' '));
  }
  process.exit(0);
}

if (has('revoke')) {
  const id = Number(flag('revoke'));
  if (!Number.isInteger(id) || id <= 0) { console.error('Usage: fanad token --revoke <id>   (ids from --list)'); process.exit(1); }
  if (revokeCliToken(id)) { console.log(`Token ${id} revoked — the client's next request will be rejected.`); process.exit(0); }
  console.error(`Token ${id} not found (or already revoked).`);
  process.exit(1);
}

// Mint (the default action).
const userId = flag('user') != null ? Number(flag('user')) : defaultUserId();
const ttlRaw = flag('ttl');
const ttlDays = ttlRaw != null ? Number(ttlRaw) : CLI_TOKEN_DEFAULT_TTL_DAYS;
if (!Number.isFinite(ttlDays) || ttlDays < 0) { console.error('--ttl must be a number of days (0 = never expires).'); process.exit(1); }

const scope = has('read-only') ? 'read' : 'full';
let token;
try {
  token = mintCliToken(userId, { label: flag('label') || null, ttlDays, scope });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// The paste line uses the configured public URL when the operator has set one; localhost otherwise.
const serverUrl = getSiteConfig().url || `http://localhost:${config.port}`;
const who = getUser(Number(userId))?.display_name;
console.log(`CLI token minted for user ${userId}${who ? ` (${who})` : ''} — ${ttlDays > 0 ? `expires in ${ttlDays} days` : 'never expires'}${scope === 'read' ? ', READ-ONLY' : ''}.`);
console.log('It is shown ONCE (only its hash is stored). Connect with:\n');
console.log(`  fanad ${serverUrl} ${token}\n`);
console.log('Manage tokens: fanad token --list · fanad token --revoke <id>');
process.exit(0);
