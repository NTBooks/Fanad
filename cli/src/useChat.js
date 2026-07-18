// The transport brain shared by the full-screen App and the --plain renderer: transcript state, the
// web-parity polling contract (history seed → 5s /api/chat/new dedupe-by-id, skipped mid-send → 30s
// wakeups drain + heartbeat), send/sendAction, and appendBotTurn's supersede semantics. Mirrors
// web/src/App.jsx so the two surfaces can never drift far apart.
//
// mode 'plain' renders append-only (Ink <Static> — rows are committed once, immutable), so the
// mutating affordances (hide, listing supersede, in-place listing refresh) are skipped there: a fresh
// bubble simply appends. Full-screen mode mirrors the web exactly.
import { useCallback, useEffect, useRef, useState } from 'react';
import { startEventStream } from './sse.js';
import { saveDataUri, saveServerAsset } from './assets.js';

let keyCounter = 0;
const mkKey = () => `k${keyCounter++}`;

// Hold 👀 on the just-sent bubble at least this long before swapping in the server-decided reaction —
// the two-step beat reads as "seen → judged" only if the first step is actually visible (web parity).
const REACT_HOLD_MS = 600;

export const TOKEN_DEAD_MSG = 'Token rejected, expired, or revoked — mint a new one on the server with `fanad token`.';

// A structured button token (a per-task menu / the hub) vs a plain command/answer button. Mirrors the
// web's isToken split: tokens go to /api/action (no "me" bubble), plain payloads run like typed lines.
export const isToken = (d) => d === 'x' || /^[am]:/.test(String(d));

