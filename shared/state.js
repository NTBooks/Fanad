// Small pure helpers shared by server + web for capturing "current state".

// Bucket a timestamp into a coarse time-of-day label (uses local time).
export function timeOfDay(ts = Date.now()) {
  const h = new Date(ts).getHours();
  if (h < 5) return 'night';
  if (h < 9) return 'early_morning';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'night';
}

// Generic mood capture: pull every emoji out of the message text (decision: mood = emojis in messages).
export function extractEmojis(text) {
  const m = (text || '').match(/\p{Extended_Pictographic}/gu);
  return m ? m.join('') : '';
}

// Mood words → a representative emoji, so a user can say how they feel in plain words ("overwhelmed",
// "salty") and Fanad reads it exactly like the matching emoji. Each emoji is chosen to land in the
// low/high/hungry energy buckets in chat.js where it should steer suggestion size; anger/neutral words
// map to emoji outside those buckets, so they show in the status chip without nudging energy. We stay
// high-precision on purpose — distinctly affective words only, never generic ones like "good"/"down"
// that show up in ordinary task text.
const MOOD_WORDS = [
  // low energy — tired · drained · sad · sick · stressed · anxious
  [/\b(exhausted|knackered|wiped|burned out|burnt out)\b/i, '😫'],
  [/\b(tired|sleepy|drowsy|fatigued)\b/i, '😴'],
  [/\b(overwhelmed|swamped|frazzled)\b/i, '😵'],
  [/\b(stressed|tense)\b/i, '😰'],
  [/\b(anxious|nervous|scared|afraid)\b/i, '😨'],
  [/\b(worried|uneasy)\b/i, '😟'],
  [/\b(sad|unhappy|depressed|miserable|gloomy)\b/i, '😔'],
  [/\b(lonely|heartbroken)\b/i, '🥺'],
  [/\b(devastated|sobbing)\b/i, '😭'],
  [/\b(sick|unwell|ill|nauseous|queasy)\b/i, '🤒'],
  // hungry — take it gentle
  [/\b(hungry|starving|peckish|famished)\b/i, '🍔'],
  // high energy — bright · pumped · happy
  [/\b(happy|cheerful|joyful)\b/i, '😊'],
  [/\b(excited|thrilled|stoked|psyched|amazing|awesome|fantastic)\b/i, '🤩'],
  [/\b(pumped|energized|energised|motivated)\b/i, '💪'],
  [/\b(elated|ecstatic|overjoyed)\b/i, '🥳'],
  [/\b(confident|unstoppable)\b/i, '😎'],
  [/\b(grateful|thankful|blessed)\b/i, '🥰'],
  // anger / neutral — shown in the status chip but outside the energy buckets
  [/\b(salty|annoyed|irritated|frustrated|grumpy|cranky)\b/i, '😤'],
  [/\b(angry|mad|furious|livid)\b/i, '😠'],
  [/\b(meh|bored|indifferent)\b/i, '😐'],
  [/\b(calm|chill|relaxed|peaceful)\b/i, '😌'],
];

// Capture mood from a message: literal emoji first, then any mood words mapped to an emoji. De-duped,
// first-seen order. This is the chokepoint the snapshot/energy/status pipeline reads, so word-moods
// flow everywhere emoji-moods already do.
export function extractMood(text) {
  let out = extractEmojis(text);
  const s = text || '';
  for (const [re, emoji] of MOOD_WORDS) {
    if (re.test(s) && !out.includes(emoji)) out += emoji;
  }
  return out;
}
