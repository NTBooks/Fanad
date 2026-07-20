// Speed Dial feature — the chat surface for owner-curated Home Assistant command pads. Two audiences:
// the OWNER authors pads ("sd @user 3 = turn off the kitchen lights", "sd @user limit on", bare "sd" board);
// a NON-limited pad-holder fires a number (bare "0-9", "dial 3") or views it ("pad" / "dial"). LIMITED accounts
// never reach here — chat.js short-circuits them at route()/handleAction() to the same engine (speedDialGate).
// The pad runs owner-authored text through HA Assist (converse) against the owner's single connection; the
// guest only ever sends a digit, so their input is never free text to HA or an LLM. m:sd:<n> button taps are
// handled in chat.js handleAction (on the IDENTITY, so being inside a notebook can't hide the pad), not as a
// registry menuAction.
import { isOwner, hasSpeedDial } from '../repo.js';
import { padView, fireSlot, ownerCommand } from '../speeddial.js';
import { registerFeature } from './registry.js';

registerFeature({
  name: 'speeddial',
  commands: [
    {
      // OWNER authoring. "speeddial …" (distinctive) matches freely; short "sd" only before "@handle" or when
      // bare (so "sd card reader" still files as a task). Guarded on isOwner so a guest's "sd …" falls through.
      match: ({ lower, identityId }) => isOwner(identityId) && (/^\/?speeddial\b/i.test(lower) || /^\/?sd(?:\s+@|\s*$)/i.test(lower)),
      run: ({ identityId, t }) => ownerCommand(identityId, t),
    },
    {
      // "0" / "pad" / "dial" shows the pad. "0" is the reserved "show my numbers" key — available any time,
      // like an old phone's operator/menu (so slot 0 is fired only by tap or "dial 0", never a bare "0").
      match: ({ lower, identityId }) => hasSpeedDial(identityId) && /^(?:\/?(?:pad|dial)|0)$/i.test(lower),
      run: ({ identityId }) => padView(identityId),
    },
    {
      // A pad-holder fires an explicit "dial 3" / "/dial 3" (the only way to fire slot 0 now: "dial 0").
      match: ({ lower, identityId }) => hasSpeedDial(identityId) && /^\/?dial\s*#?[0-9]$/i.test(lower),
      run: ({ identityId, t }) => fireSlot(identityId, Number((/([0-9])\s*$/.exec(t) || [])[1])),
    },
    {
      // A pad-holder sends a bare 1-9 — the phone-speed-dial gesture (0 is reserved for "show pad" above).
      // Gated on hasSpeedDial so everyone else's "3" still files as a task exactly as before.
      match: ({ lower, identityId }) => hasSpeedDial(identityId) && /^[1-9]$/.test(lower),
      run: ({ identityId, t }) => fireSlot(identityId, Number(t.trim())),
    },
  ],
});
