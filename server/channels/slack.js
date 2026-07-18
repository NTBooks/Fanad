// Slack channel adapter (Bolt, Socket Mode — no public URL/webhook, the analogue of Telegram long-polling).
// Tokens from DB settings (set in the UI; xoxb- bot token + xapp- app-level token). Start/stop are serialized
// to avoid orphan sockets. The shared brain (chat.js) is consumed UNCHANGED — this file only adapts transport:
// Block Kit buttons ↔ menu.js tokens, mrkdwn ↔ richtext HTML, reactions ↔ unicode acks, files for .ics. §3.
//
// Bolt is loaded lazily (dynamic import) so the server still boots if @slack/bolt isn't installed yet — Slack
// just stays disabled with a clear message, mirroring index.js's "Slack disabled: …" catch.
import { getSlackConfig } from '../settings.js';
import { handleIncomingSlack, handleReactionSlack, isAuthorizedSlack } from './slack-handler.js';
import { handleAction } from '../chat.js';
import { isStructured, decodeToken, CLOSE_BTN } from '../menu.js';
import { getOrCreateSlackUser, defaultUserId } from '../repo.js';
import { stripTags, toMrkdwn, slashToDollar } from '../../shared/slack-format.js';

// ── Slack limits (verified against current docs) ──
const SECTION_MAX = 3000;       // a section's mrkdwn text caps at 3000 chars
const MAX_BLOCKS = 50;          // a message holds at most 50 blocks
const BTNS_PER_ROW = 5;         // an actions block allows 25; 5/row is visual parity with menu.js, not a cap
const BTN_TEXT_MAX = 75;        // a button's text caps at 75 chars
const REACT_MIN_MS = 600;       // hold 👀 at least this long before swapping (visible two-step, like Telegram)

const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

// ── Reactions: Slack wants emoji by NAME (no colons), not unicode. The brain emits unicode (the 👀/🫡/✍ acks
// and the user's mood emoji), so map unicode→name to SEND and name→unicode to read inbound reactions back.
// Only the emoji Fanad actually sends/receives need entries; an unmapped mood falls back to the generic ack. ──
const REACT_THINK = 'eyes';            // 👀 transient "thinking"
const REACT_DONE = 'saluting_face';    // 🫡 normal ack
const REACT_NOTE = 'writing_hand';     // ✍ filed note
const UNICODE_TO_SLACK = {
  '👀': 'eyes', '🫡': 'saluting_face', '✍': 'writing_hand',
  '❤': 'heart', '❤️': 'heart', '👍': '+1', '👎': '-1', '🔥': 'fire', '👏': 'clap',
  '🥰': 'smiling_face_with_3_hearts', '😍': 'heart_eyes', '😘': 'kissing_heart',
  '😀': 'grinning', '😄': 'smile', '😁': 'grin', '🙂': 'slightly_smiling_face', '😊': 'blush',
  '🤔': 'thinking_face', '🤯': 'exploding_head', '😱': 'scream', '🤬': 'rage', '😡': 'rage',
  '😢': 'cry', '😭': 'sob', '😴': 'sleeping', '🥱': 'yawning_face', '😐': 'neutral_face',
  '🎉': 'tada', '🤩': 'star-struck', '🙏': 'pray', '👌': 'ok_hand', '💯': '100', '🤣': 'rofl',
  '⚡': 'zap', '🏆': 'trophy', '💔': 'broken_heart', '😎': 'sunglasses', '🤗': 'hugging_face',
  '😇': 'innocent', '😨': 'fearful', '🤝': 'handshake', '🤷': 'shrug', '🤓': 'nerd_face',
  '👻': 'ghost', '😈': 'smiling_imp', '🙈': 'see_no_evil',
  '🌱': 'seedling', // the kind:'ack' face for the done-feedback shrug
};
// First-wins inversion (a few unicode share a name, e.g. 😡/🤬→rage); fine for a coarse mood signal.
const SLACK_TO_UNICODE = Object.fromEntries(
  Object.entries(UNICODE_TO_SLACK).map(([u, n]) => [n, u]).reverse(),
);

