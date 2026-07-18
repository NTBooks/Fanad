// The server-owned client config + its dirty-tracked version: the web loads this instead of hardcoding the
// taxonomy / commands / onboarding copy / provider list, and refetches it only when the version moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-cfg-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { getClientConfig, getConfigVersion } = await import('../server/clientConfig.js');
const { addCustomCategory, removeCategory } = await import('../server/categories.js');

migrate();

test('client config exposes the server-owned data the web must not hardcode', () => {
  const c = getClientConfig();
  assert.ok(Array.isArray(c.categories) && c.categories.length);
  assert.ok(c.categories.every((x) => x.key && x.label));      // every row is { key, label }
  assert.ok(c.categories.some((x) => x.key === 'work' && x.label === 'Work'));
  assert.deepEqual(c.effortLevels, ['trivial', 'low', 'medium', 'high']);
  assert.ok(c.argless.includes('/tasks'));                     // tappable-command list (was ARGLESS_COMMANDS)
  assert.match(c.rules, /Rules of Fanad/);                     // onboarding copy (was duplicated in App.jsx)
  assert.match(c.howto, /How to fill/);
  assert.ok(c.providers.some((p) => p.id === 'lmstudio' && p.cloud === false)); // provider catalog (was in Settings.jsx)
  assert.ok(c.providers.some((p) => p.id === 'openai' && p.cloud === true));
  // The single-letter shortcut table + argless-command gating map (shared/commands.js) — the web's
  // wide-screen legend renders these; each row's `feature` lets the client filter by opt-in.
  assert.ok(c.shortcuts.some((s) => s.key === 'n' && s.command === '/note' && s.kind === 'with_text' && s.feature === 'notes'));
  assert.ok(c.shortcuts.some((s) => s.key === 'w' && s.command === '/whatdo' && s.kind === 'bare' && s.feature === null));
  assert.ok(c.shortcuts.some((s) => s.key === 'c' && s.command === '/menu' && s.menuOnly === true));
  assert.equal(c.commandFeatures['/tally'], 'metrics');
  assert.equal(c.commandFeatures['/tasks'], undefined);          // core commands carry no gate
  assert.ok(typeof c.version === 'string' && c.version.length);
  assert.equal(c.defaultTheme, 'auto');                        // WEB_DEFAULT_THEME unset ⇒ the safe default
  // The legacy display-only 'entertainment' key is in CATEGORY_ORDER but NOT a live category — excluded here.
  assert.ok(!c.categories.some((x) => x.key === 'entertainment'));
});

test('the version is stable until the taxonomy changes, then moves (the dirty tracker)', () => {
  const v0 = getConfigVersion();
  assert.equal(getConfigVersion(), v0);                         // cached: same content ⇒ same version

  addCustomCategory('astronomy');                               // mutate the taxonomy → marks config dirty
  const v1 = getConfigVersion();
  assert.notEqual(v1, v0);
  assert.ok(getClientConfig().categories.some((x) => x.key === 'astronomy' && x.label === 'Astronomy'));

  removeCategory('astronomy');                                  // mutate again → dirty again
  const v2 = getConfigVersion();
  assert.notEqual(v2, v1);
  assert.ok(!getClientConfig().categories.some((x) => x.key === 'astronomy'));
});
