// The onboarding reaction reel (shared/copy.js → /api/config → cfg.reactionDemo). Web-only playback, but the
// copy lives server-side so it has one home; these tests pin its shape and that the config actually ships it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-reel-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { REACTION_DEMO } = await import('../shared/copy.js');
const { REACT_DONE, REACT_NOTE, REACT_THINK, REACT_ERROR } = await import('../shared/reaction.js');
const { migrate } = await import('../server/db.js');
const { getClientConfig } = await import('../server/clientConfig.js');

migrate();

// The decision emojis a real turn can land on — the reel must only ever animate to one of these, so it stays
// truthful to what Fanad actually stamps on a message.
const OUTCOMES = new Set([REACT_DONE, REACT_NOTE, REACT_THINK, REACT_ERROR]);

// Every `react` used across the reel, whether on a single `me` turn or inside a multi-turn `turns` step.
const reactionsIn = (step) => [step.react, ...(step.turns || []).map((t) => t.react)].filter(Boolean);

test('REACTION_DEMO is a non-empty, well-formed reel', () => {
  assert.ok(Array.isArray(REACTION_DEMO) && REACTION_DEMO.length >= 3);
  for (const step of REACTION_DEMO) {
    assert.ok(typeof step.caption === 'string' && step.caption.trim(), 'every step needs a caption');
    for (const r of reactionsIn(step)) {
      assert.ok(OUTCOMES.has(r), `reaction ${JSON.stringify(r)} must be a shared/reaction.js outcome`);
    }
    // A multi-turn step's turns each carry the fake user line.
    for (const t of step.turns || []) assert.ok(typeof t.me === 'string' && t.me.trim());
    // Final-step CTA buttons must each be actionable (a label + the text to drop into the composer).
    for (const c of step.cta || []) {
      assert.ok(typeof c.label === 'string' && c.label.trim());
      assert.ok(typeof c.insert === 'string' && c.insert.trim());
    }
  }
});

test('the reel actually makes the "command pad, not a chatbot" point', () => {
  const captions = REACTION_DEMO.map((s) => s.caption).join('\n').toLowerCase();
  assert.match(captions, /not a chatbot|command pad/);
  // At least one step demonstrates the two-step reaction (has a user turn with a decision emoji).
  assert.ok(REACTION_DEMO.some((s) => reactionsIn(s).length > 0));
  // At least one step shows the "one thought per line" fix (a multi-turn step).
  assert.ok(REACTION_DEMO.some((s) => Array.isArray(s.turns) && s.turns.length > 1));
});

test('the client config ships the reel to the web', () => {
  const c = getClientConfig();
  assert.ok(Array.isArray(c.reactionDemo) && c.reactionDemo.length);
  assert.deepEqual(c.reactionDemo, REACTION_DEMO);
});