// Pick the Slack reaction NAME for a mood (or a kind:'ack' face): the first char we know, else the generic ack.
function moodReactionName(moodEmoji) {
  const chars = String(moodEmoji || '').match(/\p{Extended_Pictographic}/gu) || [];
  for (const c of chars) if (UNICODE_TO_SLACK[c]) return UNICODE_TO_SLACK[c];
  return REACT_DONE;
}
// Map an inbound Slack reaction name back to unicode (stripping any ::skin-tone-N). Null if we don't know it.
function unicodeForReaction(name) {
  const base = String(name || '').replace(/::skin-tone-\d+$/, '');
  return SLACK_TO_UNICODE[base] || null;
}

// ── Block Kit assembly (pure — no SDK; exported for tests) ──
const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });

// Split mrkdwn into ≤3000-char section blocks on LINE boundaries, so a *…*/`…` pair is never cut mid-marker.
// A single over-long line is hard-split as a last resort. Pushes into `blocks`.
function pushSections(blocks, mrkdwnText) {
  const text = String(mrkdwnText || '');
  if (!text) return;
  let buf = '';
  const flush = () => { if (buf) { blocks.push(section(buf)); buf = ''; } };
  for (const line of text.split('\n')) {
    const next = buf ? `${buf}\n${line}` : line;
    if (next.length <= SECTION_MAX) { buf = next; continue; }
    flush();
    if (line.length > SECTION_MAX) {
      for (let i = 0; i < line.length; i += SECTION_MAX) blocks.push(section(line.slice(i, i + SECTION_MAX)));
    } else buf = line;
  }
  flush();
}

// Rows of { text, data } (from menu.js) OR plain option strings → actions blocks. Each row wraps at 5 buttons.
// `value` carries the menu token verbatim (≤60 bytes, far under Slack's 2000); a tap routes it like a typed
// line if it isn't a structured token (legacy yes/no/smaller). action_id is unique per message (a counter) so
// no two buttons in one actions block collide; the live handler matches them all by the /^fanad_action_/ regex.
function buttonsToBlocks(rows, counter) {
  const out = [];
  for (const row of rows) {
    for (let i = 0; i < row.length; i += BTNS_PER_ROW) {
      const elements = row.slice(i, i + BTNS_PER_ROW).map((b) => ({
        type: 'button',
        // Label shows the Slack sigil ("$whatdo"); the VALUE keeps the brain's token verbatim — a tap is
        // server-side, so it never hits Slack's "/" interception.
        text: { type: 'plain_text', text: slashToDollar(stripTags(b.text)).slice(0, BTN_TEXT_MAX) || '·', emoji: true },
        action_id: `fanad_action_${counter.n++}`,
        value: String(b.data),
      }));
      out.push({ type: 'actions', elements });
    }
  }
  return out;
}

// Build a Slack message from a brain reply. Returns { blocks, text }: section block(s) for the body (mrkdwn if
// html:true, else plain) + actions block(s) for buttons/options. `text` is the notification fallback (plain).
// The document/photo upload is handled by the caller (files can't carry blocks) — see postBuilt.
export function buildSlackMessage(out = {}) {
  // Swap the "/" command sigil for "$" on every outgoing surface (body + notification + button labels), so the
  // bot only ever shows Slack-typeable commands. dollarToSlash restores "/" on the way back in (slack-handler).
  const body = slashToDollar(toMrkdwn(out.reply || '', out.html));
  const notify = slashToDollar(stripTags(out.reply || '')).slice(0, SECTION_MAX) || ' ';
  // Structured per-task button trees take precedence over plain quick-reply options (mirrors telegram.js).
  const counter = { n: 0 };
  const actions = out.buttons
    ? buttonsToBlocks(out.buttons, counter)
    : (out.options && out.options.length ? buttonsToBlocks([out.options.map((o) => ({ text: o, data: o }))], counter) : []);

  const sections = [];
  pushSections(sections, body);
  // Keep every actions block; trim body sections if the total would exceed 50, with a "(truncated)" marker.
  const room = MAX_BLOCKS - actions.length;
  let kept = sections;
  if (sections.length > room) { kept = sections.slice(0, Math.max(0, room - 1)); kept.push(section('_…(truncated)_')); }
  return { blocks: [...kept, ...actions], text: notify };
}

