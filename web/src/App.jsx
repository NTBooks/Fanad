import { useState, useEffect, useLayoutEffect, useRef } from 'react';
// domMax (not domAnimation): the kanban's `layout` card animations need the full feature set.
import { LazyMotion, domMax, m, AnimatePresence, MotionConfig } from 'framer-motion';
import * as api from './api.js';
import Settings from './Settings.jsx';
import DataBrowser from './DataBrowser.jsx';
import DebugLog from './DebugLog.jsx';
import Login from './Login.jsx';
import ModulesPanel, { availableModules } from './ModulesPanel.jsx';
import UserConfig from './UserConfig.jsx';
import OceanBackdrop from './OceanBackdrop.jsx';
import { LegendPanel, StatusPanel } from './GutterPanels.jsx';

// The Fanad lighthouse logo mark (replaces the 🗼 / Tokyo-tower emoji).
function Logo() {
  return (
    <svg className="logo" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="23" fill="#123b4f" />
      <path d="M24,12.5 L8,9 L11,17 Z" fill="#f3c66a" opacity="0.5" />
      <path d="M24,12.5 L40,9 L37,17 Z" fill="#f3c66a" opacity="0.5" />
      <path d="M21,34 L22,16 L26,16 L27,34 Z" fill="#ffffff" />
      <rect x="19.5" y="14.6" width="9" height="2.2" rx="1" fill="#ffffff" />
      <rect x="22" y="11.3" width="4" height="3.5" fill="#f3c66a" />
      <path d="M21.3,11.3 L24,8 L26.7,11.3 Z" fill="#ffffff" />
      <circle cx="24" cy="13" r="1.5" fill="#f3c66a" />
      <path d="M14,37 q5,-3 10,0 t10,0" stroke="#5f9bb4" strokeWidth="2" fill="none" strokeLinecap="round" />
    </svg>
  );
}

const EMOJIS = ['😀', '😄', '😊', '🙂', '😌', '😎', '🤩', '🥳', '😇', '🤗', '😐', '😕', '😟', '😔', '😢', '😭', '😤', '😠', '😩', '😴', '🥱', '💤', '🤒', '🥴', '🤯', '🥵', '🥶', '😋', '🤤', '🔥', '⚡', '💪', '✨', '🌱', '☕', '🍔', '🍦', '🎉', '✅', '📝', '🧹', '🛒', '🏃', '🧘', '❤️'];

// The limited palette you can leave on one of Fanad's replies (feeds the learning signal).
const REACTIONS = ['🙌', '🙏', '👍', '🔥', '💯', '😊', '😂', '🙁', '🤮', '💩', '💤', '❤️'];

// Hold the 👀 "thinking" reaction on your own message at least this long before swapping to the decision
// emoji, so the two-step reads as two steps even when the reply is instant (mirrors Telegram's REACT_MIN_MS).
const REACT_HOLD_MS = 600;

// A slash-command token at the start of a word: /done, /task:health, /wakelist (not URLs like http://x).
const CMD_RE = /(^|\s)(\/[a-z]+(?:_\d+|:[a-z]+)?)/g;

// The Telegram-safe HTML subset our server emits (shared/richtext.js): bold / italic / monospace, plus the
// one attribute-bearing tag — <a href="…"> for a task title that carries a pasted URL. Map strong→b and
// em→i so the renderer handles both spellings. Unknown tags fall through as text.
const RT_OPEN = { b: 'b', strong: 'b', i: 'i', em: 'i', code: 'code', a: 'a' };
const RT_TAG_RE = /<(\/?)(b|strong|i|em|code|a)(\s+href="([^"]*)")?>/gi;
// Undo the entities esc()/attrEsc() produce, back to visible text (before /command chip-splitting).
const unescapeEntities = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
// A bare URL in plain text (the 📄 verbatim line, a pasted link echoed back) — made clickable by renderLine.
// Trailing sentence punctuation is trimmed off the link, mirroring the server's extractUrl.
const URL_TOKEN_RE = /https?:\/\/[^\s<>"]+/gi;
const trimUrlTail = (u) => u.replace(/[)\]}>,.!?;:'"”’]+$/, '');
// Defense-in-depth at the render edge: only plain http(s) ever becomes a real anchor.
const isHttpUrl = (u) => /^https?:\/\//i.test(u || '');

// How many older messages to pull per backward-scroll page.
const HISTORY_PAGE = 30;

// Shape a stored history row into a chat message. Fanad's stamped reaction on YOUR message (persisted
// server-side in raw_json) renders via botReaction; the live `reaction` field is reserved for the user's
// own tap-reaction on bot bubbles, so it must not leak through from the server row.
const fromServer = (p) => ({ ...p, botReaction: p.role === 'me' ? p.reaction || null : null, reaction: null, key: `h${p.id}` });

// Shared motion variants: springy pop for reactions, rise-in rows for quick replies.
const springPop = { type: 'spring', stiffness: 500, damping: 22 };
const staggerRow = { hidden: {}, show: { transition: { staggerChildren: 0.035 } } };
const riseIn = { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0 } };

// The taxonomy/commands/onboarding copy are NOT duplicated here — they're loaded from /api/config (the
// server is the single source of truth) and kept fresh by the heartbeat's version check below.

// Background fetches must never break the chat, but failing SILENTLY hides real problems (server down,
// endpoint gone, bad impersonation header). Log each distinct failure once — the pollers fire every 5–30s,
// so a dead server must not repeat an identical line per tick. (Same dedup idea as the server's
// warnedHeaders set in actingUser.js.)
const loggedFetchErrs = new Set();
function logFetchErr(what, err) {
  const key = `${what}: ${err?.message || err}`;
  if (loggedFetchErrs.has(key)) return;
  loggedFetchErrs.add(key);
  console.error(`${what} failed:`, err?.message || err);
}

// Auto day/night by the local clock; weather key from the latest status line, for soothing tints.
const isNight = () => { const h = new Date().getHours(); return h < 6 || h >= 19; };
function weatherKey(w) {
  if (!w) return '';
  const s = w.toLowerCase();
  if (s.includes('thunder') || s.includes('storm')) return 'storm';
  if (s.includes('snow')) return 'snow';
  if (s.includes('rain') || s.includes('drizzle') || s.includes('shower')) return 'rain';
  if (s.includes('fog')) return 'fog';
  if (s.includes('cloud')) return 'clouds';
  if (s.includes('clear')) return 'clear';
  return '';
}

