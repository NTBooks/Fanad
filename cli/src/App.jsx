// The full-screen chat app: pinned zones (header · transcript viewport · button bar · status ·
// composer) laid out by Yoga to the exact terminal size, reflowing on resize (rendering
// model). Transport lives in useChat (shared with the --plain renderer); this component owns layout,
// the scroll viewport, and the keyboard focus model:
//   composer focused (default) — typing writes (a bare 1–9 line taps that button, plain-mode parity);
//   PgUp/PgDn scroll; Esc jumps to the newest turn
//   Tab (when the last bot turn has buttons/options) — focus the button bar: arrows walk, Enter taps,
//   1–9 tap directly, Esc/Tab returns to the composer
import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useScreenSize } from './fullscreen.js';
import { buildLines } from './lines.js';
import { bannerLines } from './banner.js';
import { useChat, isToken } from './useChat.js';
import Header from './components/Header.jsx';
import Transcript from './components/Transcript.jsx';
import Buttons from './components/Buttons.jsx';
import StatusBar from './components/StatusBar.jsx';
import Composer from './components/Composer.jsx';

// Raw-mode keyboard handling needs a real TTY on stdin; without one (piped/CI) the app still renders —
// it just becomes a read-only view instead of crashing Ink's useInput hook.
const interactive = process.stdin.isTTY === true;
const colors = !process.env.NO_COLOR;
const SPLASH_MIN_MS = 1200; // a fast local server resolves history instantly — hold the banner a beat anyway

