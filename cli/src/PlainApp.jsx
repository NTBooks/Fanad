// The --plain surface (auto-selected for pipes and dumb terminals): append-only rendering with the
// terminal's own scrollback — Ink's <Static> commits each turn exactly once, the composer (when stdin
// is a TTY) stays live below. This is where <Static> earns its place; the full-screen
// path owns the window instead. Buttons render as numbered text hints — type the number to tap.
import { Box, Static, Text } from 'ink';
import { useMemo } from 'react';
import { messageLines } from './lines.js';
import { useChat, isToken } from './useChat.js';
import Line from './components/Line.jsx';
import Composer from './components/Composer.jsx';

const interactive = process.stdin.isTTY === true;
const colors = !process.env.NO_COLOR && process.stdout.isTTY === true;

export default function PlainApp({ client, server, onFatal }) {
  const { messages, busy, llm, botName, send, sendAction } = useChat({ client, mode: 'plain', onFatal });

  const width = Math.max(20, process.stdout.columns || 80);

  const lastBot = [...messages].reverse().find((m) => m.role === 'bot');
  const barRows = useMemo(() => {
    if (!lastBot) return [];
    if (lastBot.buttons?.length) return lastBot.buttons;
    if (lastBot.options?.length) return [lastBot.options.map((o) => ({ text: o, data: o }))];
    return [];
  }, [lastBot]);

  // A bare 1–9 line taps the matching button; anything else is a normal chat line.
  async function submit(t) {
    if (/^[1-9]$/.test(t) && barRows.length) {
      const b = barRows.flat()[Number(t) - 1];
      if (b) { if (isToken(b.data)) sendAction(b.data); else send(b.data, b.text); return; }
    }
    await send(t);
  }

  return (
    <Box flexDirection="column">
      <Static items={messages}>
        {(m) => (
          <Box key={m.key} flexDirection="column">
            {messageLines(m, width - 2, botName, colors).map((l, i) => <Line key={i} line={l} />)}
          </Box>
        )}
      </Static>
      {barRows.length ? (
        <Box flexDirection="column" paddingX={1}>
          {(() => { let n = 0; return barRows.map((row, ri) => (
            <Text key={ri} dimColor>
              {row.map((b) => { n += 1; return n <= 9 ? `[${n}] ${b.text}  ` : `${b.text}  `; }).join('')}
            </Text>
          )); })()}
        </Box>
      ) : null}
      {busy ? <Text dimColor>  …thinking</Text> : null}
      {interactive ? (
        <Composer onSubmit={submit} busy={busy} focus />
      ) : llm == null ? <Text dimColor>connecting to {server}…</Text> : null}
    </Box>
  );
}
