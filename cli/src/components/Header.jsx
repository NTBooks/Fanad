// The pinned title bar (zone 1 of the 4-zone layout). One row, no border — the frame budget goes to the
// composer, and every row spent on chrome is a row taken from the transcript.
import { Box, Text } from 'ink';

export default function Header({ server, botName }) {
  return (
    <Box height={1} paddingX={1} justifyContent="space-between" flexShrink={0}>
      <Text bold color="magenta">⚡ {botName || 'Fanad'}</Text>
      <Text dimColor>{server}</Text>
    </Box>
  );
}