// Decode a `data:<mime>;base64,…` chart URI into { buf, name } for a file upload (captured photos are
// Telegram-only; this is just for generated charts, which ride as data URIs like on Telegram).
function dataUriToFile(uri) {
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(uri || '');
  const b64 = m ? m[2] : String(uri || '');
  const ext = m && /png/.test(m[1]) ? 'png' : m && /webp/.test(m[1]) ? 'webp' : m && /gif/.test(m[1]) ? 'gif' : 'jpg';
  return { buf: Buffer.from(b64, 'base64'), name: `chart.${ext}` };
}

let app = null;
let botUserId = null;
let chain = Promise.resolve();

// Highest message ts seen per channel (user messages + our own posts). Slack ts are increasing decimal
// strings within a channel, so a numeric compare works: "tapped ts < max seen" ⇔ the tapped card is NOT the
// latest message — used to post a fresh ▶ Started card instead of editing one buried up in history (parity
// with telegram.js's latestMsgByChat). In-memory: empty on restart → falls back to edit-in-place. Exported
// for tests.
const latestTsByChannel = new Map();
export function noteChannelTs(channel, ts) {
  if (channel == null || ts == null) return;
  if (parseFloat(ts) > parseFloat(latestTsByChannel.get(channel) ?? '0')) latestTsByChannel.set(channel, String(ts));
  if (latestTsByChannel.size > 500) latestTsByChannel.delete(latestTsByChannel.keys().next().value);
}

// Recent bot message → the task ref it was about (keyed "channel:ts"), so a reaction can be attributed to it.
const botMsgRefs = new Map();
function rememberBotMessage(channel, ts, ref) {
  if (!ref || channel == null || ts == null) return;
  botMsgRefs.set(`${channel}:${ts}`, ref);
  if (botMsgRefs.size > 500) botMsgRefs.delete(botMsgRefs.keys().next().value);
}

// Cache the @handle + display name per Slack id (the message event carries only the id; allowlist-by-handle
// and a friendly display_name need users.info). Only SUCCESSFUL lookups are cached: caching a failure would
// pin handle:null for the process lifetime, silently locking out an @handle-allowlisted user after one blip.
const profileCache = new Map();
async function resolveProfile(client, userId) {
  if (!userId) return { handle: null, displayName: null };
  if (profileCache.has(userId)) return profileCache.get(userId);
  try {
    const r = await client.users.info({ user: userId });
    const u = r?.user;
    const prof = { handle: u?.name || null, displayName: u?.profile?.display_name || u?.real_name || u?.name || null };
    profileCache.set(userId, prof);
    return prof;
  } catch (err) {
    console.error('Slack users.info failed (id-only for this message, will retry):', err.message);
    return { handle: null, displayName: null };
  }
}

// Upload a file (.ics / chart) to the DM, sending the buttons (if any) as a separate normal message first —
// a Slack file message can't carry Block Kit. Returns the ts to attribute a reaction to (the buttons message
// if there is one, else null — files aren't reaction targets here).
async function postBuilt(client, channel, out) {
  const built = buildSlackMessage(out);
  if (out.document || out.image) {
    const file = out.document
      ? { buf: Buffer.from(out.document.content), name: out.document.filename || 'file' }
      : dataUriToFile(out.image);
    const hasButtons = built.blocks.some((b) => b.type === 'actions');
    let ts = null;
    if (hasButtons) {
      const m = await client.chat.postMessage({ channel, text: built.text, blocks: built.blocks });
      ts = m?.ts ?? null;
      noteChannelTs(channel, ts);
    }
    await client.files.uploadV2({
      channel_id: channel, file: file.buf, filename: file.name,
      initial_comment: hasButtons ? undefined : built.text,
    });
    return ts;
  }
  const m = await client.chat.postMessage({ channel, text: built.text, blocks: built.blocks });
  noteChannelTs(channel, m?.ts ?? null);
  return m?.ts ?? null;
}

