// One display line (from lines.js) → one styled Ink row. Shared by the full-screen Transcript and the
// --plain renderer so the two surfaces paint identically. wrap="truncate" stops Ink re-wrapping what
// lines.js already wrapped (double-wrap would break the viewport's height math).
import { Text } from 'ink';

// `fresh` renders the whole line dim for a beat — the 1–2 frame entrance fade a just-arrived turn gets
// before settling into the scroll buffer (fade in, never slide/reflow). Me lines carry
// `pad` from lines.js — leading spaces that right-align your own turns (chat-style: you on the right,
// the bot on the left).
const padOf = (line) => (line.pad ? ' '.repeat(line.pad) : '');

export default function Line({ line, fresh = false }) {
  switch (line.kind) {
    case 'label-me':
      return (
        <Text wrap="truncate" dimColor={fresh}>
          {padOf(line)}
          <Text color="cyan" bold>{line.text}</Text>
          {line.reaction ? <Text dimColor>  {line.reaction}</Text> : null}
        </Text>
      );
    case 'label-bot':
      return <Text wrap="truncate" color="magenta" bold dimColor={fresh}>{line.text}</Text>;
    case 'me':
      return <Text wrap="truncate" color="cyan" dimColor={fresh}>{padOf(line)}{line.text}</Text>;
    case 'error':
      return <Text wrap="truncate" color="red" dimColor={fresh}>{'  '}{line.text}</Text>;
    case 'gap':
      return <Text> </Text>;
    default: // 'bot'
      return <Text wrap="truncate" dimColor={fresh}>{'  '}{line.text}</Text>;
  }
}
