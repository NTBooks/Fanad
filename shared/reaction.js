// The reaction Fanad leaves on the USER's own message — shared so Telegram and the web agree on which
// emoji a turn deserves. Two-step ack: 👀 "thinking" the instant the message lands, then a swap to the
// decision emoji once the reply is ready — the mood emoji for a mood set, ✍ for a filed note, else 🫡
// (🤬 on error). ✍ is the bare U+270D (no VS16) Telegram's reaction API expects.
export const REACT_DONE = '\u{1FAE1}';  // 🫡 generic ack
export const REACT_NOTE = '✍';     // ✍  filed note
export const REACT_THINK = '\u{1F440}'; // 👀 transient "thinking"
export const REACT_ERROR = '\u{1F92C}'; // 🤬 error swap

// The individual emoji characters in a mood string (variation selectors dropped), in order.
export const moodChars = (moodEmoji) => String(moodEmoji || '').match(/\p{Extended_Pictographic}/gu) || [];

// The decision as a raw-unicode emoji. `pick` lets a channel constrain a mood char to its own allowed
// set (Telegram only accepts a fixed reaction list); the default accepts any char — the web can render
// any emoji, so a mood set surfaces the literal mood emoji the user sent.
// kind:'ack' is a contentless acknowledgment (a bare 🌱/👍 reply): the reaction IS the whole answer, with
// `ackEmoji` as the preferred face — same allowed-set fallback as a mood (an emoji-only text bubble would
// render huge on Telegram and clutter every surface, so it becomes a reaction on the user's own message).
export function decideReaction({ kind, moodEmoji, ackEmoji }, pick = () => true) {
  if (kind === 'mood' || kind === 'ack') {
    for (const c of moodChars(kind === 'mood' ? moodEmoji : ackEmoji)) if (pick(c)) return c;
    return REACT_DONE;
  }
  return kind === 'note' ? REACT_NOTE : REACT_DONE;
}
