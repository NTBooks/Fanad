// The seam that lets a self-contained feature module plug into the brain WITHOUT editing chat.js:
// a module calls registerFeature() at import time (features/index.js fixes the order), and chat.js
// consults the registry at one fixed point in route()'s guard chain, in its DIALOG_HANDLERS map, and in
// handleAction()'s token dispatch. Extracted first: timer + metrics; the pattern is the template for
// pulling the other opt-in modules (and eventually persona packs) out of the route() monolith.
//
// Contract — a module is { name, commands?, dialogHandlers?, menuActions? }:
//   commands:       [{ match(ctx) → falsy | hit, run(ctx, hit) → reply }]. First hit wins and its reply
//                   is final (no fall-through) — a matcher that might decline must do so in match().
//   dialogHandlers: { <dialogType>: (userId, text, ds, extras) → reply } — merged into DIALOG_HANDLERS.
//                   The answer PREDICATE for the type still lives in dialog.js (answersPendingState).
//   menuActions:    { <verb>: (userId, d) → reply } — handles the "m:<verb>:<value>" button tokens the
//                   module's own replies emit (menu.js's byte cap applies; keep tokens short).
//   ctx:            { userId, identityId, t, lower, channel, energy, isOn, offerOn } — isOn/offerOn are
//                   passed in from route() so modules never import chat.js (no cycles).
//
// Registration order IS match order. Matchers run at ONE point in the guard chain (after the dialog
// escape, among the explicit commands) — a module whose patterns could collide with core matchers
// elsewhere in the chain can't express that here; extend route() the old way instead.
const modules = [];

export function registerFeature(mod) { modules.push(mod); }

export async function tryFeatureCommand(ctx) {
  for (const mod of modules) {
    // A module disabled system-wide is invisible to non-owners: skip it so its commands FALL THROUGH to the
    // rest of the guard chain (as if the module weren't installed), instead of matching and returning the
    // "turn it on?" offer. ctx.moduleAvailable folds in the owner-preview rule (owner keeps access). 'manual'
    // is always-on (isSystemModuleOn returns true for non-opt-in names), so help is never skipped.
    if (mod.name && ctx.moduleAvailable && !ctx.moduleAvailable(mod.name)) continue;
    for (const c of mod.commands || []) {
      const hit = c.match(ctx);
      if (hit) return { reply: await c.run(ctx, hit) };
    }
  }
  return null;
}

export function featureDialogHandlers() {
  const out = {};
  for (const mod of modules) Object.assign(out, mod.dialogHandlers || {});
  return out;
}

export function featureMenuAction(verb) {
  for (const mod of modules) { if (mod.menuActions?.[verb]) return mod.menuActions[verb]; }
  return null;
}
