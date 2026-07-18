// The scrolling message body — the hand-rolled viewport: lines are pre-wrapped by
// lines.js, so this component only slices the visible window and paints it. `offset` counts lines
// scrolled up from the bottom (0 = stuck to the newest turn).
import { Box } from 'ink';
import Line from './Line.jsx';

export default function Transcript({ lines, height, offset, flashKey = null }) {
  const end = Math.max(0, lines.length - offset);
  const start = Math.max(0, end - height);
  const visible = lines.slice(start, end);
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
      {visible.map((line, i) => (
        <Line key={start + i} line={line} fresh={flashKey != null && line.msgKey === flashKey} />
      ))}
    </Box>
  );
}
