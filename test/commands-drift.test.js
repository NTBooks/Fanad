// Drift guard for the command surface. Routing is a centralized if/else chain in chat.js, but the
// user-facing lists around it (the /help text, the argless tap-menu) can drift away from it freely.
// This test ties them back to reality: every slash command advertised in /help must actually route,
// and every one-tap (argless) chip must be documented. It does NOT generate help — the curated prose
// stays hand-written; this just fails loudly when prose and router disagree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-drift-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { stripTags } = await import('../shared/richtext.js');
const { handleMessage, handleAction } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const { defaultUserId } = await import('../server/repo.js');
const { ARGLESS_COMMANDS } = await import('../shared/commands.js');

migrate();
// Modules are per-user opt-in (default OFF); the drift check needs every surface visible, so opt root in.
(await import('../server/settings.js')).setUserFeatures(1, { notes: true, lists: true, metrics: true, vouch: true, timer: true, journal: true, homeassistant: true });
const uid = defaultUserId();
// Clear any dialog first, so a prior command's open question can't swallow the next as its "answer".
const reply = async (text) => { clearDialogState(uid); return (await handleMessage({ text })).reply; };
const UNKNOWN = "I don't know that one"; // the unknown-slash fallback in chat.js

// Read the live command reference the way a user actually reaches it: /commands now pops a tappable SECTION
// hub, and each section button (m:cmd:<key>) EXPANDS to its lines. Reconstruct the full reference by opening
// the hub and expanding every section — so this still checks exactly what users are told, just disclosed.
const hub = await handleMessage({ text: '/commands' });
const sectionTokens = (hub.buttons || []).flat().map((b) => b.data).filter((d) => /^m:cmd:/.test(d));
let HELP = hub.reply;
for (const tokn of sectionTokens) { clearDialogState(uid); HELP += `\n${(await handleAction(uid, tokn)).text}`; }
HELP = stripTags(HELP); // sections are rich text now — compare against the visible text (no tags/entities)
// Every "/token" mentioned in /help, deduped. "/task:health" → "/task"; "/done 1 2 3" → "/done".
const tokens = [...new Set((HELP.match(/\/[a-z]+/gi) || []).map((s) => s.toLowerCase()))];

test('/help advertises a healthy set of slash commands (sanity)', () => {
  assert.ok(tokens.length >= 12, `only found ${tokens.length} slash tokens in /help`);
});

// A command "routes" if SOME reasonable shape avoids the unknown-slash fallback. We try a few arg shapes
// so commands that REQUIRE an argument (/recall, /measure, …) aren't mistaken for missing.
const shapes = (tok) => [tok, `${tok} 1`, `${tok} milk`, `${tok} milk 1`];

for (const tok of tokens) {
  test(`documented command ${tok} actually routes`, async () => {
    const replies = [];
    for (const text of shapes(tok)) replies.push(await reply(text));
    const routed = replies.some((r) => !String(r).startsWith(UNKNOWN));
    assert.ok(routed, `${tok} is in /help but every shape hit the unknown-command fallback`);
  });
}

test('every one-tap (argless) command is documented in /help', () => {
  for (const cmd of ARGLESS_COMMANDS) {
    assert.ok(HELP.includes(cmd), `${cmd} is a tappable chip but isn't shown in /help`);
  }
});