// A tapped button (registered on /^fanad_action_/): ack within 3s FIRST, then run the dispatcher and edit
// the card in place — except a ▶ Start on a buried card, which posts fresh (see below). Module-level (not a
// doStart closure) so tests can drive it with a fake Bolt payload.
export async function onSlackAction({ ack, body, action, client }) {
  await ack(); // BEFORE any slow LLM work, so the 3-second interaction timeout never trips
  const channel = body.channel?.id ?? body?.container?.channel_id;
  const ts = body.message?.ts ?? body?.container?.message_ts;
  const slackUserId = body.user?.id;
  const data = String(action.value ?? '');
  const { handle } = await resolveProfile(client, slackUserId);
  if (!isAuthorizedSlack({ slackUserId, slackUsername: handle })) return; // stranger tap → ignore

  // A legacy plain answer (yes/no/smaller, a command) isn't a structured token — route it like a typed line:
  // post the result as a new message (and best-effort strip the tapped buttons off the old card).
  if (!isStructured(data)) {
    try {
      const out = await handleIncomingSlack({ text: data, slackUserId, slackUsername: handle, channelType: 'im' });
      if (channel && ts) client.chat.update({ channel, ts, text: body.message?.text || ' ', blocks: [] }).catch(() => {});
      if (out.reply || out.document || out.image || out.buttons) {
        const newTs = await postBuilt(client, channel, out);
        rememberBotMessage(channel, newTs, out.ref);
      }
    } catch (err) {
      // Surface the failure like the DM handler does — a silent catch left the card unchanged with
      // zero signal, indistinguishable from a tap that "worked" (Telegram's twin path reports too).
      console.error('Slack legacy action error:', err.message);
      await client.chat.postMessage({ channel, text: '☠️ Something went wrong filing that — try again in a moment?' }).catch(() => {});
    }
    return;
  }

  let out;
  try { out = await handleAction(getResolvedUserId(slackUserId, handle), data, { channel: 'slack' }); }
  catch (err) {
    // ack() is invisible in Slack, so without this the tap looks like it did nothing (the task was NOT
    // changed) — tell the user via the same ephemeral mechanism the toasts use.
    console.error('Slack action error:', err.message);
    if (channel) client.chat.postEphemeral({ channel, user: slackUserId, text: '☠️ Something went wrong — try again in a moment?' }).catch(() => {});
    return;
  }

  if (out.hide) { if (channel && ts) await client.chat.delete({ channel, ts }).catch(() => {}); return; }
  if (out.toast) client.chat.postEphemeral({ channel, user: slackUserId, text: out.toast }).catch((err) => console.error('Slack toast failed:', err.message));
  // handleAction replies carry `text` (the card body); buildSlackMessage reads `reply` — map it once here
  // so the updated/fresh card keeps its body (it used to render buttons-only).
  const view = { ...out, reply: out.text };
  // ▶ Start tapped on a card that ISN'T the latest message in the DM: post the Started card FRESH at the
  // bottom and strip the old card's buttons (its text stays — it's history now), instead of editing a
  // message buried up in history (parity with Telegram). Empty tracker (restart) or a failed post falls
  // through to the edit-in-place below.
  const staleStart = decodeToken(data)?.verb === 'start' && channel && ts
    && parseFloat(latestTsByChannel.get(channel) ?? '0') > parseFloat(ts);
  if (staleStart) {
    let newTs = null;
    try { newTs = await postBuilt(client, channel, view); }
    catch (err) { console.error('Slack fresh-start post failed (editing in place instead):', err.message); }
    if (newTs) {
      rememberBotMessage(channel, newTs, out.ref);
      const oldBlocks = (body.message?.blocks || []).filter((b) => b.type !== 'actions');
      await client.chat.update({ channel, ts, text: body.message?.text || ' ', blocks: oldBlocks }).catch(() => {});
      return;
    }
  }
  if (channel && ts) {
    const built = buildSlackMessage(view);
    await client.chat.update({ channel, ts, text: built.text, blocks: built.blocks }).catch((err) => console.error('Slack chat.update failed:', err.message));
    rememberBotMessage(channel, ts, out.ref); // same message, keep reaction attribution current
  }
}

async function rawStop() {
  if (!app) return;
  const a = app;
  app = null;
  botUserId = null;
  try { await a.stop(); } catch { /* ignore */ }
}

