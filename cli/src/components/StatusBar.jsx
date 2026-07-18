// The status row (zone 3): LLM pill, the thinking spinner (braille dots + a rotating Fanad-voice word —
// honest liveness with personality, the Claude-CLI trick), and the scrolled-away indicator. Key hints
// live on the right so the eye finds them without reading.
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { useEffect, useState } from 'react';
import { nextSpinnerWord } from '../voice.js';

// Fresh word when the wait begins, then a steady rotation while it lasts — never a dead "thinking…".
function BusySpinner() {
  const [word, setWord] = useState(nextSpinnerWord);
  useEffect(() => {
    const t = setInterval(() => setWord(nextSpinnerWord()), 1800);
    return () => clearInterval(t);
  }, []);
  return <Text color="yellow">  <Spinner type="dots" /> {word}…</Text>;
}

export default function StatusBar({ llm, busy, offset, readOnly = false, hasButtons = false, btnFocus = false, conn = 'poll' }) {
  const pill = llm == null
    ? { color: 'gray', label: 'connecting…' }
    : llm.ok ? { color: 'green', label: 'AI ready' }
      : llm.reachable ? { color: 'yellow', label: 'AI degraded' }
        : { color: 'red', label: 'AI offline' };
  return (
    <Box height={1} paddingX={1} justifyContent="space-between" flexShrink={0}>
      <Box>
        <Text color={pill.color}>● </Text>
        <Text dimColor>{pill.label}</Text>
        <Text dimColor> · </Text>
        {conn === 'live'
          ? <Text color="green">⚡ live</Text>
          : <Text dimColor>polling</Text>}
        {busy ? <BusySpinner /> : null}
        {offset > 0 ? <Text color="yellow">  ↑ {offset} line{offset === 1 ? '' : 's'} back — Esc jumps down</Text> : null}
      </Box>
      <Text dimColor>
        {readOnly ? 'read-only (no TTY)'
          : btnFocus ? '←→↑↓ pick · Enter tap · 1-9 quick · Esc back'
            : hasButtons ? 'Tab buttons · PgUp/PgDn scroll · Ctrl+C quit'
              : 'PgUp/PgDn scroll · Ctrl+C quit'}
      </Text>
    </Box>
  );
}
