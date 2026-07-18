// Message list → flat display lines for the hand-rolled scroll viewport (Ink clips but
// doesn't scroll, so the transcript is a line array we slice a window out of). Pure module — no Ink —
// so the wrap/label logic is testable and reusable by the --plain renderer.
//
// Width math uses string-width (not .length): emoji and CJK are double-width on screen, and a wrap that
// miscounts them drifts every border on Windows (the wide-glyph gotcha the plan calls out). string-width
// ignores ANSI escapes, so toAnsi-styled bot text wraps by its VISIBLE width.
import stringWidth from 'string-width';
import { toAnsi } from '../../shared/cli-format.js';

// Greedy word wrap honoring display width. Words longer than the line hard-break by grapheme run.
export function wrapText(text, width) {
  const w = Math.max(4, width);
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    if (para === '') { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (stringWidth(word) > w) {
        if (line) { out.push(line); line = ''; }
        let chunk = '';
        for (const ch of word) {
          if (stringWidth(chunk + ch) > w) { out.push(chunk); chunk = ch; } else chunk += ch;
        }
        line = chunk;
        continue;
      }
      const joined = line ? `${line} ${word}` : word;
      if (stringWidth(joined) > w) { out.push(line); line = word; } else line = joined;
    }
    out.push(line);
  }
  return out;
}

const fmtTime = (at) => {
  if (!at) return '';
  const d = new Date(Number(at));
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// One message → its display lines. kinds: 'label-me' | 'label-bot' | 'me' | 'bot' | 'error' | 'gap'.
// Chat-style alignment: the bot sits on the LEFT (2-cell indent), your own turns sit on the RIGHT —
// each me line carries `pad` (leading spaces) so its text ends 2 cells from the right edge, the mirror
// of the bot's indent. The label rides the same edge as its bubble; a reaction hangs after the me label
// (read-receipt style) and counts toward the pad math. `colors` off (NO_COLOR/pipes) strips markup
// instead of styling it — the toAnsi gate.
export function messageLines(msg, width, botName = 'Fanad', colors = true) {
  const bodyWidth = Math.max(4, width - 2);
  const isMe = msg.role === 'me';
  const who = isMe ? 'you' : botName;
  const when = fmtTime(msg.at);
  const reaction = isMe ? (msg.botReaction || msg.reaction || null) : null;
  const labelText = when ? `${who} · ${when}` : who;
  const rightPad = (visible) => Math.max(0, width - stringWidth(visible) - 2);
  const label = {
    kind: isMe ? 'label-me' : 'label-bot',
    text: labelText,
    reaction,
    pad: isMe ? rightPad(reaction ? `${labelText}  ${reaction}` : labelText) : 0,
  };
  // Only a bot turn flagged html:true carries richtext markup; everything else (your own typed text,
  // wakeups, plain replies) renders verbatim — a literal "<b>" the user typed must never style.
  const text = msg.error ? String(msg.text) : toAnsi(msg.text, !isMe && !!msg.html, colors);
  const body = wrapText(text, bodyWidth).map((t) => ({
    kind: msg.error ? 'error' : (isMe ? 'me' : 'bot'),
    text: t,
    pad: isMe ? rightPad(t) : 0,
  }));
  return [label, ...body, { kind: 'gap', text: '' }];
}

export function buildLines(messages, width, botName = 'Fanad', colors = true) {
  const out = [];
  // Lines carry their source message's key so the renderer can flash a just-arrived turn (entrance fade).
  for (const m of messages) out.push(...messageLines(m, width, botName, colors).map((l) => ({ ...l, msgKey: m.key })));
  if (out.length && out[out.length - 1].kind === 'gap') out.pop(); // no trailing blank under the newest turn
  return out;
}