async function doStart() {
  await rawStop();
  const cfg = getSlackConfig();
  if (!cfg.enabled || !cfg.botToken) return null;
  if (cfg.mode === 'http') {
    console.warn('Slack HTTP/Events mode is not wired yet — set mode to "socket" (needs an app-level xapp- token).');
    return null;
  }
  if (!cfg.appToken) throw new Error('Socket Mode needs an app-level token (xapp-…) with connections:write.');

  // Lazy import so a missing dependency disables Slack instead of crashing the whole server boot.
  const mod = await import('@slack/bolt');
  const App = mod.App || mod.default?.App;
  if (!App) throw new Error('@slack/bolt did not export App.');

  const a = new App({ token: cfg.botToken, appToken: cfg.appToken, socketMode: true });

  // ── inbound DM text: 👀 ack → shared brain → swap reaction → post the answer (blocks + buttons) ──
  a.message(async ({ message, client }) => {
    // Only real user DMs: skip edits/joins (subtype), other bots/our own echoes (bot_id), non-DM channels.
    if (message.subtype || message.bot_id || message.channel_type !== 'im') return;
    const channel = message.channel;
    const userMsgTs = message.ts;
    noteChannelTs(channel, userMsgTs); // the user's message advances the channel's high-water mark
    const slackUserId = message.user;
    const { handle } = await resolveProfile(client, slackUserId);

    // Two-step reaction ack on the USER's message: 👀 now, swap to the decision reaction once the reply's ready.
    const reactAdd = (name) => client.reactions.add({ channel, timestamp: userMsgTs, name }).catch(() => {});
    const reactDel = (name) => client.reactions.remove({ channel, timestamp: userMsgTs, name }).catch(() => {});
    const startedAt = Date.now();
    const thinking = reactAdd(REACT_THINK);
    const swap = async (name) => {
      await thinking;
      const held = Date.now() - startedAt;
      if (held < REACT_MIN_MS) await sleep(REACT_MIN_MS - held);
      await reactDel(REACT_THINK);
      if (name) await reactAdd(name);
    };

    try {
      const out = await handleIncomingSlack({ text: message.text || '', slackUserId, slackUsername: handle, channelType: 'im' });
      const moodAck = out.kind === 'mood';
      const emojiAck = out.kind === 'ack'; // a contentless 🌱/👍 reply — the reaction carries it, no bubble
      const bareNote = out.kind === 'note' && !out.buttons && !out.document && !out.image;
      await swap(moodAck ? moodReactionName(out.moodEmoji) : emojiAck ? moodReactionName(out.ackEmoji) : out.kind === 'note' ? REACT_NOTE : REACT_DONE);
      if (moodAck || emojiAck || bareNote) return; // the reaction IS the whole ack — no text
      if (!out.reply && !out.document && !out.image && !out.buttons) return; // nothing to say
      const ts = await postBuilt(client, channel, out);
      rememberBotMessage(channel, ts, out.ref);
    } catch (err) {
      console.error('Slack message handler error:', err.message);
      await swap('rage'); // 🤬 on failure (matches Telegram's error reaction)
      await client.chat.postMessage({ channel, text: '☠️ Something went wrong filing that — try again in a moment?' }).catch(() => {});
    }
  });

  // ── tapped button: ack within 3s FIRST, then run the dispatcher and edit the card in place ──
  a.action(/^fanad_action_/, onSlackAction);

  // ── slash commands (OPTIONAL): the documented Slack sigil is "$" (Slack reserves "/" and swallows it; see
  // slack-format.js + the README). But if an operator ALSO registers native Slack slash commands, Slack
  // delivers them here over the socket — so we support them too. We rebuild the original "/cmd args" text
  // (slash kept — the brain's patterns expect it) and run it through the SAME pipeline as a typed DM.
  a.command(/.+/, async ({ command, ack, client, respond }) => {
    await ack(); // within 3s, before any slow brain/LLM work
    const slackUserId = command.user_id;
    const channel = command.channel_id;
    const text = `${command.command} ${command.text || ''}`.trim(); // e.g. "/forget 3"
    const { handle } = await resolveProfile(client, slackUserId);
    try {
      const out = await handleIncomingSlack({ text, slackUserId, slackUsername: handle, channelType: 'im' });
      // Unauthorized/empty → stay silent (we already ack'd, so Slack shows no error). Same anti-spam stance.
      if (!out.reply && !out.document && !out.image && !(out.buttons && out.buttons.length)) return;
      try {
        const ts = await postBuilt(client, channel, out);
        rememberBotMessage(channel, ts, out.ref);
      } catch (err) {
        // Can't post to that conversation (e.g. invoked from a channel the bot isn't in) → reply privately.
        // The ephemeral fallback is text-only, so log what happened — a document/image/buttons on the reply
        // don't survive it, and that downgrade was previously invisible.
        console.error('Slack post failed (falling back to ephemeral text):', err.message);
        await respond({ response_type: 'ephemeral', text: stripTags(out.reply || ' ') }).catch(() => {});
      }
    } catch (err) {
      console.error('Slack command error:', err.message);
      await respond({ response_type: 'ephemeral', text: '☠️ Something went wrong — try again in a moment?' }).catch(() => {});
    }
  });

  // ── emoji reaction on one of the bot's messages → mood/learning signal (ignore our own ack reactions) ──
  a.event('reaction_added', async ({ event, client }) => {
    try {
      if (!event || event.user === botUserId) return;              // skip reactions WE added (the 👀/🫡 acks)
      const ref = botMsgRefs.get(`${event.item?.channel}:${event.item?.ts}`) || null;
      if (!ref && event.item_user !== botUserId) return;           // only reactions on OUR messages count
      const emoji = unicodeForReaction(event.reaction);
      if (!emoji) return;
      const { handle } = await resolveProfile(client, event.user);
      handleReactionSlack({ emoji, slackUserId: event.user, slackUsername: handle, ref });
    } catch (err) { console.error('Slack reaction error:', err.message); }
  });

  a.error((err) => console.error('Slack app error:', err?.message || err));

  await a.start();
  try { const who = await a.client.auth.test(); botUserId = who?.user_id ?? null; console.log(`Slack bot ${who?.user ? `@${who.user}` : ''} is live.`); }
  catch { /* non-fatal: botUserId stays null → reaction self-filter relies on item_user */ }
  app = a;
  return a;
}

