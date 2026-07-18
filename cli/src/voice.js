// The thinking spinner's rotating status words — Fanad's own voice (the assignment-pad register:
// off-loading, sorting, weighing — never clinical, never robotic). The terminal cousin of Claude Code's
// spinner verbs: honest liveness while the brain works, with personality instead of a progress bar.
// Kept client-side by design (the server has no "spinner words" concept to ask for).
const WORDS = [
  'jotting it down', 'sorting the pad', 'weighing it', 'filing', 'untangling',
  'checking the margins', 'sharpening the pencil', 'flipping pages', 'lining things up',
  'reading it back', 'shuffling index cards', 'thinking it over', 'clearing a corner',
  'dotting the i', 'squinting at it', 'making room', 'taking it in', 'mulling',
];

// Deterministic-ish start (varies per process), then a steady walk — no Math.random per tick, so the
// sequence never stutters back onto the same word.
let cursor = process.pid % WORDS.length;
export function nextSpinnerWord() {
  cursor = (cursor + 1) % WORDS.length;
  return WORDS[cursor];
}
