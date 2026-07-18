// The interactive button bar — the terminal's rendering of the brain's `buttons` token rows (and, when
// there are none, the `options` quick replies), preserving the row layout Telegram shows. Keyboard
// driven: Tab moves focus here from the composer, arrows walk the grid, Enter taps, 1–9 tap directly,
// Esc hands focus back. Selected chip renders inverse; the whole bar dims while the composer owns focus
// so the eye knows where keys will land.
import { Box, Text } from 'ink';

export default function Buttons({ rows, selected, active }) {
  let n = 0; // running 1–9 quick-tap number across the flattened grid
  return (
    <Box flexDirection="column" paddingX={1} flexShrink={0}>
      {rows.map((row, ri) => (
        <Box key={ri}>
          {row.map((btn, ci) => {
            n += 1;
            const isSel = active && selected.r === ri && selected.c === ci;
            const num = n <= 9 ? `${n}` : null;
            return (
              <Text key={`${btn.data ?? btn.text}-${ci}`} inverse={isSel} dimColor={!active && !isSel}>
                {' '}{num ? <Text color={isSel ? undefined : 'yellow'}>{num}</Text> : null}{num ? ' ' : ''}{btn.text}{' '}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
