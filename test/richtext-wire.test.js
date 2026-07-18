// Guard: every reply we flag html:true must be VALID Telegram HTML — only the whitelisted tags, balanced,
// no attributes, and no stray/unescaped <, >, & (which would make Telegram 400 the whole message). We drive
// real surfaces through the brain (incl. adversarial input full of HTML specials) and validate the wire text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-rtwire-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage, handleAction } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const { defaultUserId, insertTask } = await import('../server/repo.js');

migrate();
const uid = defaultUserId();
const say = (text) => { clearDialogState(uid); return handleMessage({ userId: uid, text }); };

// Telegram's accepted inline tags (the subset we actually emit is b/i/code; allow the synonyms for safety).
const ALLOWED = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre']);
// Returns an error string if `s` is not valid Telegram HTML, else null.
function htmlError(s) {
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*)?)>/g;
  const stack = []; let m;
  while ((m = tagRe.exec(s)) !== null) {
    const name = m[2].toLowerCase();
    if (!ALLOWED.has(name)) return `disallowed tag <${m[1]}${name}>`;
    if (m[3]) return `tag carries attributes: ${m[0]}`;
    if (m[1] === '/') { if (stack.pop() !== name) return `unbalanced close </${name}>`; }
    else stack.push(name);
  }
  if (stack.length) return `unclosed <${stack[stack.length - 1]}>`;
  // After removing valid tags and the three legal entities, NO bare <, >, & may remain.
  const bare = s.replace(tagRe, '').replace(/&(amp|lt|gt);/g, '');
  if (/[<>&]/.test(bare)) return `stray unescaped < > or & in: ${JSON.stringify(s)}`;
  return null;
}

const assertValid = (reply, where) => {
  if (!reply || !reply.html) return; // only html:true replies must be valid HTML
  const err = htmlError(reply.reply ?? reply.text ?? '');
  assert.equal(err, null, `${where}: ${err}`);
};

test('htmlError catches the failure modes it is meant to', () => {
  assert.equal(htmlError('<b>ok</b> · <i>x</i>'), null);
  assert.ok(htmlError('<b>oops'));                 // unclosed
  assert.ok(htmlError('a < b'));                    // stray <
  assert.ok(htmlError('Tom & Jerry'));              // stray &
  assert.ok(htmlError('<span>no</span>'));          // disallowed tag
  assert.ok(htmlError('<b class="x">no</b>'));      // attributes
  assert.equal(htmlError('renew by &lt;when&gt; &amp; go'), null); // legal entities
});

test('list / capture / transition surfaces emit valid HTML — even with adversarial titles', async () => {
  // Adversarial: titles and a step full of HTML specials must come out escaped, not raw.
  const a = insertTask({ userId: uid, summary: 'fix <script> & "tags" > here', category: 'admin', effortLevel: 'high', priority: 3, dueAt: Date.now() + 86400000, dueKind: 'by' });
  insertTask({ userId: uid, summary: 'plain task', category: 'household', effortLevel: 'low' });
  insertTask({ userId: uid, summary: 'urgent <thing>', category: 'work', effortLevel: 'low', dueAt: Date.now() + 3600000, dueKind: 'today' }); // due today → bold deadline path

  assertValid(await say('/tasks'), '/tasks grouped');
  assertValid(await say('a <b>cap</b> & go'), 'capture confirmation'); // files a task whose words have specials
  assertValid(await handleAction(uid, `a:start:${a.id}`), 'start card');
  assertValid(await say('step rinse <the> pan & dry'), 'step add');
  assertValid(await say('/tasks'), '/tasks after changes');
  assertValid(await say(`/done_1`), 'done');
});

test('many tasks → overview + a paginated slice emit valid HTML', async () => {
  for (let i = 1; i <= 14; i++) insertTask({ userId: uid, summary: `work <${i}> & co`, category: 'work', effortLevel: 'low' });
  assertValid(await say('/tasks'), 'overview');           // > MANY_TASKS → counts overview
  assertValid(await say('/tasks work'), 'slice page 1');  // drill → paginated slice
  assertValid(await handleAction(uid, 'm:page:next'), 'slice page 2');
});

test('command hub sections + guides/rules/howto emit valid HTML', async () => {
  const hub = await say('/commands');
  for (const tokn of (hub.buttons || []).flat().map((x) => x.data).filter((d) => /^m:cmd:/.test(d))) {
    assertValid(await handleAction(uid, tokn), `section ${tokn}`);
  }
  for (const g of ['guide steps', 'guide reminders', 'guide capturing', 'guide notes', '/rules', '/howto', 'guide']) {
    assertValid(await say(g), g);
  }
});
