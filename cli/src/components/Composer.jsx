// The pinned input row (zone 4). The one bordered box on screen — the visual anchor that says "type
// here". While a send is in flight the border goes amber and input keeps buffering (submit is gated in
// useChat.send, mirroring the web composer's busy behavior).
//
// The draft text is LOCAL state on purpose (perf, load-bearing): a keystroke must re-render only this
// row. Lifting the draft into App once re-rendered the whole tree — transcript, buttons, status —
// per key, which read as unusable typing lag in a real terminal. The parent only ever sees the
// submitted line.
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useState } from 'react';

export default function Composer({ onSubmit, busy, focus = true }) {
  const [value, setValue] = useState('');
  const submit = (v) => {
    const t = String(v ?? '').trim();
    if (!t) return;
    setValue('');
    onSubmit(t);
  };
  return (
    <Box borderStyle="round" borderColor={busy ? 'yellow' : focus ? 'cyan' : 'gray'} paddingX={1} flexShrink={0}>
      <Text color={busy ? 'yellow' : 'cyan'}>❯ </Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={submit}
        focus={focus}
        placeholder="Get it out of your head…"
      />
    </Box>
  );
}