export function useChat({ client, onFatal, mode = 'fullscreen' }) {
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [llm, setLlm] = useState(null);
  const [botName, setBotName] = useState('Fanad');
  const [conn, setConn] = useState('poll'); // 'live' (SSE up) | 'poll' (fallback cadences)
  const [ready, setReady] = useState(false); // first history page landed — the boot banner can yield
  const lastMsgIdRef = useRef(0);
  const busyRef = useRef(false);
  const initedRef = useRef(false);

  // onFatal rides a ref so a caller passing an inline closure can NEVER destabilize the callback chain
  // below. This is load-bearing: authGuard → loadInitial → the effects' dep arrays — if onFatal's
  // identity churned per render, every render would re-run loadInitial (an HTTP fetch → setState →
  // render → …), tearing down the SSE stream each time and starving the event loop. That exact cycle
  // shipped once as unusable typing lag; the ref makes the whole chain identity-stable by construction.
  const onFatalRef = useRef(onFatal);
  onFatalRef.current = onFatal;

  // Any 401/403 = the claim token died (revoked/expired/deleted user). One exit path, no retry loops.
  const authGuard = useCallback((err) => {
    if (err?.status === 401 || err?.status === 403) { onFatalRef.current?.(TOKEN_DEAD_MSG); return true; }
    return false;
  }, []);

  // Boot: the newest history page seeds the transcript and the forward cursor.
  const loadInitial = useCallback(() => {
    client.getHistory(null, 30).then(({ messages: hist }) => {
      initedRef.current = true;
      setReady(true);
      if (hist?.length) {
        lastMsgIdRef.current = Math.max(...hist.map((m) => m.id));
        setMessages(hist.map((m) => ({ ...m, key: `s${m.id}` })));
      }
    }).catch((err) => { authGuard(err); /* else transient — the poll retries boot */ });
  }, [client, authGuard]);
  // Mount-once by contract (loadInitial is identity-stable, but the seed must never re-run regardless).
  useEffect(() => { loadInitial(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Heartbeat (30s): LLM pill + the connected bot's name for message labels.
  useEffect(() => {
    const beat = () => client.heartbeat()
      .then(({ llm: l, bot }) => {
        setLlm(l || { reachable: false, ok: false });
        const name = bot?.name || bot?.username;
        if (name) setBotName(String(name).replace(/^@/, ''));
      })
      .catch((err) => { if (!authGuard(err)) setLlm({ reachable: false, ok: false }); });
    beat();
    const t = setInterval(beat, 30000);
    return () => clearInterval(t);
  }, [client, authGuard]);

  // Pull turns that arrived elsewhere (Telegram/web/scheduler). Skips mid-send — the cursor advances
  // only when the reply lands, so a poll during a send could double-show the just-sent turn. Called by
  // both the interval AND an SSE 'chat' poke.
  const pollMessages = useCallback(() => {
    if (busyRef.current) return;
    if (!initedRef.current) { loadInitial(); return; }
    client.getNewMessages(lastMsgIdRef.current).then(({ messages: incoming }) => {
      if (!incoming?.length) return;
      lastMsgIdRef.current = Math.max(lastMsgIdRef.current, ...incoming.map((p) => p.id));
      setMessages((m) => {
        const have = new Set(m.map((x) => x.id).filter((x) => x != null));
        const fresh = incoming.filter((p) => !have.has(p.id));
        return fresh.length ? [...m, ...fresh.map((p) => ({ ...p, key: `s${p.id}` }))] : m;
      });
    }).catch((err) => { authGuard(err); });
  }, [client, authGuard, loadInitial]);

  // Wake-up check-ins (drain-on-read — read once, they're gone, so append immediately). Interval + poke.
  const pollWakeups = useCallback(() => {
    client.getWakeups()
      .then(({ wakeups }) => {
        if (wakeups?.length) {
          setMessages((m) => [...m, ...wakeups.map((w) => ({ role: 'bot', text: w.text, at: Date.now(), key: mkKey() }))]);
        }
      })
      .catch((err) => { authGuard(err); });
  }, [client, authGuard]);

  // Poll cadences: web parity while disconnected (5s/30s); lazy safety sweeps while the SSE stream is
  // live (a poke beats a poll by ~5s, and the sweep only catches anything a poke ever missed).
  useEffect(() => {
    const t = setInterval(pollMessages, conn === 'live' ? 30000 : 5000);
    return () => clearInterval(t);
  }, [pollMessages, conn]);
  useEffect(() => {
    pollWakeups();
    const t = setInterval(pollWakeups, conn === 'live' ? 60000 : 30000);
    return () => clearInterval(t);
  }, [pollWakeups, conn]);

  // The SSE poke channel (GET /api/stream): 'chat'/'wakeup' pokes trigger the matching pull right away;
  // 'config' is covered by the heartbeat's configVersion check. A dead stream (401/403) means the token
  // itself was rejected — same exit as any other auth failure.
  useEffect(() => {
    const stop = startEventStream({
      base: client.base,
      token: client.token,
      onPoke: (type) => {
        if (type === 'chat') pollMessages();
        else if (type === 'wakeup') pollWakeups();
      },
      onState: (state) => {
        if (state === 'dead') onFatalRef.current?.(TOKEN_DEAD_MSG);
        else setConn(state);
      },
    });
    return stop;
  }, [client, pollMessages, pollWakeups]);

  // Append a bot turn with the web's supersede semantics (full-screen), or plain append-only (--plain).
  const appendBotTurn = useCallback((p) => {
    // kind:'ack' = a contentless emoji ack — the reaction stamped on your OWN message is the whole reply.
    if (p.kind === 'ack') return;
    if (mode === 'plain') {
      if (p.hide) return;
      setMessages((m) => [...m, {
        role: 'bot', text: p.reply || '…', html: p.html, buttons: p.buttons, options: p.options,
        listing: p.listing, listKind: p.listKind, at: Date.now(), key: mkKey(),
      }]);
      return;
    }
    // "✕ Hide" dismissed the screen it sat on (always the latest bot turn) — drop that bubble.
    if (p.hide) {
      setMessages((m) => { const i = m.map((x) => x.role).lastIndexOf('bot'); return i < 0 ? m : [...m.slice(0, i), ...m.slice(i + 1)]; });
      return;
    }
    setMessages((m) => {
      let next = m;
      // A task's open-list state changed this turn → re-render the task list bubble IN PLACE (the web's
      // analogue of Telegram's refreshHangingList), never clobbering a /notes or /lists bubble.
      if (p.refreshedListing) {
        let idx = -1;
        for (let i = next.length - 1; i >= 0; i--) {
          const x = next[i];
          if (x.role === 'bot' && x.listing && x.listKind === 'task') { idx = i; break; }
        }
        if (idx >= 0) {
          const rl = p.refreshedListing;
          next = [...next.slice(0, idx),
            { role: 'bot', text: rl.reply || '…', buttons: rl.buttons, html: rl.html, listing: true, listKind: 'task', at: next[idx].at, key: next[idx].key },
            ...next.slice(idx + 1)];
        }
      }
      // A listing reply supersedes any prior live listing (re-running /tasks never stacks copies).
      const base = p.listing ? next.filter((x) => !(x.role === 'bot' && x.listing)) : next;
      return [...base, {
        role: 'bot', text: p.reply || '…', status: p.status, options: p.options, buttons: p.buttons,
        html: p.html, listing: p.listing, listKind: p.listKind, at: Date.now(), key: mkKey(),
      }];
    });
  }, [mode]);

  // Reply attachments land as FILES with their path in a follow-up line — the terminal's honest answer
  // to inline media (protocol images don't compose with the scroll viewport).
  const saveAttachments = useCallback((p) => {
    if (p.image) {
      const file = saveDataUri(p.image, 'png');
      if (file) setMessages((m) => [...m, { role: 'bot', text: `📈 chart saved → ${file}`, at: Date.now(), key: mkKey() }]);
    }
    if (p.calendarUrl) {
      saveServerAsset(client, p.calendarUrl, 'ics').then((file) => {
        if (file) setMessages((m) => [...m, { role: 'bot', text: `📅 calendar invite saved → ${file}`, at: Date.now(), key: mkKey() }]);
      });
    }
  }, [client]);

  // Send a typed line (or a plain command button's payload — `display` echoes the friendly label).
  // Fanad's two-step reaction rides the me bubble: 👀 the instant it's sent, the server-decided emoji
  // (or 🤬 on error) once the reply lands — Telegram/web parity.
  const send = useCallback(async (raw, display) => {
    const t = String(raw ?? '').trim();
    if (!t || busyRef.current) return false;
    const meKey = mkKey();
    const reactedAt = Date.now();
    setMessages((m) => [...m, { role: 'me', text: display ?? t, at: Date.now(), key: meKey, botReaction: '👀' }]);
    // Fire-and-forget (never blocks the reply): hold 👀 for the beat, then stamp the decided emoji.
    const swapReaction = async (em) => {
      const held = Date.now() - reactedAt;
      if (held < REACT_HOLD_MS) await new Promise((r) => { setTimeout(r, REACT_HOLD_MS - held); });
      setMessages((m) => m.map((mm) => (mm.key === meKey ? { ...mm, botReaction: em } : mm)));
    };
    setBusy(true); busyRef.current = true;
    try {
      const res = await client.sendChat(t);
      // Advance the forward cursor past our own turn so the live poll won't re-fetch and duplicate it.
      if (res.messageId) lastMsgIdRef.current = Math.max(lastMsgIdRef.current, res.messageId);
      appendBotTurn(res);
      saveAttachments(res);
      swapReaction(res.reaction || '🫡');
    } catch (err) {
      swapReaction('🤬');
      if (!authGuard(err)) {
        setMessages((m) => [...m, { role: 'bot', text: `⚠ ${err.message}`, error: true, at: Date.now(), key: mkKey() }]);
      }
    } finally {
      setBusy(false); busyRef.current = false;
    }
    return true;
  }, [client, authGuard, appendBotTurn, saveAttachments]);

  // A tapped structured button → /api/action. No "me" bubble and no reaction (nothing to react to).
  const sendAction = useCallback(async (data) => {
    if (busyRef.current) return;
    setBusy(true); busyRef.current = true;
    try {
      const res = await client.sendAction(data);
      if (res.messageId) lastMsgIdRef.current = Math.max(lastMsgIdRef.current, res.messageId);
      appendBotTurn(res);
      saveAttachments(res);
    } catch (err) {
      if (!authGuard(err)) {
        setMessages((m) => [...m, { role: 'bot', text: `⚠ ${err.message}`, error: true, at: Date.now(), key: mkKey() }]);
      }
    } finally {
      setBusy(false); busyRef.current = false;
    }
  }, [client, authGuard, appendBotTurn, saveAttachments]);

  return { messages, busy, llm, botName, conn, ready, send, sendAction };
}