// Resolve a Slack id to its internal user id for the ACTION path (handleAction needs the userId, and a tap has
// already been authorized; getOrCreateSlackUser is the same mapping the inbound text path uses).
function getResolvedUserId(slackUserId, displayName) {
  return slackUserId ? getOrCreateSlackUser(slackUserId, displayName || null) : defaultUserId();
}

// Serialize start/stop so two rapid calls can't leave two sockets open (Socket Mode caps at 10/app).
function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}
export function startSlack() { return enqueue(doStart); }
export function stopSlack() { return enqueue(rawStop); }

// Push a message to a Slack user's 1:1 DM (the scheduler's wake-ups/reminders). Opens (or reuses) the DM
// channel via conversations.open. `_photo` is ignored — Slack has no Telegram-style re-send-by-file_id, and
// captured photos are Telegram-only. No-op if the bot isn't running or there's no target.
export async function sendSlack(text, slackUserId, _photo = null) {
  if (!app || !slackUserId) return false;
  try {
    const dm = await app.client.conversations.open({ users: slackUserId });
    const channel = dm?.channel?.id;
    if (!channel) return false;
    // Pushed notifications (wake-up nudges, "on <when>" reminders, timer dings) arrive unprompted, so each
    // carries a one-tap "✕" to clear it from the DM — the action handler routes m:hide:x to handleAction,
    // whose hide:true deletes the message (parity with sendTelegram's ✕ on the same pushes).
    const built = buildSlackMessage({ reply: String(text), buttons: [[CLOSE_BTN]] });
    const m = await app.client.chat.postMessage({ channel, text: built.text, blocks: built.blocks });
    noteChannelTs(channel, m?.ts ?? null); // pushed nudges advance the high-water mark too
    return true;
  } catch (err) { console.error('Slack send failed:', err.message); return false; }
}