// A compact current-state line prepended to each Fanad reply (extensible: weather/temp later).
function StatusChip({ status }) {
  const parts = [];
  if (status.mood) parts.push(`mood ${status.mood}`);
  if (status.weather) parts.push(`weather ${status.weather}`);
  if (status.temp != null) parts.push(`${status.temp}°${status.tempUnit || ''}`);
  if (status.time) parts.push(status.time);
  if (!parts.length) return null;
  return <div className="status-chip">{parts.join(' · ')}</div>;
}

// The web app is a chat — same text-in/text-out as Telegram. The only panel UI is Settings.
export default function App() {
  // The chat holds only real stored turns (history + live). The RULES/HOWTO intro is rendered separately
  // at the very top once we've paged back to the beginning (hasMore === false) — so returning users land
  // on their recent conversation, and new users (no history) still get the welcome.
  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(true);   // assume there may be older history until the first page says otherwise
  const [loadingMore, setLoadingMore] = useState(false);
  const cursorRef = useRef(null);   // oldest loaded message id — the keyset cursor for the next page
  const stickRef = useRef(true);    // keep pinned to the bottom unless the user has scrolled up
  const prependRef = useRef(null);  // { prevHeight, prevTop } captured before a history prepend, to hold the viewport
  const loadingRef = useRef(false); // re-entrancy guard for loadOlder (a ref so onScroll sees it synchronously)
  const keyRef = useRef(0);
  const mkKey = () => `l${keyRef.current++}`; // stable React key for client-side (live) bubbles
  const lastMsgIdRef = useRef(0); // newest message id displayed — the forward cursor for live polling
  const initedRef = useRef(false); // the initial history page landed (or the account is confirmed empty) — gates the forward poll
  const histErrRef = useRef(false); // the "couldn't load history" notice is showing (don't stack one per retry)
  const busyRef = useRef(false);  // mirror of `busy` so the poll closure can skip while a send is in flight
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showUserConfig, setShowUserConfig] = useState(false); // the non-owner "Your modules" panel
  const [showData, setShowData] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [features, setFeatures] = useState(null);   // { notes, lists, metrics, vouch, notebook } — drives the module icons
  const [modulesTab, setModulesTab] = useState(null); // which advanced module view is open (null = none)
  const [debugEnabled, setDebugEnabled] = useState(false); // server has DEBUG_LOG set
  const [needsSetup, setNeedsSetup] = useState(false);
  const [llm, setLlm] = useState(null);
  const [botId, setBotId] = useState(null);        // { platform, username } | null — the connected chat bot (from the heartbeat)
  const [cfg, setCfg] = useState(null);            // server-owned config (taxonomy, commands, copy, providers)
  const cfgVersionRef = useRef(null);              // last config version we loaded — the heartbeat diffs against it
  const [impersonation, setImpersonation] = useState(null); // { enabled, users, rootUserId, currentUserId } | null
  const [notebooks, setNotebooks] = useState(null); // { enabled, currentId, notebooks:[{id,name}] } | null (when the module is on)
  // Last current-notebook id seen (heartbeat or /api/notebooks). undefined = not yet seeded (first beat just
  // adopts), null = main space. A CHANGE means another surface (Telegram "notebook work") switched the space
  // under us — every dataUid-keyed view is now stale, so reload (same reset the web's own switcher does).
  const notebookRef = useRef(undefined);
  // Web login: /api/auth/status decides what boots. null = still asking (minimal splash); mode 'simple' +
  // !authenticated = render <Login/> INSTEAD of the app (no data fetches, no pollers). A status failure
  // falls back to mode 'none' — the server is unreachable either way and the pill will say so.
  const [auth, setAuth] = useState(null);
  const chatRef = useRef(null);
  const taRef = useRef(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showMenu, setShowMenu] = useState(false); // mobile ☰ dropdown (the header cluster collapses ≤640px)
  const [theme, setThemeState] = useState(() => { try { return localStorage.getItem('fanad-theme') || 'auto'; } catch { return 'auto'; } });
  const setTheme = (t) => { setThemeState(t); try { localStorage.setItem('fanad-theme', t); } catch { /* ignore */ } };
  // The wide-screen gutter panels (legend + status). `wide` mirrors the CSS breakpoint IN JS so a narrow
  // window never mounts the panels (no /api/sidebar polling on mobile); `gutters` is the user's one-button
  // show/hide for the whole layer — panels are chrome, not content, so hiding them must be one tap.
  const [wide, setWide] = useState(() => window.matchMedia('(min-width:1280px)').matches);
  const [gutters, setGuttersState] = useState(() => { try { return localStorage.getItem('fanad-gutters') !== 'off'; } catch { return true; } });
  const setGutters = (on) => { setGuttersState(on); try { localStorage.setItem('fanad-gutters', on ? 'on' : 'off'); } catch { /* ignore */ } };
  const [sidebar, setSidebar] = useState(null);    // { startedTask, upcoming, mood, day } from /api/sidebar
  const guttersOnRef = useRef(false);              // read by the 30s interval + send() closures
  const [night, setNight] = useState(isNight);
  const [reactAt, setReactAt] = useState(-1); // which bot bubble has its reaction palette open

  function doReact(i, em) {
    const key = messages[i]?.key; // revert by key, not index — a history prepend can shift indices mid-flight
    const prev = messages[i]?.reaction || null;
    api.react(em, messages[i]?.ref || null).catch((err) => {
      // A failed save must not keep showing as saved (the learning signal was never recorded) — revert so
      // the palette reopens and the user can retry.
      logFetchErr('reaction save', err);
      setMessages((m) => m.map((mm) => (mm.key === key ? { ...mm, reaction: prev } : mm)));
    });
    setMessages((m) => m.map((mm, idx) => (idx === i ? { ...mm, reaction: em } : mm)));
    setReactAt(-1);
  }

  // LM Studio auto-uses the loaded model, so it never needs a model picked here; only nag cloud providers.
  const checkSetup = () => api.getLlmSettings().then((s) => setNeedsSetup(s.provider !== 'lmstudio' && !s.chatModel)).catch((err) => logFetchErr('LLM setup check', err));
  // Pull the server-owned config and remember its version (the heartbeat compares against this).
  // Piggybacked: the deployment's default theme (WEB_DEFAULT_THEME — the public demo sets Ocean). It only
  // applies while this browser has never picked a theme, and it is deliberately NOT persisted — only an
  // explicit pick in Appearance commits, so until then the server default keeps steering fresh visits.
  const loadConfig = () => api.getConfig().then((c) => {
    setCfg(c); cfgVersionRef.current = c.version;
    if (['light', 'dark', 'bokeh'].includes(c.defaultTheme)) {
      try { if (!localStorage.getItem('fanad-theme')) setThemeState(c.defaultTheme); } catch { /* ignore */ }
    }
  }).catch((err) => logFetchErr('config load (the heartbeat will retry)', err));
  // Heartbeat: refresh the connection pill, and refetch the config when its version moved (dirty — e.g.
  // after "/lock newcat" reshaped the taxonomy) OR when it never loaded at all (cfgVersionRef still null
  // because the mount-time fetch failed) — otherwise one transient failure left cfg null for the whole
  // session: no intro for new users, and command chips pasting instead of running.
  const beat = () => api.heartbeat()
    .then(({ llm: l, configVersion, bot, notebook }) => {
      setLlm(l || { reachable: false, ok: false });
      setBotId(bot || null); // the connected Telegram bot's handle (null while the bot is off)
      if (configVersion && configVersion !== cfgVersionRef.current) loadConfig();
      const nb = notebook ?? null;
      if (notebookRef.current === undefined) notebookRef.current = nb;
      else if (nb !== notebookRef.current) window.location.reload(); // switched from another surface
    })
    .catch((err) => { logFetchErr('heartbeat', err); setLlm({ reachable: false, ok: false }); });
  // Scheduled wake-up check-ins are delivered by polling; show any new ones as bot bubbles.
  const pollWakeups = () => api.getWakeups()
    .then(({ wakeups }) => { if (wakeups?.length) setMessages((m) => [...m, ...wakeups.map((w) => ({ role: 'bot', text: w.text, mode: 'capture', key: mkKey() }))]); })
    .catch((err) => logFetchErr('wake-up poll', err));
  // Pull turns that arrived since we last looked (e.g. from Telegram while impersonating that user) and
  // append them. Skips mid-send (the cursor advances only once the reply lands, so a poll during a send
  // could double-show the just-sent turn); dedupes by server id as a backstop.
  const pollMessages = () => {
    if (busyRef.current) return;
    // Until the initial history page has landed, retry THAT instead of forward-polling: with the cursor
    // still at 0, /api/chat/new would replay the user's oldest turns from the beginning of time.
    if (!initedRef.current) { loadInitialHistory(); return; }
    api.getNewMessages(lastMsgIdRef.current).then(({ messages: incoming }) => {
      if (!incoming?.length) return;
      lastMsgIdRef.current = Math.max(lastMsgIdRef.current, ...incoming.map((p) => p.id));
      setMessages((m) => {
        const have = new Set(m.map((x) => x.id).filter((x) => x != null));
        const fresh = incoming.filter((p) => !have.has(p.id));
        return fresh.length ? [...m, ...fresh.map(fromServer)] : m;
      });
    }).catch((err) => logFetchErr('message poll', err));
  };

  // Load older messages when the user scrolls near the top, preserving their viewport (anchor) so the
  // content doesn't jump. Keyset-paginated by the oldest id we already hold.
  async function loadOlder() {
    if (loadingRef.current || !hasMore) return;
    loadingRef.current = true;
    setLoadingMore(true);
    setReactAt(-1); // an open reaction palette is index-based; prepend would shift it onto the wrong bubble
    const el = chatRef.current;
    const prevHeight = el ? el.scrollHeight : 0;
    const prevTop = el ? el.scrollTop : 0;
    try {
      const { messages: older, hasMore: more } = await api.getHistory(cursorRef.current, HISTORY_PAGE);
      if (older.length) {
        prependRef.current = { prevHeight, prevTop };
        cursorRef.current = older[0].id;
        setMessages((m) => [...older.map(fromServer), ...m]);
      }
      setHasMore(more);
    } catch (err) { logFetchErr('older history load', err); /* keep what we have; the user can try scrolling again */ }
    finally { loadingRef.current = false; setLoadingMore(false); }
  }
  function onChatScroll() {
    const el = chatRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (el.scrollTop < 80 && hasMore && !loadingRef.current) loadOlder();
  }
  // Host-only impersonation: load the account list once. Disabled (flag off) → stays null, no dropdown.
  function switchUser(e) {
    const id = e.target.value;
    api.setAsUser(impersonation && id === String(impersonation.rootUserId) ? '' : id);
    window.location.reload(); // simplest correct reset: reloads history, data, settings under the new user
  }
  // Notebooks: load the acting account's spaces (only when the module is on). A switch/create sets the
  // server-side pointer, then a reload re-fetches history/tasks/data under the chosen space (all via dataUid).
  const loadNotebooks = () => api.getNotebooks().then((n) => {
    setNotebooks(n.enabled ? n : null);
    // Seed the heartbeat's stale-space sentinel too, closing the boot race (data fetched under this pointer).
    if (notebookRef.current === undefined) notebookRef.current = n.currentId ?? null;
  }).catch((err) => logFetchErr('notebooks load', err));
  // Which opt-in modules are on for the acting user — decides which advanced-view icons show in the header.
  // Refetched on Settings close so toggling a module makes its icon appear/disappear without a reload.
  const loadFeatures = () => api.getFeatureSettings().then(setFeatures).catch((err) => logFetchErr('feature settings load', err));
  // The gutter status bundle. Refreshed on mount/toggle, on the 30s heartbeat, and after every send —
  // "done"/"start 1"/"timer 5 minutes" typed in chat must move the panel without waiting for the poll.
  const loadSidebar = () => api.getSidebar().then(setSidebar).catch((err) => logFetchErr('sidebar load', err));
  function switchNotebook(e) {
    const v = e.target.value;
    const revert = () => setNotebooks((n) => n && { ...n }); // controlled <select>: force it back to currentId
    if (v === '__new__') {
      const name = (window.prompt('Name your new notebook:') || '').trim();
      if (!name) return revert();
      api.createNotebook(name).then(() => window.location.reload()).catch((err) => { window.alert(err.message); revert(); });
      return;
    }
    api.switchNotebook(v === 'main' ? null : v).then(() => window.location.reload()).catch((err) => { window.alert(err.message); revert(); });
  }
  // Boot phase 0: ask the server whether a login is required BEFORE fetching anything user-scoped.
  useEffect(() => {
    api.getAuthStatus().then(setAuth).catch((err) => {
      logFetchErr('auth status', err);
      setAuth({ mode: 'none', authenticated: true, isOwner: true });
    });
    // A 401 from any call (session expired, logged out elsewhere, login just enabled) → re-ask the server
    // and flip to the login screen; the boot effect below tears the pollers down when authenticated drops.
    const onUnauthorized = () => {
      api.getAuthStatus().then(setAuth).catch(() => setAuth((a) => (a ? { ...a, authenticated: false } : a)));
    };
    window.addEventListener('fanad:unauthorized', onUnauthorized);
    return () => window.removeEventListener('fanad:unauthorized', onUnauthorized);
  }, []);
  const authed = !!auth?.authenticated;
  const isOwner = !auth || auth.isOwner === true; // mode none reports isOwner:true (today's trust model)
  // Track the breakpoint the CSS gutter rule uses, so React unmounts the panels (and their polling)
  // exactly when the CSS would hide them anyway.
  useEffect(() => {
    const mq = window.matchMedia('(min-width:1280px)');
    const onChange = (e) => setWide(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const showGutters = authed && wide && gutters;
  useEffect(() => {
    guttersOnRef.current = showGutters;
    if (showGutters) loadSidebar(); // seed on mount / re-show / widen; the 30s beat keeps it fresh after
  }, [showGutters]);
  useEffect(() => {
    if (!authed) return undefined;
    checkSetup(); loadConfig(); beat(); pollWakeups(); loadNotebooks(); loadFeatures();
    api.getUsers().then((u) => { if (u.enabled) setImpersonation(u); }).catch((err) => logFetchErr('impersonation picker load', err));
    if (isOwner) api.getDebugLog().then((d) => setDebugEnabled(!!d.enabled)).catch((err) => logFetchErr('debug-log probe', err));
    const id = setInterval(() => { beat(); pollWakeups(); setNight(isNight()); if (guttersOnRef.current) loadSidebar(); }, 30000);
    const msgId = setInterval(pollMessages, 5000); // snappier: new turns should appear ~live
    return () => { clearInterval(id); clearInterval(msgId); };
  }, [authed]);
  // Load the most recent page of stored history on mount, newest at the bottom. A FAILED load is NOT
  // "no history": treating it as empty impersonated a brand-new account (intro over a blank chat, backward
  // scroll dead) and left the forward poll cursored at 0, replaying the transcript from the very beginning
  // once the server recovered. Instead: say so, and let the live poll retry until a page lands.
  function loadInitialHistory() {
    api.getHistory(null, HISTORY_PAGE).then(({ messages: page, hasMore: more }) => {
      initedRef.current = true;
      histErrRef.current = false;
      if (page.length) {
        cursorRef.current = page[0].id;                        // oldest (backward cursor)
        lastMsgIdRef.current = page[page.length - 1].id;       // newest (forward poll cursor)
        setMessages(page.map(fromServer));
      } else {
        setMessages((m) => m.filter((x) => !x.histErr));       // truly empty account — drop the retry notice
      }
      setHasMore(more);
    }).catch((err) => {
      logFetchErr('history load', err);
      if (histErrRef.current) return; // the notice is already showing — don't stack one per retry
      histErrRef.current = true;
      setMessages((m) => [...m, { role: 'bot', text: '⚠ Couldn’t load your chat history — retrying…', histErr: true, key: mkKey() }]);
    });
  }
  useEffect(() => { if (authed) loadInitialHistory(); }, [authed]);
  // Theme must live on the root element so the body (and all inherited text) gets the night palette.
  // 'bokeh' is a separate opt-in dark theme (animated glass — costs GPU, so 'auto' never resolves to it).
  const mode = theme === 'bokeh' ? 'bokeh' : (theme === 'dark' || (theme === 'auto' && night)) ? 'night' : 'day';
  useEffect(() => { document.documentElement.dataset.theme = mode; }, [mode]);
  // Scrolling: a history prepend holds the viewport on the same content; otherwise (a new turn, typing
  // indicator) stick to the bottom — but only when the user was already near it, so scroll-up stays put.
  useLayoutEffect(() => {
    const el = chatRef.current;
    if (!el) return;
    if (prependRef.current) {
      const { prevHeight, prevTop } = prependRef.current;
      prependRef.current = null;
      el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
      return;
    }
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, busy, loadingMore]);

  // Append a bot turn, keeping at most ONE live task list on screen. A `listing` reply supersedes any prior
  // listing bubble (so re-running /tasks or paging never stacks copies); a `hide` reply (the "✕ Hide" button)
  // just removes the live listing and adds nothing. Mirrors Telegram's supersede/delete behavior.
  function appendBotTurn(p) {
    // A kind:'ack' turn is a contentless emoji ack (🌱/👍) — the reaction stamped on your OWN message is the
    // whole reply (send() swaps it in), so no bot bubble. Matches Telegram/Slack; it's never persisted either.
    if (p.kind === 'ack') return;
    // "✕ Hide / ✕" dismissed the screen it sat on (always the latest bot turn, since only that turn shows
    // buttons) — drop that bubble. Mirrors Telegram deleting the message.
    if (p.hide) {
      setMessages((m) => { const i = m.map((x) => x.role).lastIndexOf('bot'); return i < 0 ? m : [...m.slice(0, i), ...m.slice(i + 1)]; });
      return;
    }
    setMessages((m) => {
      let next = m;
      // A task's open-list state changed this turn (done/start/drop) → quietly re-render the task list bubble
      // IN PLACE (Fanad's analogue of Telegram's refreshHangingList edit), so it drops the completed row
      // without moving below — and stealing the confirmation's "how did that feel?" options off — the newest
      // bubble. Only a task listing is swapped (listKind), so a /notes or /lists bubble is never clobbered.
      if (p.refreshedListing) {
        let idx = -1;
        for (let i = next.length - 1; i >= 0; i--) {
          const x = next[i];
          if (x.role === 'bot' && x.listing && x.listKind === 'task') { idx = i; break; }
        }
        if (idx >= 0) {
          const rl = p.refreshedListing;
          next = [...next.slice(0, idx),
            { role: 'bot', text: rl.reply || '…', buttons: rl.buttons, html: rl.html, listing: true, listKind: 'task', key: next[idx].key },
            ...next.slice(idx + 1)];
        }
      }
      const base = p.listing ? next.filter((x) => !(x.role === 'bot' && x.listing)) : next;
      return [...base, {
        role: 'bot', text: p.reply || '…', status: p.status, logged: p.logged, image: p.image,
        calendarUrl: p.calendarUrl, mode: p.mode, options: p.options, buttons: p.buttons, ref: p.ref,
        html: p.html, listing: p.listing, listKind: p.listKind, key: mkKey(),
      }];
    });
  }

  // `override` is the text actually sent to the brain when a quick-reply chip is tapped (just like typing
  // it). `display` is what we SHOW in the "me" bubble — defaults to the sent text, but a chip whose label
  // differs from its payload (e.g. "Home (2)" → "household", "🪜 Steps" → "guide steps") passes its label so
  // the echo matches what the user tapped, never the raw filter word.
  async function send(e, override, display) {
    e?.preventDefault();
    const t = (override ?? text).trim();
    if (!t || busy) return;
    if (override == null) setText('');
    stickRef.current = true; // sending always jumps to the newest turn
    // Fanad's two-step reaction on the user's OWN message (Telegram parity): 👀 the instant it's sent, then a
    // swap to the server-decided emoji once the reply lands (mood emoji / ✍ / 🫡, or 🤬 on error). Keyed by
    // meKey (not index) so the bot turn / live poll mutating the list can't stamp the wrong bubble. The swap
    // is fire-and-forget — it never blocks the reply or the composer — but holds 👀 for REACT_HOLD_MS first.
    const meKey = mkKey();
    const reactedAt = Date.now();
    setMessages((m) => [...m, { role: 'me', text: display ?? t, key: meKey, botReaction: '👀' }]);
    const swapReaction = async (em) => {
      const held = Date.now() - reactedAt;
      if (held < REACT_HOLD_MS) await new Promise((r) => setTimeout(r, REACT_HOLD_MS - held));
      setMessages((m) => m.map((mm) => (mm.key === meKey ? { ...mm, botReaction: em } : mm)));
    };
    setBusy(true); busyRef.current = true;
    try {
      const res = await api.sendChat(t);
      // Advance the forward cursor past our own turn so the live poll won't re-fetch and duplicate it.
      if (res.messageId) lastMsgIdRef.current = Math.max(lastMsgIdRef.current, res.messageId);
      appendBotTurn(res);
      swapReaction(res.reaction || '🫡');
    } catch (err) {
      swapReaction('🤬');
      setMessages((m) => [...m, { role: 'bot', text: `⚠ ${err.message}`, key: mkKey() }]);
    } finally {
      setBusy(false); busyRef.current = false;
      if (guttersOnRef.current) loadSidebar(); // "done" / "start 1" / "timer …" must move the gutter panel now
    }
  }

  // A clicked interactive button. A STRUCTURED token (a per-task menu / the hub) goes to /api/action and
  // appends the refreshed card as a fresh turn — NO "me" bubble (the raw token is never shown). A plain
  // command/answer button (e.g. "/whatdo", "yes") just runs like a typed line. Mirrors Telegram's split.
  const isToken = (d) => d === 'x' || /^[am]:/.test(String(d));
  function onButton(b) {
    if (isToken(b.data)) sendAction(b.data);
    else send(null, b.data, b.text); // echo the friendly label; send the payload the brain expects
  }
  async function sendAction(data) {
    if (busy) return;
    // No "me" bubble and so no reaction — a tapped button has no user message to react to (the server also
    // strips res.reaction off /api/action). Mirrors Telegram skipping the reaction on a tapped bubble.
    stickRef.current = true;
    setBusy(true); busyRef.current = true;
    try {
      const res = await api.sendAction(data);
      if (res.messageId) lastMsgIdRef.current = Math.max(lastMsgIdRef.current, res.messageId);
      appendBotTurn(res);
    } catch (err) {
      setMessages((m) => [...m, { role: 'bot', text: `⚠ ${err.message}`, key: mkKey() }]);
    } finally {
      setBusy(false); busyRef.current = false;
      if (guttersOnRef.current) loadSidebar(); // a tapped button can complete/start a task too
    }
  }

  // Drop text into the composer and focus it, cursor at the end — the "half a command, you add the rest"
  // gesture shared by command chips and the gutter legend.
  function insertIntoComposer(t) {
    setText(t);
    requestAnimationFrame(() => { const ta = taRef.current; if (ta) { ta.focus(); const p = ta.value.length; ta.setSelectionRange(p, p); } });
  }
  // Click a command in a bot reply: run it if it's complete (argless), else drop it into the composer.
  function runCommand(cmd) {
    const lc = cmd.toLowerCase();
    // Argless commands (/tasks, /whatdo…) AND complete positional ones (/cal_3, /pic_3) run on a single tap;
    // anything still needing input drops into the composer.
    if ((cfg?.argless || []).includes(lc) || /^\/[a-z]+_\d+$/.test(lc)) { send(null, cmd); return; }
    insertIntoComposer(cmd + ' ');
  }
  // Turn /command tokens in a text run into clickable chips (the pre-link renderLine body).
  function renderCmds(line, keyBase = '') {
    const nodes = []; let last = 0; let m; let k = 0;
    CMD_RE.lastIndex = 0;
    while ((m = CMD_RE.exec(line)) !== null) {
      const tokenStart = m.index + m[1].length;
      if (tokenStart > last) nodes.push(line.slice(last, tokenStart));
      const cmd = m[2];
      nodes.push(<button key={`${keyBase}c${k++}`} type="button" className="cmd-link" onClick={() => runCommand(cmd)}>{cmd}</button>);
      last = tokenStart + cmd.length;
    }
    if (last < line.length) nodes.push(line.slice(last));
    return nodes;
  }
  // Render one line of bot text: bare URLs become real links, /command tokens become clickable chips.
  function renderLine(line) {
    const nodes = []; let last = 0; let m; let k = 0;
    URL_TOKEN_RE.lastIndex = 0;
    while ((m = URL_TOKEN_RE.exec(line)) !== null) {
      const url = trimUrlTail(m[0]);
      if (m.index > last) nodes.push(...renderCmds(line.slice(last, m.index), `u${k}`));
      nodes.push(<a key={`a${k++}`} className="msg-link" href={url} target="_blank" rel="noopener noreferrer">{url}</a>);
      last = m.index + url.length;
    }
    if (last < line.length) nodes.push(...renderCmds(line.slice(last), 't'));
    return nodes.length ? nodes : (line || ' ');
  }
  // Render a server-built rich line (the Telegram-safe HTML subset) into React nodes — b/strong→bold,
  // i/em→italic, code→monospace — reconstructing the tree element-by-element (never dangerouslySetInnerHTML).
  // Text inside any tag still flows through renderLine, so /command chips keep working; unknown or unbalanced
  // tags are treated as plain text. Used only when a reply is flagged html:true; plain replies skip it.
  function renderRich(line) {
    const root = { tag: null, kids: [] };
    const stack = [root];
    let last = 0; let m;
    const addText = (txt) => { if (txt) stack[stack.length - 1].kids.push(unescapeEntities(txt)); };
    RT_TAG_RE.lastIndex = 0;
    while ((m = RT_TAG_RE.exec(line)) !== null) {
      addText(line.slice(last, m.index));
      last = m.index + m[0].length;
      const name = RT_OPEN[m[2].toLowerCase()];
      if (m[1] === '/') { if (stack.length > 1 && stack[stack.length - 1].tag === name) stack.pop(); }
      else {
        // <a> carries its href (attribute-escaped by the server; unescape back to the real URL).
        const node = { tag: name, href: name === 'a' && m[4] != null ? unescapeEntities(m[4]) : null, kids: [] };
        stack[stack.length - 1].kids.push(node); stack.push(node);
      }
    }
    addText(line.slice(last));
    const toNode = (n, key) => {
      // Inside an <a>, text stays inert (no chips, no re-linkifying — a title that IS a URL would otherwise
      // nest an anchor in an anchor); everywhere else it flows through renderLine as before.
      const kids = n.kids.map((c, idx) => (typeof c === 'string'
        ? <span key={idx}>{n.tag === 'a' ? c : renderLine(c)}</span> : toNode(c, idx)));
      if (!n.tag) return kids;
      if (n.tag === 'b') return <b key={key}>{kids}</b>;
      if (n.tag === 'code') return <code key={key}>{kids}</code>;
      if (n.tag === 'a') {
        // Only plain http(s) becomes a real anchor (matches the server-side a() gate); anything else — or a
        // hrefless <a> — renders as its text.
        if (!isHttpUrl(n.href)) return <span key={key}>{kids}</span>;
        return <a key={key} className="msg-link" href={n.href} target="_blank" rel="noopener noreferrer">{kids}</a>;
      }
      return <i key={key}>{kids}</i>;
    };
    return toNode(root, 'r');
  }

  function insertEmoji(em) {
    const ta = taRef.current;
    if (!ta) { setText((t) => t + em); setShowEmoji(false); return; }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    setText((t) => t.slice(0, start) + em + t.slice(end));
    requestAnimationFrame(() => { ta.focus(); const p = start + em.length; ta.setSelectionRange(p, p); });
    setShowEmoji(false);
  }

  // Mobile ☰ menu: Escape closes; menuGo wraps a row's action so selecting always closes the menu.
  useEffect(() => {
    if (!showMenu) return;
    const onKey = (e) => { if (e.key === 'Escape') setShowMenu(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showMenu]);
  const menuGo = (fn) => () => { setShowMenu(false); fn(); };

  const llmView = !llm ? { c: 'checking', t: 'checking…' }
    : llm.ok ? { c: 'ok', t: llm.provider === 'mock' ? 'demo model' : 'model ready' }
      : llm.reachable ? { c: 'warn', t: 'no model loaded' }
        : { c: 'off', t: 'not connected' };

  // The latest bot turn drives the mode hint + quick-reply chips (what the next message will do).
  const lastBot = [...messages].reverse().find((mm) => mm.role === 'bot');
  const wx = weatherKey(lastBot?.status?.weather);

  // Login gate: no app until the server has said who we are. (After every hook — rules of hooks.)
  if (!auth) return <div className="app" />;
  if (auth.mode === 'simple' && !auth.authenticated) return <Login status={auth} />;

  return (
    <MotionConfig reducedMotion="user">
    <LazyMotion features={domMax} strict>
    <div className="app" data-weather={wx}>
      {/* Build tag, baked in by vite.config.js at build time (schema.commitsSinceMigration) — shows
          which bundle the browser is actually running, so a cached deploy is visible at a glance. */}
      <div className="build-tag">v{__CLIENT_BUILD__}</div>
      {mode === 'bokeh' && <OceanBackdrop />}
      <header className="hdr">
        <Logo />
        <div className="hdr-title"><h1>Fanad</h1><p className="tag">a lighthouse keeper for tasks</p></div>
        {/* All controls live in a right-aligned cluster that wraps as a unit, so the title never gets
            squeezed no matter how many module icons + selects appear (impersonation, notebooks, modules). */}
        <div className="hdr-controls">
        <button className={`llm-pill ${llmView.c}`} onClick={() => { if (isOwner) setShowSettings(true); }}
          title={isOwner ? 'LLM connection — click to open Settings' : 'LLM connection'}>
          <span className="dot" />{llmView.t}
        </button>
        {impersonation && impersonation.enabled && (
          <select
            className="user-switch"
            title="Acting as — load and act as another user (host-only)"
            value={api.getAsUser() || String(impersonation.rootUserId)}
            onChange={switchUser}
          >
            {impersonation.users.map((u) => (
              <option key={u.id} value={String(u.id)}>
                {(u.display_name || u.email || `User ${u.id}`) + (u.id === impersonation.rootUserId ? ' (you)' : '')}
              </option>
            ))}
          </select>
        )}
        {notebooks && notebooks.enabled && (
          <select
            className="user-switch"
            title="Notebook — switch to a separate, private space (its own tasks, notes & lists)"
            value={notebooks.currentId != null ? String(notebooks.currentId) : 'main'}
            onChange={switchNotebook}
          >
            <option value="main">📖 Main</option>
            {notebooks.notebooks.map((n) => <option key={n.id} value={String(n.id)}>📓 {n.name}</option>)}
            <option value="__new__">＋ New notebook…</option>
          </select>
        )}
        {availableModules(features).map((m) => (
          <button key={m.key} className="gear module-icon" title={`${m.label} — advanced view`} onClick={() => setModulesTab(m.key)}>{m.icon}</button>
        ))}
        <a className="gear" title="Guide — what Fanad is &amp; how to use it" href="/docs/" target="_blank" rel="noreferrer">❔</a>
        <a className="gear" title="Manual — the full handbook" href="/docs/manual.html" target="_blank" rel="noreferrer">📖</a>
        <button className="gear" title="Your data" onClick={() => setShowData(true)}>▦</button>
        {isOwner && debugEnabled && <button className="gear" title="Server log" onClick={() => setShowDebug(true)}>🐞</button>}
        {isOwner && <button className="gear" title="Settings" onClick={() => setShowSettings(true)}>⚙</button>}
        {!isOwner && <button className="gear" title="Your modules — turn optional features on/off" onClick={() => setShowUserConfig(true)}>⚙</button>}
        {auth.mode === 'simple' && (
          <button className="gear" title={`Log out${auth.username ? ` (${auth.username})` : ''}`}
            onClick={() => api.logout().finally(() => window.location.reload())}>⏻</button>
        )}
        {botId?.username && (
          <a className="bot-name" href={`https://t.me/${botId.username}`} target="_blank" rel="noreferrer"
            title="Your Telegram bot — open it in Telegram">@{botId.username}</a>
        )}
        <button className="gear hamburger" title="Menu" aria-label="Menu" aria-expanded={showMenu}
          onClick={() => setShowMenu((s) => !s)}>☰</button>
        </div>
        {/* Mobile-only dropdown: every hidden header control gets a labelled row here, same gates as above. */}
        {/* Direct keyed m.* children — AnimatePresence can't track exits through a fragment. */}
        <AnimatePresence>
          {showMenu && (
            <m.div key="hdr-menu-backdrop" className="hdr-menu-backdrop" onClick={() => setShowMenu(false)}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} />
          )}
          {showMenu && (
              <m.div key="hdr-menu" className="hdr-menu" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.16 }}>
                {impersonation && impersonation.enabled && (
                  <select
                    className="user-switch"
                    title="Acting as — load and act as another user (host-only)"
                    value={api.getAsUser() || String(impersonation.rootUserId)}
                    onChange={(e) => { setShowMenu(false); switchUser(e); }}
                  >
                    {impersonation.users.map((u) => (
                      <option key={u.id} value={String(u.id)}>
                        {(u.display_name || u.email || `User ${u.id}`) + (u.id === impersonation.rootUserId ? ' (you)' : '')}
                      </option>
                    ))}
                  </select>
                )}
                {notebooks && notebooks.enabled && (
                  <select
                    className="user-switch"
                    title="Notebook — switch to a separate, private space (its own tasks, notes & lists)"
                    value={notebooks.currentId != null ? String(notebooks.currentId) : 'main'}
                    onChange={(e) => { setShowMenu(false); switchNotebook(e); }}
                  >
                    <option value="main">📖 Main</option>
                    {notebooks.notebooks.map((n) => <option key={n.id} value={String(n.id)}>📓 {n.name}</option>)}
                    <option value="__new__">＋ New notebook…</option>
                  </select>
                )}
                {(impersonation?.enabled || notebooks?.enabled) && <hr className="hdr-menu-sep" />}
                {availableModules(features).map((mod) => (
                  <button key={mod.key} className="hdr-menu-item" onClick={menuGo(() => setModulesTab(mod.key))}>{mod.icon} {mod.label}</button>
                ))}
                <hr className="hdr-menu-sep" />
                <a className="hdr-menu-item" href="/docs/" target="_blank" rel="noreferrer" onClick={() => setShowMenu(false)}>❔ Guide</a>
                <a className="hdr-menu-item" href="/docs/manual.html" target="_blank" rel="noreferrer" onClick={() => setShowMenu(false)}>📖 Manual</a>
                <button className="hdr-menu-item" onClick={menuGo(() => setShowData(true))}>▦ Your data</button>
                {isOwner && debugEnabled && <button className="hdr-menu-item" onClick={menuGo(() => setShowDebug(true))}>🐞 Server log</button>}
                {isOwner && <button className="hdr-menu-item" onClick={menuGo(() => setShowSettings(true))}>⚙ Settings</button>}
                {!isOwner && <button className="hdr-menu-item" onClick={menuGo(() => setShowUserConfig(true))}>⚙ Your modules</button>}
                {auth.mode === 'simple' && (
                  <button className="hdr-menu-item" onClick={menuGo(() => api.logout().finally(() => window.location.reload()))}>
                    ⏻ Log out{auth.username ? ` (${auth.username})` : ''}
                  </button>
                )}
                {botId?.username && (
                  <a className="hdr-menu-item" href={`https://t.me/${botId.username}`} target="_blank" rel="noreferrer"
                    onClick={() => setShowMenu(false)}>💬 @{botId.username}</a>
                )}
              </m.div>
          )}
        </AnimatePresence>
      </header>

      {needsSetup && !showSettings && (
        <div className="setup-nudge">
          <span>👋 Connect a model so I can sort your notes.</span>
          <span className="nudge-actions">
            <button onClick={() => setShowSettings(true)}>Set it up</button>
            <button className="ghost" onClick={() => setNeedsSetup(false)}>Later</button>
          </span>
        </div>
      )}

      <div className="chat" ref={chatRef} onScroll={onChatScroll}>
        {hasMore
          ? <div className="chat-top">{loadingMore ? 'loading older messages…' : '↑ scroll up for older messages'}</div>
          : [cfg?.rules, cfg?.howto].filter(Boolean).map((intro, k) => (
            <div key={`intro${k}`} className="bubble bot">
              {intro.split('\n').map((line, j) => <div key={j}>{renderLine(line)}</div>)}
            </div>
          ))}
        {messages.map((msg, i) => (
          // Entrance springs on LIVE turns only (history keys start with 'h'): transform/opacity only, so
          // the scroll-anchoring layout effect above never fights an animating scrollHeight.
          <m.div
            key={msg.key}
            className={`bubble ${msg.role}`}
            initial={msg.key.startsWith('h') ? false : { opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          >
            {msg.role === 'bot' && msg.logged && msg.status && <StatusChip status={msg.status} />}
            {msg.text.split('\n').map((line, j) => <div key={j}>{msg.role === 'bot' ? (msg.html ? renderRich(line) : renderLine(line)) : (line || ' ')}</div>)}
            {msg.image && <img className="chart-img" src={msg.image} alt="attached image" />}
            {msg.calendarUrl && <a className="cal-link" href={msg.calendarUrl} download>📅 Add to calendar</a>}
            {msg.role === 'me' && msg.botReaction && (
              <div className="me-reacted">
                {/* Keyed on the emoji so the 👀 → decision swap pops out / pops in. */}
                <AnimatePresence mode="popLayout" initial={false}>
                  <m.span key={msg.botReaction} style={{ display: 'inline-block' }}
                    initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0, opacity: 0 }} transition={springPop}>
                    {msg.botReaction}
                  </m.span>
                </AnimatePresence>
              </div>
            )}
            {msg.role === 'bot' && (
              msg.reaction
                ? <m.div className="reacted" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={springPop}>{msg.reaction}</m.div>
                : reactAt === i
                  ? (
                    <m.div className="react-palette" variants={staggerRow} initial="hidden" animate="show">
                      {REACTIONS.map((em) => <m.button key={em} type="button" variants={riseIn} onClick={() => doReact(i, em)}>{em}</m.button>)}
                    </m.div>
                  )
                  : <button type="button" className="react-btn" onClick={() => setReactAt(i)} title="React">＋</button>
            )}
          </m.div>
        ))}
        {!busy && lastBot && lastBot.buttons && lastBot.buttons.length > 0 ? (
          // Interactive menu buttons (per-task actions, the hub), preserving the brain's row layout — the
          // same rows Telegram renders. A structured tap edits via /api/action; a command/answer button
          // runs as a line.
          <m.div className="quick-replies-rows" variants={staggerRow} initial="hidden" animate="show">
            {lastBot.buttons.map((row, ri) => (
              <div className="quick-replies" key={ri}>
                {row.map((b) => (
                  <m.button key={b.data} type="button" variants={riseIn} onClick={() => onButton(b)}>{b.text}</m.button>
                ))}
              </div>
            ))}
          </m.div>
        ) : !busy && lastBot && lastBot.options && lastBot.options.length > 0 && (
          <m.div className="quick-replies" variants={staggerRow} initial="hidden" animate="show">
            {lastBot.options.map((opt) => (
              <m.button key={opt} type="button" variants={riseIn} onClick={(ev) => send(ev, opt)}>{opt}</m.button>
            ))}
          </m.div>
        )}
        {busy && <m.div className="bubble bot typing" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>…</m.div>}
      </div>

      <AnimatePresence>
        {showEmoji && (
          <m.div className="emoji-panel" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.16 }}>
            {EMOJIS.map((em) => <button key={em} type="button" onClick={() => insertEmoji(em)}>{em}</button>)}
          </m.div>
        )}
      </AnimatePresence>
      <form className="composer" onSubmit={send}>
        <div className="composer-field">
          <button type="button" className="emoji-btn" title="Insert emoji" onClick={() => setShowEmoji((s) => !s)}>😊</button>
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={1}
            placeholder={lastBot?.mode && lastBot.mode !== 'capture' ? 'Reply…' : 'Message'}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e); } }}
          />
        </div>
        <button type="submit" disabled={busy || !text.trim()}>Send</button>
      </form>

      {/* Wide-screen gutter layer: legend (left) + status (right), floating in the letterbox space.
          One button shows/hides the WHOLE layer at once — it's chrome, and chrome must be dismissable
          in a single tap. The button only exists ≥1280px (the panels' own breakpoint). */}
      {wide && authed && (
        <button
          type="button" className="gutter-toggle" aria-pressed={gutters}
          title={gutters ? 'Hide the side panels' : 'Show the side panels — shortcuts, modules & status'}
          onClick={() => setGutters(!gutters)}
        >{gutters ? '»' : '«'}</button>
      )}
      {showGutters && <LegendPanel cfg={cfg} features={features} onInsert={insertIntoComposer} onSend={(t) => send(null, t)} />}
      {showGutters && (
        <StatusPanel
          sidebar={sidebar} notebooks={notebooks} isOwner={isOwner}
          onSend={(t) => send(null, t)} onInsert={insertIntoComposer} onModulesChanged={loadFeatures}
        />
      )}

      {showSettings && <Settings theme={theme} onTheme={setTheme} onClose={() => { setShowSettings(false); checkSetup(); beat(); loadNotebooks(); loadFeatures(); }} />}
      {showUserConfig && <UserConfig theme={theme} onTheme={setTheme} onClose={() => { setShowUserConfig(false); loadNotebooks(); loadFeatures(); }} />}
      {showData && <DataBrowser onClose={() => setShowData(false)} />}
      {showDebug && <DebugLog onClose={() => setShowDebug(false)} />}
      {modulesTab && <ModulesPanel tab={modulesTab} onTab={setModulesTab} features={features} cfg={cfg} onClose={() => setModulesTab(null)} />}
    </div>
    </LazyMotion>
    </MotionConfig>
  );
}
