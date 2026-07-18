// Full-screen plumbing (rendering model): the alternate screen buffer + a resize-reactive
// size hook. Ink never enters the alt-buffer on its own (ink#263) — we write the escapes ourselves and
// guarantee restore via a process 'exit' guard, so a crash or Ctrl-C always hands the shell back intact.
// (fullscreen-ink automates the same pattern; hand-rolling it keeps the dep count down and the exit
// path in one visible place.)
import { useEffect, useState } from 'react';

const ENTER = '\x1b[?1049h\x1b[H'; // switch to alt buffer, cursor home
const EXIT = '\x1b[?1049l';        // back to the main buffer (prior scrollback intact)

let entered = false;
export function enterAltScreen() {
  if (entered || !process.stdout.isTTY) return;
  process.stdout.write(ENTER);
  entered = true;
}
export function exitAltScreen() {
  if (!entered) return;
  process.stdout.write(EXIT);
  entered = false;
}
// 'exit' fires on normal return, process.exit(), and uncaught exceptions alike — the one hook that
// makes "the terminal is always restored" a guarantee rather than a happy-path behavior.
export function installExitGuard() {
  process.on('exit', exitAltScreen);
}

// Current terminal size, updated on SIGWINCH. Node fires 'resize' on stdout (not stdin) — subscribe
// there. Ink re-runs Yoga layout on the next render, so a state bump here reflows the whole app.
export function useScreenSize() {
  const [size, setSize] = useState({ width: process.stdout.columns || 80, height: process.stdout.rows || 24 });
  useEffect(() => {
    const onResize = () => setSize({ width: process.stdout.columns || 80, height: process.stdout.rows || 24 });
    process.stdout.on('resize', onResize);
    return () => { process.stdout.off('resize', onResize); };
  }, []);
  return size;
}