export default function App({ client, server, onFatal }) {
  const { exit } = useApp();
  const { width, height } = useScreenSize();
  const [offset, setOffset] = useState(0); // lines scrolled up from the bottom; 0 = stick to newest
  const [btnFocus, setBtnFocus] = useState(false);
  const [sel, setSel] = useState({ r: 0, c: 0 });

  // Identity-stable by construction — useChat guards itself with a ref too, but an inline closure here
  // once churned its effect deps every render (a history fetch + SSE reconnect PER KEYSTROKE). Never again.
  const handleFatal = useCallback((msg) => { onFatal?.(msg); exit(); }, [onFatal, exit]);
  const { messages, busy, llm, botName, conn, ready, send, sendAction } = useChat({
    client,
    mode: 'fullscreen',
    onFatal: handleFatal,
  });

  // Minimum splash hold: history keeps loading underneath; a fast server just no longer skips the reveal.
  const [splashHold, setSplashHold] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setSplashHold(false), SPLASH_MIN_MS);
    return () => clearTimeout(t);
  }, []);

  // Entrance fade: the newest turn renders dim for a beat, then settles (never on the history seed).
  const [flashKey, setFlashKey] = useState(null);
  const prevCountRef = useRef(0);
  useEffect(() => {
    const prev = prevCountRef.current;
    prevCountRef.current = messages.length;
    if (prev === 0 || messages.length <= prev) return undefined;
    const key = messages[messages.length - 1]?.key;
    setFlashKey(key);
    const t = setTimeout(() => setFlashKey(null), 160);
    return () => clearTimeout(t);
  }, [messages]);

  // The button bar shows for the LAST bot turn only (web parity): its token rows, or — when it has
  // none — its quick-reply options as a single row of plain answer buttons.
  const lastBot = useMemo(() => messages.findLast((m) => m.role === 'bot'), [messages]);
  const barRows = useMemo(() => {
    if (busy || !lastBot) return [];
    if (lastBot.buttons?.length) return lastBot.buttons;
    if (lastBot.options?.length) return [lastBot.options.map((o) => ({ text: o, data: o }))];
    return [];
  }, [lastBot, busy]);

  // A new turn replaces the bar — stale selection/focus must not carry onto different buttons.
  useEffect(() => { setBtnFocus(false); setSel({ r: 0, c: 0 }); }, [lastBot?.key]);

  function activate(btn) {
    setBtnFocus(false);
    setOffset(0);
    if (isToken(btn.data)) sendAction(btn.data);
    else send(btn.data, btn.text); // echo the friendly label, send the payload the brain expects
  }

  // A bare 1–9 reply taps the matching button (plain-mode parity); anything else is a chat line.
  async function submit(t) {
    if (/^[1-9]$/.test(t) && barRows.length) {
      const b = barRows.flat()[Number(t) - 1];
      if (b) { activate(b); return; }
    }
    setOffset(0); // sending always jumps to the newest turn (web parity)
    await send(t);
  }

  // Zone heights: header 1 + status 1 + composer 3 (border) + one row per button row. The viewport gets
  // the rest. Read-only (non-TTY) runs have no composer to subtract.
  const barH = barRows.length;
  const bodyHeight = Math.max(3, height - (interactive ? 5 : 2) - barH);
  const lines = useMemo(
    () => buildLines(messages, Math.max(10, width - 2), botName, colors),
    [messages, width, botName],
  );
  const maxOffset = Math.max(0, lines.length - bodyHeight);
  const clamped = Math.min(offset, maxOffset);

  useInput((input, key) => {
    // Focus hand-off: Tab enters the button bar (when there is one) and toggles back out.
    if (key.tab) {
      if (barRows.length) { setBtnFocus((f) => !f); setSel({ r: 0, c: 0 }); }
      return;
    }
    if (btnFocus && barRows.length) {
      const row = barRows[Math.min(sel.r, barRows.length - 1)] || [];
      if (key.escape) { setBtnFocus(false); return; }
      if (key.return) { const b = row[Math.min(sel.c, row.length - 1)]; if (b) activate(b); return; }
      if (key.leftArrow) { setSel((s) => ({ ...s, c: Math.max(0, s.c - 1) })); return; }
      if (key.rightArrow) { setSel((s) => ({ ...s, c: Math.min(row.length - 1, s.c + 1) })); return; }
      if (key.upArrow) { setSel((s) => { const r = Math.max(0, s.r - 1); return { r, c: Math.min(s.c, (barRows[r]?.length || 1) - 1) }; }); return; }
      if (key.downArrow) { setSel((s) => { const r = Math.min(barRows.length - 1, s.r + 1); return { r, c: Math.min(s.c, (barRows[r]?.length || 1) - 1) }; }); return; }
      // 1–9 tap the flattened grid directly.
      if (/^[1-9]$/.test(input)) {
        const flat = barRows.flat();
        const b = flat[Number(input) - 1];
        if (b) activate(b);
        return;
      }
      return;
    }
    // Composer-focused: paging owns the scroll (mouse wheel is a flagged stretch goal — SGR tracking
    // floods stdin). Esc jumps back to the newest turn.
    const page = Math.max(1, bodyHeight - 1);
    if (key.pageUp) setOffset(Math.min(maxOffset, clamped + page));
    else if (key.pageDown) setOffset(Math.max(0, clamped - page));
    else if (key.escape) setOffset(0);
  }, { isActive: interactive });

  // Boot screen: the one-shot gradient banner while the first history page loads — held at least
  // SPLASH_MIN_MS so it doesn't blink away on a fast server (one tasteful reveal, then
  // chat — never looping, never repeated). The spinner row only shows while genuinely still loading.
  if (!ready || splashHold) {
    const banner = bannerLines(width - 4, colors);
    return (
      <Box flexDirection="column" width={width} height={height} justifyContent="center" alignItems="center">
        {banner.length
          ? banner.map((l, i) => <Text key={i}>{l}</Text>)
          : <Text bold color="magenta">⚡ Fanad</Text>}
        {!ready ? (
          <Box marginTop={1}>
            <Text dimColor><Spinner type="dots" /> connecting to {server}…</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Header server={server} botName={botName} />
      <Transcript lines={lines} height={bodyHeight} offset={clamped} flashKey={flashKey} />
      {barRows.length ? <Buttons rows={barRows} selected={sel} active={btnFocus} /> : null}
      <StatusBar llm={llm} busy={busy} offset={clamped} readOnly={!interactive} hasButtons={barRows.length > 0} btnFocus={btnFocus} conn={conn} />
      {interactive ? <Composer onSubmit={submit} busy={busy} focus={!btnFocus} /> : null}
    </Box>
  );
}
