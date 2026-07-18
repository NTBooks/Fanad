// Manual task priority — set in words ("high/med/low priority", "urgent") or by number ("p1", "priority 2").
// Convention (confirmed with the user): P1 = highest. Stored as an integer where higher = more urgent:
// 3 = high · 2 = medium · 1 = low · null = unset. Pure + shared (server + tests); no LLM, no I/O.

export const PRIORITY = { HIGH: 3, MEDIUM: 2, LOW: 1 };

const WORD_LEVEL = {
  highest: 3, high: 3, top: 3, urgent: 3, critical: 3, asap: 3,
  medium: 2, med: 2, moderate: 2, normal: 2,
  lowest: 1, low: 1, whenever: 1, someday: 1, eventually: 1,
};
const WORDS = Object.keys(WORD_LEVEL).join('|');

// P1 = highest: number 1 → high, 2 → medium, 3+ → low.
const numToLevel = (n) => (n <= 1 ? 3 : n === 2 ? 2 : 1);

// Patterns tried in order. Each captures the level cue AND is removed from the summary text, since the
// priority is metadata, not part of the task wording. Word forms 1–2 require "priority" adjacency so an
// ordinary "high-protein lunch" isn't mistaken for a priority; standalone "urgent"/"asap" are strong
// enough cues on their own.
const PATTERNS = [
  { re: new RegExp(`\\b(${WORDS})[ -]?priority\\b`, 'i'), level: (m) => WORD_LEVEL[m[1].toLowerCase()] },
  { re: new RegExp(`\\bpriority[ :=]*\\s*(${WORDS}|[1-9])\\b`, 'i'), level: (m) => (/^\d+$/.test(m[1]) ? numToLevel(Number(m[1])) : WORD_LEVEL[m[1].toLowerCase()]) },
  { re: /\bp([1-3])\b/i, level: (m) => numToLevel(Number(m[1])) },
  { re: /\b(urgent|asap)\b/i, level: () => 3 },
];

// Detect a priority cue. Returns { level, clean } where `clean` is the text with the cue removed
// (whitespace + dangling separators tidied), or null when there's no cue.
export function parsePriority(text) {
  const s = String(text || '');
  for (const { re, level } of PATTERNS) {
    const m = re.exec(s);
    if (!m) continue;
    const lvl = level(m);
    if (!lvl) continue;
    const clean = (s.slice(0, m.index) + s.slice(m.index + m[0].length))
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([.,;:!?])/g, '$1')
      .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '')
      .trim();
    return { level: lvl, clean };
  }
  return null;
}

export function priorityLabel(level) {
  return level === 3 ? 'high' : level === 2 ? 'med' : level === 1 ? 'low' : '';
}

// A compact marker for task lists / the filed confirmation. Empty when unset.
export function priorityMark(level) {
  return level === 3 ? '🔴 high' : level === 2 ? '🟠 med' : level === 1 ? '🔵 low' : '';
}
