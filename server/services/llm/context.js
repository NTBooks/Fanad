// WHO an LLM call is for. chat()/embed() (index.js) are called from dozens of sites across the brain
// (classify, deadline, journal, diet, rag, manual…) and none of them carry a userId — threading one through
// every signature would touch them all. Instead the few places that KNOW the acting identity (handleMessage,
// the API's uid middleware, the scheduler's per-row loops, the journal sweep) wrap their work in
// runAsLlmUser(), and the budget check at the chokepoint reads it back here via AsyncLocalStorage.
// The budget keys on the IDENTITY (notebooks share their owner's budget). A null store means an unthreaded
// path — the budget exempts it but warns, so gaps stay discoverable (llmBudget.js).
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

export function runAsLlmUser(userId, fn) {
  return als.run({ userId: userId == null ? null : Number(userId) }, fn);
}

export function currentLlmUserId() {
  return als.getStore()?.userId ?? null;
}
