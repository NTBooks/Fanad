// One-off: re-embed every task and note for all users with the CURRENTLY configured embed
// provider/model. Run this after switching embed providers (e.g. local → Gemini): stored vectors carry a
// model-specific geometry, and cosine() in rag/vector.js silently truncates to the shorter length, so
// mixing models corrupts recall rather than erroring. insertEmbedding is INSERT OR REPLACE keyed on
// (user_id, owner_type, owner_id), so this overwrites old vectors in place.
//
//   node --env-file-if-exists=.env server/scripts/reindex-embeddings.js
//
// Requires the embed provider to be reachable (for Gemini: LLM_ALLOW_CLOUD=true + a saved GEMINI_API_KEY).
import { migrate } from '../db.js';
import { listUsers, listTasks, listNotes } from '../repo.js';
import { embedTask, embedNote, embedModelId } from '../rag/index.js';
import { embed } from '../services/llm/index.js';
import { getLlmConfig } from '../settings.js';

migrate(); // idempotent — ensure schema exists when run standalone (the app migrates at startup).
const c = getLlmConfig();
console.log(`Reindex embeddings → provider=${c.embedProvider} model=${embedModelId() || '(auto)'}\n`);

// Pre-flight: one real embed call. Aborts before touching data if the provider is disabled/misconfigured
// (cloud off, missing/invalid key, wrong model) — better than half-migrating and silently leaving stale rows.
try {
  const probe = await embed('reindex preflight');
  if (!probe || !probe.length) throw new Error('embed() returned no vector');
  console.log(`Pre-flight OK — embedding dimension ${probe.length}.\n`);
} catch (e) {
  console.error(`Pre-flight FAILED: ${e.message}`);
  console.error('Fix the embed provider (LLM_ALLOW_CLOUD + API key + model) and re-run. No data changed.');
  process.exit(1);
}

let ok = 0;
const failures = [];
async function run(label, vecPromise) {
  const vec = await vecPromise;          // helpers swallow errors and return null on failure
  if (vec && vec.length) ok += 1;
  else failures.push(label);
}

for (const user of listUsers()) {
  const tasks = listTasks(user.id);
  const notes = listNotes(user.id);
  for (const t of tasks) await run(`user ${user.id} task ${t.id}`, embedTask(t));
  for (const n of notes) await run(`user ${user.id} note ${n.id}`, embedNote(n));
  console.log(`user ${user.id}: ${tasks.length} tasks, ${notes.length} notes`);
}

console.log(`\nDone — ${ok} re-embedded, ${failures.length} failed.`);
if (failures.length) {
  console.error('Failed (left with their previous vector — re-run to retry):');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
