// Drift guard for SYNTAX.md ↔ the live router. The spec's command index (the delimited block between
// <!-- drift:begin --> and <!-- drift:end -->) is a list of runnable example invocations; every one must
// route — i.e. avoid the unknown-command fallback in chat.js. This fails loudly when a command is renamed
// or retired in the router but the grammar still advertises it (or vice-versa). It checks the GRAMMAR's
// examples; commands-drift.test.js separately checks the /help prose. Neither generates the doc — the
// curated spec stays hand-written; this just ties it back to reality.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-syntax-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const { defaultUserId } = await import('../server/repo.js');

migrate();
const uid = defaultUserId();
const UNKNOWN = "I don't know that one"; // the unknown-slash fallback in chat.js
// Clear any open dialog first, so one example's question can't swallow the next as its answer.
const reply = async (text) => { clearDialogState(uid); return (await handleMessage({ userId: uid, text })).reply; };

// Pull the runnable examples out of the delimited drift block in SYNTAX.md.
const SPEC = readFileSync(new URL('../SYNTAX.md', import.meta.url), 'utf8');
const block = /<!--\s*drift:begin\s*-->([\s\S]*?)<!--\s*drift:end\s*-->/.exec(SPEC);
const examples = (block ? block[1] : '')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#') && !l.startsWith('```')); // drop fences, comments, blanks

test('SYNTAX.md exposes a delimited, non-empty command index', () => {
  assert.ok(block, 'no <!-- drift:begin --> … <!-- drift:end --> block found in SYNTAX.md');
  assert.ok(examples.length >= 30, `only found ${examples.length} example commands in the drift block`);
});

for (const example of examples) {
  test(`grammar example routes: ${example}`, async () => {
    const r = await reply(example);
    assert.ok(
      !String(r).startsWith(UNKNOWN),
      `"${example}" is documented in SYNTAX.md but hit the unknown-command fallback`,
    );
  });
}
