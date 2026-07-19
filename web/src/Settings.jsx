import { useEffect, useState } from 'react';
import * as api from './api.js';
import AiLog from './AiLog.jsx';
import ModulesSection from './ModulesSection.jsx';
import SystemModulesSection from './SystemModulesSection.jsx';
import HomeAssistantSection from './HomeAssistantSection.jsx';
import SpeedDialSection from './SpeedDialSection.jsx';
import ThemeSection from './ThemeSection.jsx';

const FALLBACK_URL = 'http://127.0.0.1:1234/v1'; // shown only before the provider catalog has loaded

// Left-bar categories. Each groups one or more of the panel's sections so the (long) settings list stays
// manageable — only the active category's sections render. Order here is the order shown in the nav.
const CATEGORIES = [
  { id: 'ai', label: 'AI connection', icon: '🧠' },
  { id: 'general', label: 'General', icon: '⚙️' },
  { id: 'modules', label: 'Modules', icon: '🧩' },
  { id: 'channels', label: 'Channels', icon: '💬' },
  { id: 'access', label: 'Access', icon: '🤝' },
  { id: 'security', label: 'Security', icon: '🔐' },
  { id: 'data', label: 'Data & privacy', icon: '🗄️' },
];

// Group active vouches by their voucher handle so the panel can render the endorsement tree (parent → child).
// A handle whose voucher isn't itself an active vouched user (vouched by the owner/seed allowlist) is a root,
// filed under the '' key.
function groupByVoucher(active) {
  const known = new Set(active.map((v) => v.username));
  const groups = {};
  for (const v of active) {
    const key = v.voucher_username && known.has(v.voucher_username) ? v.voucher_username : '';
    (groups[key] ||= []).push(v);
  }
  return groups;
}

export default function Settings({ onClose, theme = 'auto', onTheme = () => {} }) {
  const [form, setForm] = useState(null);
  // The provider catalog comes from the server (/api/config) — no hardcoded duplicate of the list/labels/urls.
  const [providers, setProviders] = useState([]);
  const cloudIds = providers.filter((p) => p.cloud).map((p) => p.id);
  const localDefaultUrl = Object.fromEntries(providers.filter((p) => !p.cloud && p.defaultUrl).map((p) => [p.id, p.defaultUrl]));
  const [status, setStatus] = useState(null);
  const [chatModels, setChatModels] = useState([]);
  const [embedModels, setEmbedModels] = useState([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [tg, setTg] = useState(null);
  const [tgStatus, setTgStatus] = useState(null);
  const [slack, setSlack] = useState(null);
  const [slackStatus, setSlackStatus] = useState(null);
  const [vouches, setVouches] = useState(null);
  const [vouchMsg, setVouchMsg] = useState(null);
  // features here backs only the Access tab's vouch toggle — the Modules tab is <ModulesSection/>,
  // which owns its own copy of this state (they write to the same per-user endpoint).
  const [features, setFeatures] = useState(null);
  const [aiLog, setAiLog] = useState(null);
  const [aiLogSaved, setAiLogSaved] = useState(false);
  const [showAiLog, setShowAiLog] = useState(false);
  const [retention, setRetention] = useState(null);
  const [retentionSaved, setRetentionSaved] = useState(false);
  const [weather, setWeather] = useState(null);
  const [weatherNow, setWeatherNow] = useState(null);
  const [setupMode, setSetupMode] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState(null);
  // Instance backup (Data & privacy): { backupMode, kekSource, kekFileExists } from /api/instance/status.
  const [instance, setInstance] = useState(null);
  const [includeKek, setIncludeKek] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [histMsg, setHistMsg] = useState(null);
  const [cat, setCat] = useState('ai'); // which left-bar category is showing
  // Web login (Security category). authStatus = /api/auth/status (root's account block + clientIp);
  // authCfg = /api/settings/auth (mode, allowRegistration, ipAllowlist, canEnableSimple).
  const [authStatus, setAuthStatus] = useState(null);
  const [authCfg, setAuthCfg] = useState(null);
  const [acct, setAcct] = useState({ username: '', newPassword: '', confirm: '', currentPassword: '' });
  const [acctMsg, setAcctMsg] = useState(null);
  const [enroll, setEnroll] = useState(null); // { qrDataUrl, otpauthUri } while an enrollment is open
  const [enrollCode, setEnrollCode] = useState('');
  const [enrollMsg, setEnrollMsg] = useState(null);
  const [ipText, setIpText] = useState('');
  const [ipMsg, setIpMsg] = useState(null);
  const [authSaved, setAuthSaved] = useState(false);
  // Site URL (the Security panel's Advanced section) — powers the chat /web sign-in links.
  const [site, setSite] = useState(null);
  const [siteSaved, setSiteSaved] = useState(false);
  // Demo guard switches (Security panel) — the owner's live kill switches (also flippable via chat "demo …").
  const [guard, setGuard] = useState(null);
  const [guardMsg, setGuardMsg] = useState(null);
  // CLI claim tokens (Security panel) — credentials for the `fanad <server> <token>` terminal client.
  // cliMinted holds a freshly-minted raw token, shown ONCE (only its hash is stored server-side).
  const [cliTokens, setCliTokens] = useState(null);
  const [cliMinted, setCliMinted] = useState(null);
  const [cliLabel, setCliLabel] = useState('');
  const [cliReadOnly, setCliReadOnly] = useState(false); // scope 'read' — dashboards / Home Assistant
  const [cliTtlDays, setCliTtlDays] = useState(90); // token lifetime in days; 0 = never expires (unlimited)
  const [cliMsg, setCliMsg] = useState(null);

  useEffect(() => {
    // Load the provider catalog first, then the saved LLM settings — so the cloud-fallback check below uses
    // the server's notion of which providers are cloud (no hardcoded list).
    api.getConfig().then((c) => {
      const list = c.providers || [];
      setProviders(list);
      const cloud = list.filter((p) => p.cloud).map((p) => p.id);
      return api.getLlmSettings().then((s) => {
        // If cloud is off but a cloud provider was previously saved, fall back to local for display.
        const provider = (!s.cloudEnabled && cloud.includes(s.provider)) ? 'lmstudio' : s.provider;
        setForm({ ...s, provider, apiKey: '' });
      });
    }).catch((e) => setError(e.message));
    // A failed section load must not strand its pane on "Loading…" (or silently hide it) — every one of these
    // endpoints answers 200 when healthy, so a rejection is a real failure: surface it on the shared error line.
    const loadFail = (what) => (e) => { console.error(`settings: ${what} failed to load`, e); setError(`${what} failed to load: ${e.message}`); };
    api.getTelegramSettings().then((s) => setTg({ ...s, botToken: '' })).catch(loadFail('Telegram'));
    api.getSlackSettings().then((s) => setSlack({ ...s, botToken: '', appToken: '', signingSecret: '' })).catch(loadFail('Slack'));
    api.getVouches().then((d) => setVouches(d.vouches || [])).catch(loadFail('Access list'));
    api.getFeatureSettings().then(setFeatures).catch(loadFail('Modules'));
    api.getAiLogSetting().then(setAiLog).catch(loadFail('AI log'));
    api.getRetentionSettings().then(setRetention).catch(loadFail('Retention'));
    api.getWeatherSettings().then(setWeather).catch(loadFail('Weather'));
    api.getSetup().then((s) => setSetupMode(!!s.setupMode)).catch(loadFail('Setup mode'));
    api.getInstanceStatus().then(setInstance).catch(loadFail('Backup'));
    api.getAuthStatus().then((s) => {
      setAuthStatus(s);
      setAcct((a) => ({ ...a, username: s.account?.username || '' }));
    }).catch(loadFail('Security'));
    api.getAuthSettings().then((c) => {
      setAuthCfg(c);
      setIpText((c.ipAllowlist || []).join('\n')); // seed once — later saves round-trip through the server
    }).catch(loadFail('Web login'));
    api.getSiteSettings().then(setSite).catch(loadFail('Site URL'));
    api.getGuardSettings().then(setGuard).catch(loadFail('Demo switches'));
    api.getCliTokens().then((d) => setCliTokens(d.tokens || [])).catch(loadFail('CLI tokens'));
  }, []);

  // ── CLI claim tokens (Security) ──
  const mintCli = () => {
    setCliMsg(null);
    const body = { ...(cliLabel.trim() ? { label: cliLabel.trim() } : {}), ...(cliReadOnly ? { readOnly: true } : {}), ttlDays: cliTtlDays };
    api.mintCliToken(body).then((d) => {
      setCliMinted(d);
      setCliLabel('');
      setCliReadOnly(false);
      setCliTtlDays(90);
      return api.getCliTokens().then((x) => setCliTokens(x.tokens || []));
    }).catch((e) => setCliMsg(e.message));
  };
  const revokeCli = (id) => {
    setCliMsg(null);
    api.revokeCliToken(id).then((d) => setCliTokens(d.tokens || [])).catch((e) => setCliMsg(e.message));
  };
  const cliTokenState = (t) => (t.revoked_at != null ? 'revoked' : (t.expires_at != null && Number(t.expires_at) <= Date.now()) ? 'expired' : 'live');
  const cliWhen = (ms) => (ms == null ? '—' : new Date(Number(ms)).toLocaleDateString());

  // ── Web login (Security) ──
  const simpleOn = authCfg?.mode === 'simple';
  const account = authStatus?.account || null;
  // Refresh mode/canEnableSimple after credential changes WITHOUT clobbering an in-progress ipText edit.
  const refreshAuthCfg = () => api.getAuthSettings().then((c) => setAuthCfg(c)).catch((e) => setError(e.message));

  async function saveAccountForm() {
    setError(null); setAcctMsg(null);
    if (acct.newPassword && acct.newPassword !== acct.confirm) { setError('Passwords don’t match.'); return; }
    const payload = {};
    if (acct.username.trim()) payload.username = acct.username.trim();
    if (acct.newPassword) payload.newPassword = acct.newPassword;
    if (simpleOn) payload.currentPassword = acct.currentPassword;
    setBusy(true);
    try {
      const res = await api.saveAccount(payload);
      setAuthStatus((s) => (s ? { ...s, account: res.account } : s));
      setAcct((a) => ({ ...a, newPassword: '', confirm: '', currentPassword: '' }));
      setAcctMsg('Saved ✓');
      refreshAuthCfg();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function startEnroll() {
    setError(null); setEnrollMsg(null);
    const body = {};
    if (simpleOn && account?.totp === 'verified') {
      // Re-enrolling replaces a WORKING authenticator — prove it's really the owner at the keyboard.
      const pw = window.prompt('Enter your current password to re-enroll 2FA:');
      if (pw == null) return;
      body.currentPassword = pw;
    }
    try {
      setEnroll(await api.totpSetup(body));
      setEnrollCode('');
    } catch (e) { setError(e.message); }
  }

  async function verifyEnroll() {
    setError(null);
    try {
      const res = await api.totpVerify(enrollCode);
      setEnroll(null); setEnrollCode('');
      if (res.account) setAuthStatus((s) => (s ? { ...s, account: res.account } : s));
      setEnrollMsg('2FA verified ✓');
      refreshAuthCfg();
    } catch (e) { setError(e.message); }
  }

  async function changeAuthMode(mode) {
    if (!authCfg || mode === authCfg.mode) return;
    const warning = mode === 'simple'
      ? 'Turn on web login? Everyone — including you — will sign in with a username, password, and 2FA code. (This tab stays signed in.)'
      : 'Turn off web login? The web UI will be open to anyone who can reach this server.';
    if (!window.confirm(warning)) return;
    setError(null); setAuthSaved(false);
    try { setAuthCfg(await api.saveAuthSettings({ mode })); setAuthSaved(true); }
    catch (e) { setError(e.message); }
  }

  async function toggleRegistration(enabled) {
    setAuthCfg((c) => ({ ...c, allowRegistration: enabled }));
    setAuthSaved(false);
    try { setAuthCfg(await api.saveAuthSettings({ allowRegistration: enabled })); setAuthSaved(true); }
    catch (e) { setAuthCfg((c) => ({ ...c, allowRegistration: !enabled })); setError(e.message); }
  }

  async function saveIpList(force = false) {
    setError(null); setIpMsg(null);
    const entries = ipText.split('\n').map((s) => s.trim()).filter(Boolean);
    try {
      const res = await api.saveAuthSettings({ ipAllowlist: entries, force });
      setAuthCfg(res);
      setIpText((res.ipAllowlist || []).join('\n'));
      setIpMsg(entries.length ? `Allowlist active (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}).` : 'Allowlist cleared — no IP restriction.');
    } catch (e) {
      // The server refuses a list that would block the address you're on unless you confirm (force).
      if (e.body?.needsForce && window.confirm(`${e.message}\n\nSave anyway? (localhost always keeps working)`)) return saveIpList(true);
      setError(e.message);
    }
  }

  async function saveSiteForm() {
    setError(null); setSiteSaved(false); setBusy(true);
    try { setSite(await api.saveSiteSettings({ url: site?.url || '' })); setSiteSaved(true); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  // Optimistic flip with rollback on failure — same shape as toggleRegistration above.
  async function toggleGuard(key, value) {
    setGuard((g) => ({ ...g, [key]: value }));
    setGuardMsg(null);
    try { setGuard(await api.saveGuardSettings({ [key]: value })); setGuardMsg('Saved ✓'); }
    catch (e) { setGuard((g) => ({ ...g, [key]: !value })); setError(e.message); }
  }

  // Numeric guard field (the per-IP /demo cap): commit on blur. The server is the source of truth, so we
  // adopt whatever it returns (it validated + coerced) and reload from it on error to undo a bad local edit.
  async function saveGuardNumber(key, value) {
    setGuardMsg(null);
    try { setGuard(await api.saveGuardSettings({ [key]: value })); setGuardMsg('Saved ✓'); }
    catch (e) { setError(e.message); api.getGuardSettings().then(setGuard).catch(() => {}); }
  }

  async function doBackup() {
    setError(null);
    try {
      const data = await api.backupSettings();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'fanad-settings-backup.json'; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(e.message); }
  }

  async function doRestore(file) {
    setError(null); setRestoreMsg(null);
    try {
      const data = JSON.parse(await file.text());
      const res = await api.restoreSettings(data);
      setRestoreMsg(`Restored: ${(res.restored || []).join(', ') || 'nothing'}. Reloading…`);
      setTimeout(() => window.location.reload(), 900);
    } catch (e) { setError(e.message); }
  }

  // The whole-instance backup zip (BACKUP_MODE-gated). Can take a moment on a big data dir — the server
  // builds the archive synchronously — so the button shows a busy state instead of double-firing.
  async function doInstanceBackup() {
    setError(null); setBackupBusy(true);
    try {
      const { blob, name } = await api.exportBackup(includeKek);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(e.message); }
    setBackupBusy(false);
  }

  async function doClearHistory(scope) {
    const what = scope === 'all' ? 'your entire chat history' : 'chat messages older than 30 days';
    if (!window.confirm(`Delete ${what}? Your tasks and notes are kept. This can’t be undone.`)) return;
    setError(null); setHistMsg(null);
    try {
      const res = await api.clearHistory(scope);
      setHistMsg(`Cleared ${res.removed} message${res.removed === 1 ? '' : 's'}. Reloading…`);
      setTimeout(() => window.location.reload(), 900);
    } catch (e) { setError(e.message); }
  }

  // Per-user module toggle (the Access tab's vouch checkbox; the rest live in <ModulesSection/>).
  // Vouch is auto-on for the owner regardless of the stored flag.
  async function toggleFeature(key, enabled) {
    setFeatures((f) => ({ ...f, [key]: enabled }));
    try { setFeatures(await api.saveFeatureSettings({ [key]: enabled })); }
    catch (e) { setFeatures((f) => ({ ...f, [key]: !enabled })); setError(e.message); } // revert the optimistic flip — the checkbox must show the persisted state
  }

  // AI activity log: an operator diagnostic (global, not per-user). Off by default; when on, every model
  // call is captured to a bounded in-memory log you can tail from "View log".
  async function toggleAiLog(enabled) {
    setAiLog((a) => ({ ...a, enabled }));
    setAiLogSaved(false);
    try { setAiLog(await api.saveAiLogSetting({ enabled })); setAiLogSaved(true); }
    catch (e) { setAiLog((a) => ({ ...a, enabled: !enabled })); setError(e.message); }
  }

  async function toggleRetention(enabled) {
    setRetention((r) => ({ ...r, enabled }));
    setRetentionSaved(false);
    try { setRetention(await api.saveRetentionSettings({ enabled })); setRetentionSaved(true); }
    catch (e) { setRetention((r) => ({ ...r, enabled: !enabled })); setError(e.message); }
  }

  async function saveWeather() {
    setError(null); setWeatherNow(null);
    try {
      const res = await api.saveWeatherSettings({ location: weather.location || '', unit: weather.unit || 'F' });
      setWeather({ location: res.location, unit: res.unit, timezone: res.timezone });
      // `problem` distinguishes a fetch failure from a place the geocoder doesn't know — without it, a
      // network outage was misreported as a mistyped location.
      setWeatherNow(res.current ? `${res.current.label}, ${res.current.temp}°${res.current.unit}`
        : res.problem ? `couldn’t check the weather right now (${res.problem})`
          : (weather.location ? 'couldn’t find that place' : 'cleared'));
    } catch (e) { setError(e.message); }
  }

  async function saveTelegram() {
    setBusy(true); setError(null); setTgStatus(null);
    try {
      const payload = { enabled: tg.enabled, allowedUsername: tg.allowedUsername };
      if (tg.botToken && tg.botToken.trim()) payload.botToken = tg.botToken.trim();
      const res = await api.saveTelegramSettings(payload);
      setTg((f) => ({ ...f, ...res, botToken: '' }));
      setTgStatus(res);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function saveSlack() {
    setBusy(true); setError(null); setSlackStatus(null);
    try {
      const payload = { enabled: slack.enabled, mode: slack.mode || 'socket', allowedSlack: slack.allowedSlack || '' };
      if (slack.botToken && slack.botToken.trim()) payload.botToken = slack.botToken.trim();
      if (slack.appToken && slack.appToken.trim()) payload.appToken = slack.appToken.trim();
      if (slack.signingSecret && slack.signingSecret.trim()) payload.signingSecret = slack.signingSecret.trim();
      const res = await api.saveSlackSettings(payload);
      setSlack((f) => ({ ...f, ...res, botToken: '', appToken: '', signingSecret: '' }));
      setSlackStatus(res);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function doRevokeVouch(username, platform = 'telegram') {
    if (!window.confirm(`Revoke ${username} — and everyone they vouched in? Their access stops immediately. The record is kept.`)) return;
    setError(null); setVouchMsg(null);
    try {
      const res = await api.revokeVouch(username, platform);
      const list = await api.getVouches();
      setVouches(list.vouches || []);
      setVouchMsg(res.revoked.length
        ? `Revoked ${res.revoked.length}: ${res.revoked.map((u) => `@${u}`).join(', ')}`
        : 'Nothing to revoke.');
    } catch (e) { setError(e.message); }
  }

  const up = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setSaved(false); };

  // Switching provider swaps in the matching local default URL, unless the user typed a custom one.
  function changeProvider(v) {
    setForm((f) => {
      const next = { ...f, provider: v };
      if (localDefaultUrl[v] && (!f.baseUrl || Object.values(localDefaultUrl).includes(f.baseUrl))) {
        next.baseUrl = localDefaultUrl[v];
      }
      return next;
    });
    setSaved(false);
  }

  async function test() {
    setBusy(true); setError(null); setStatus(null);
    try {
      // Persist what you just typed so the probe targets it — the address AND, for cloud providers, the key.
      // (Testing a freshly-pasted key without saving it first would otherwise probe with the old/empty key.)
      const pre = { provider: form.provider, baseUrl: form.baseUrl };
      if (form.apiKey && form.apiKey.trim()) pre.apiKey = form.apiKey.trim();
      await api.saveLlmSettings(pre);
      const st = await api.llmStatusCheck();
      setStatus(st);
      const models = st.models || [];
      const chat = models.filter((m) => m.type !== 'embeddings');
      const emb = models.filter((m) => m.type === 'embeddings');
      setChatModels(chat.length ? chat : models);
      setEmbedModels(emb.length ? emb : models);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setError(null);
    try {
      const payload = {
        provider: form.provider,
        embedProvider: form.provider === 'anthropic' ? 'lmstudio' : form.provider,
        baseUrl: form.baseUrl,
        chatModel: form.chatModel,
        embedModel: form.embedModel,
      };
      if (form.apiKey && form.apiKey.trim()) payload.apiKey = form.apiKey.trim();
      const updated = await api.saveLlmSettings(payload);
      setForm((f) => ({ ...f, ...updated, apiKey: '' }));
      setSaved(true);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  if (!form) {
    // The initial load can fail (server restarting, /api/config 500) — show the captured error instead of a
    // forever-"Loading…", and keep the panel dismissible (same close affordances as the main render).
    return (
      <div className="settings-overlay" onClick={onClose}>
        <div className="settings" onClick={(e) => e.stopPropagation()}>
          <div className="settings-head">
            <h2>Settings</h2>
            <button className="x" onClick={onClose} aria-label="Close">✕</button>
          </div>
          {error ? <p className="err">⚠ {error}</p> : <p>Loading…</p>}
        </div>
      </div>
    );
  }
  const isLocal = !cloudIds.includes(form.provider); // lmstudio + ollama use a Server address, not a key
  const showModels = form.provider !== 'lmstudio';    // Ollama + cloud need an explicit model; LM Studio auto-detects
  const localName = form.provider === 'ollama' ? 'Ollama' : 'LM Studio';
  // Cloud providers only appear when the server enables them (LLM_ALLOW_CLOUD); otherwise local-only.
  const providerOptions = form.cloudEnabled ? providers : providers.filter((p) => !p.cloud);

  // Vouch panel: split the flat list into the active endorsement tree + a tail of revoked handles.
  const activeVouches = (vouches || []).filter((v) => !v.revoked_at);
  const vouchGroups = groupByVoucher(activeVouches);
  const vouchRoots = vouchGroups[''] || [];
  const revokedVouches = (vouches || []).filter((v) => v.revoked_at);
  // One endorsement and its sub-tree. `seen` guards against a vouch cycle (a↔b) blowing the stack.
  // A Slack vouch is keyed on the immutable Uxxxx id (no '@'); a Telegram vouch on the @handle.
  const vouchLabel = (v, name) => (v?.platform === 'slack' ? name : `@${name}`);
  const renderVouchNode = (v, depth = 0, seen = new Set()) => {
    if (seen.has(v.username)) return null;
    const nextSeen = new Set(seen).add(v.username);
    const kids = vouchGroups[v.username] || [];
    return (
      <div key={`${v.platform || 'telegram'}:${v.username}`} className="vouch-node" style={{ marginLeft: depth ? 18 : 0 }}>
        <div className="vouch-row">
          <span className="vouch-who">{vouchLabel(v, v.username)}</span>
          {v.platform === 'slack' && <span className="sub">slack</span>}
          <span className="sub">{v.voucher_username ? `← ${vouchLabel(v, v.voucher_username)}` : '← owner'}</span>
          <button className="ghost danger" onClick={() => doRevokeVouch(v.username, v.platform || 'telegram')}>Revoke</button>
        </div>
        {kids.map((k) => renderVouchNode(k, depth + 1, nextSeen))}
      </div>
    );
  };

  return (
    <>
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings has-nav" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Settings</h2>
          <button className="x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="settings-main">
          <nav className="settings-nav" aria-label="Settings categories">
            {CATEGORIES.map((c) => (
              <button key={c.id} type="button" className={cat === c.id ? 'on' : ''}
                aria-current={cat === c.id ? 'page' : undefined} onClick={() => setCat(c.id)}>
                <span className="nav-ico" aria-hidden="true">{c.icon}</span>{c.label}
              </button>
            ))}
          </nav>

          <div className="settings-body">
            {cat === 'ai' && (
              <div className="settings-cat">
                <h3>Connect your AI</h3>
                <p className="hint">
                  Fanad uses a language model to sort your notes. The easiest is a free local one:
                  install <strong>LM Studio</strong>, open its <em>Developer</em> tab, click <em>Start Server</em>,
                  and load a chat model <em>and</em> an embedding model.
                </p>

                <label>Provider
                  <select value={form.provider} onChange={(e) => changeProvider(e.target.value)}>
                    {providerOptions.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                </label>

                {isLocal ? (
                  <label>Server address
                    <input value={form.baseUrl} onChange={(e) => up('baseUrl', e.target.value)}
                      placeholder={localDefaultUrl[form.provider] || FALLBACK_URL} />
                    <span className="sub">Default is <code>{localDefaultUrl[form.provider] || FALLBACK_URL}</code>. On another computer, use its address.</span>
                  </label>
                ) : (
                  <label>API key
                    <input type="password" value={form.apiKey} onChange={(e) => up('apiKey', e.target.value)}
                      placeholder={form.hasApiKey ? '•••••• (saved — leave blank to keep)' : 'paste your key'} />
                    <span className="sub">Heads up: cloud providers send your notes off your machine.</span>
                  </label>
                )}

                <div className="test-row">
                  <button className="ghost" onClick={test} disabled={busy}>{busy ? 'Testing…' : 'Test connection'}</button>
                  {status && (status.ok
                    ? <span className="ok">✓ Connected — {status.models?.length || 0} model(s) found</span>
                    : <span className="bad">✕ {status.error || (status.reachable ? 'error' : 'Not reachable — is the server running?')}</span>)}
                </div>

                {!showModels ? (
                  <p className="hint">Fanad uses whatever chat + embedding models you currently have loaded in {localName} —
                    no need to pick them here. Just load one of each in {localName}.
                    {status?.models?.length ? ` (Loaded: ${status.models.map((m) => m.id).join(', ')})` : ''}</p>
                ) : (
                  <>
                    <label>Chat model
                      {chatModels.length
                        ? (
                          <select value={form.chatModel} onChange={(e) => up('chatModel', e.target.value)}>
                            <option value="">— pick a model —</option>
                            {chatModels.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
                          </select>
                        ) : (
                          <input value={form.chatModel} onChange={(e) => up('chatModel', e.target.value)} placeholder="Test the connection to list models" />
                        )}
                    </label>

                    <label>Embedding model <span className="sub">— used to find related tasks</span>
                      {embedModels.length
                        ? (
                          <select value={form.embedModel} onChange={(e) => up('embedModel', e.target.value)}>
                            <option value="">— pick a model —</option>
                            {embedModels.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
                          </select>
                        ) : (
                          <input value={form.embedModel} onChange={(e) => up('embedModel', e.target.value)} placeholder="e.g. nomic-embed-text" />
                        )}
                    </label>
                  </>
                )}

                <div className="settings-foot">
                  {saved && <span className="ok">Saved ✓</span>}
                  <button className="primary" onClick={save} disabled={busy}>Save</button>
                </div>

                {aiLog && (
                  <div className="tg-section">
                    <h3>AI activity log <span className="sub">— diagnostics</span></h3>
                    <p className="hint">See exactly what the model is doing: every call’s purpose, the prompt
                      sent, the raw reply (including the model’s <code>&lt;think&gt;</code> reasoning), how long
                      it took, and — for <code>/whatdo</code> — whether the AI actually chose the suggestion or
                      it fell back. <strong>Off by default:</strong> it records your task text into a small
                      in-memory log (the last 150 calls), so leave it off unless you’re diagnosing.</p>
                    <label className="check">
                      <input type="checkbox" checked={aiLog.enabled === true} onChange={(e) => toggleAiLog(e.target.checked)} />
                      Record AI activity
                    </label>
                    <div className="settings-foot">
                      {aiLogSaved && <span className="ok">Saved ✓</span>}
                      <button className="ghost" onClick={() => setShowAiLog(true)}>View log</button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {cat === 'general' && (
              <div className="settings-cat">
                <ThemeSection theme={theme} onTheme={onTheme} />

                {weather && (
                  <div className="tg-section">
                    <h3>Weather &amp; timezone (optional)</h3>
                    <p className="hint">Show local weather in the status line. Conditions come from
                      <strong> Open-Meteo</strong> (no key needed). Your location also sets the server’s
                      timezone{weather.timezone ? <> — currently <strong>{weather.timezone}</strong></> : ''}, so
                      day boundaries and wake-ups follow <em>your</em> clock even on a hosted box.</p>
                    <label>Location <span className="sub">— a town or city, e.g. “Dublin” or “Austin, TX”</span>
                      <input value={weather.location || ''} onChange={(e) => setWeather({ ...weather, location: e.target.value })}
                        placeholder="your town or city" />
                    </label>
                    <label className="check">
                      <input type="checkbox" checked={(weather.unit || 'F') === 'F'}
                        onChange={(e) => setWeather({ ...weather, unit: e.target.checked ? 'F' : 'C' })} />
                      Show °F (uncheck for °C)
                    </label>
                    <div className="settings-foot">
                      {weatherNow && <span className="ok">{weatherNow}</span>}
                      <button className="primary" onClick={saveWeather} disabled={busy}>Save weather</button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {cat === 'modules' && (
              <div className="settings-cat">
                <SystemModulesSection />
                <ModulesSection />
              </div>
            )}

            {cat === 'channels' && (
              <div className="settings-cat">
                {tg && (
                  <div className="tg-section">
                    <h3>Telegram (optional)</h3>
                    <p className="hint">File notes from your phone. Create a bot with <strong>@BotFather</strong> in
                      Telegram, copy its token, and paste it here.</p>
                    <label>Bot token
                      <input type="password" value={tg.botToken} onChange={(e) => setTg({ ...tg, botToken: e.target.value })}
                        placeholder={tg.hasToken ? '•••••• (saved — leave blank to keep)' : 'paste the BotFather token'} />
                    </label>
                    <label>Only respond to <span className="sub">— optional; your @username, keeps strangers out</span>
                      <input value={tg.allowedUsername} onChange={(e) => setTg({ ...tg, allowedUsername: e.target.value })} placeholder="@yourusername" />
                    </label>
                    <p className="hint">Manage individual accounts and Home Assistant speed dial in the <strong>Access</strong> tab.</p>
                    <label className="check">
                      <input type="checkbox" checked={tg.enabled} onChange={(e) => setTg({ ...tg, enabled: e.target.checked })} />
                      Enable Telegram
                    </label>
                    <div className="settings-foot">
                      {tgStatus && (tgStatus.started
                        ? <span className="ok">Bot is live ✓</span>
                        : tgStatus.error ? <span className="bad">{tgStatus.error}</span> : <span className="sub">Saved</span>)}
                      <button className="primary" onClick={saveTelegram} disabled={busy}>Save Telegram</button>
                    </div>
                  </div>
                )}

                {slack && (
                  <div className="tg-section">
                    <h3>Slack (optional)</h3>
                    <p className="hint">Use Fanad as a Slackbot too. Create an app at <strong>api.slack.com/apps</strong>,
                      turn on <strong>Socket Mode</strong>, then paste the <em>Bot User OAuth Token</em> (xoxb-) and an
                      <em> App-Level Token</em> (xapp-, scope <code>connections:write</code>). DM the bot to use it.</p>
                    <label>Bot token <span className="sub">— xoxb-…</span>
                      <input type="password" value={slack.botToken} onChange={(e) => setSlack({ ...slack, botToken: e.target.value })}
                        placeholder={slack.hasBotToken ? '•••••• (saved — leave blank to keep)' : 'paste the xoxb- bot token'} />
                    </label>
                    <label>App-level token <span className="sub">— xapp-… (Socket Mode)</span>
                      <input type="password" value={slack.appToken} onChange={(e) => setSlack({ ...slack, appToken: e.target.value })}
                        placeholder={slack.hasAppToken ? '•••••• (saved — leave blank to keep)' : 'paste the xapp- app token'} />
                    </label>
                    <label>Only respond to <span className="sub">— optional; Slack user IDs (Uxxxx) or @handles, comma-separated</span>
                      <input value={slack.allowedSlack || ''} onChange={(e) => setSlack({ ...slack, allowedSlack: e.target.value })} placeholder="U01ABC23DE, @you" />
                    </label>
                    <label className="check">
                      <input type="checkbox" checked={slack.enabled} onChange={(e) => setSlack({ ...slack, enabled: e.target.checked })} />
                      Enable Slack
                    </label>
                    <div className="settings-foot">
                      {slackStatus && (slackStatus.started
                        ? <span className="ok">Bot is live ✓</span>
                        : slackStatus.error ? <span className="bad">{slackStatus.error}</span> : <span className="sub">Saved</span>)}
                      <button className="primary" onClick={saveSlack} disabled={busy}>Save Slack</button>
                    </div>
                  </div>
                )}

                <HomeAssistantSection />
              </div>
            )}

            {cat === 'access' && (
              <div className="settings-cat">
                <SpeedDialSection />
                {vouches ? (
                  <div className="tg-section">
                    <h3>Access — vouched-in users</h3>
                    <p className="hint">Anyone already allowed can type <code>vouch @username</code> in chat to let
                      someone in — that's how access grows. Revoking a person also revokes everyone <em>they</em>
                      vouched in; the record of who vouched whom is kept either way.</p>
                    {features && (
                      <label className="check">
                        <input type="checkbox" checked={features.vouch === true} onChange={(e) => toggleFeature('vouch', e.target.checked)} />
                        Allow vouching <span className="sub">— vouch is a per-user module; it’s always on for you as the owner so you can add the first people</span>
                      </label>
                    )}
                    {vouchRoots.length > 0
                      ? <div className="vouch-tree">{vouchRoots.map((v) => renderVouchNode(v))}</div>
                      : <p className="sub">No one's been vouched in yet.</p>}
                    {revokedVouches.length > 0 && (
                      <p className="hint">Revoked (record kept): {revokedVouches.map((v) => vouchLabel(v, v.username)).join(', ')}</p>
                    )}
                    {vouchMsg && <span className="ok">{vouchMsg}</span>}
                  </div>
                ) : <p className="hint">Loading…</p>}
              </div>
            )}

            {cat === 'security' && (
              <div className="settings-cat">
                {authStatus && authCfg ? (
                  <>
                    <div className="tg-section">
                      <h3>Web login account</h3>
                      <p className="hint">The root account you'll sign in with once login is turned on. Set the
                        username and password here <strong>before</strong> enabling it below.</p>
                      <label>Username
                        <input value={acct.username} onChange={(e) => { setAcct({ ...acct, username: e.target.value }); setAcctMsg(null); }}
                          placeholder="e.g. admin" autoComplete="username" />
                      </label>
                      <label>New password <span className="sub">— at least 8 characters</span>
                        <input type="password" value={acct.newPassword} onChange={(e) => { setAcct({ ...acct, newPassword: e.target.value }); setAcctMsg(null); }}
                          placeholder={account?.passwordSet ? '•••••• (saved — leave blank to keep)' : 'choose a password'} autoComplete="new-password" />
                      </label>
                      <label>Confirm new password
                        <input type="password" value={acct.confirm} onChange={(e) => setAcct({ ...acct, confirm: e.target.value })} autoComplete="new-password" />
                      </label>
                      {simpleOn && (
                        <label>Current password <span className="sub">— required while login is on</span>
                          <input type="password" value={acct.currentPassword} onChange={(e) => setAcct({ ...acct, currentPassword: e.target.value })} autoComplete="current-password" />
                        </label>
                      )}
                      <div className="settings-foot">
                        {acctMsg && <span className="ok">{acctMsg}</span>}
                        <button className="primary" onClick={saveAccountForm} disabled={busy}>Save account</button>
                      </div>
                    </div>

                    <div className="tg-section">
                      <h3>Two-factor authentication <span className="sub">— required for login</span></h3>
                      <p className="hint">
                        {account?.totp === 'verified'
                          ? <>Enrolled ✓{account.totpVerifiedAt ? ` on ${new Date(account.totpVerifiedAt).toLocaleDateString()}` : ''} — codes from your authenticator app are required at sign-in.</>
                          : account?.totp === 'pending'
                            ? <>A scan is pending — enter a code below to finish, or start over.</>
                            : <>Not enrolled yet. You'll scan a QR code with an authenticator app (Google Authenticator, Authy, 1Password…).</>}
                      </p>
                      {!enroll && (
                        <div className="setup-actions">
                          <button className="ghost" onClick={startEnroll}>
                            {account?.totp === 'verified' ? 'Re-enroll (new device)' : 'Enroll 2FA'}
                          </button>
                          {enrollMsg && <span className="ok">{enrollMsg}</span>}
                        </div>
                      )}
                      {enroll && (
                        <>
                          <div className="qr-box">
                            <img src={enroll.qrDataUrl} alt="TOTP enrollment QR code" />
                            <span className="sub">Can't scan? Enter this key manually: <code>{(() => { try { return new URL(enroll.otpauthUri).searchParams.get('secret'); } catch { return ''; } })()}</code></span>
                          </div>
                          <label>6-digit code from the app
                            <input value={enrollCode} onChange={(e) => setEnrollCode(e.target.value)} inputMode="numeric" placeholder="123456" />
                          </label>
                          <div className="settings-foot">
                            <button className="ghost" onClick={() => { setEnroll(null); setEnrollCode(''); }}>Cancel</button>
                            <button className="primary" onClick={verifyEnroll} disabled={enrollCode.replace(/\D/g, '').length < 6}>Verify</button>
                          </div>
                        </>
                      )}
                    </div>

                    <div className="tg-section">
                      <h3>Login requirement</h3>
                      <p className="hint">With login <strong>off</strong>, the web UI trusts the network (fine on a
                        private machine). Turning it <strong>on</strong> requires every web visitor — including you —
                        to sign in with a username, password, and 2FA code. Telegram/Slack are unaffected.
                        Locked out? Restart the server with <code>AUTH_RESET=1</code>.</p>
                      <label>Auth mode
                        <select value={authCfg.mode} onChange={(e) => changeAuthMode(e.target.value)}>
                          <option value="none">none — no web login</option>
                          <option value="simple" disabled={!authCfg.canEnableSimple && authCfg.mode !== 'simple'}>
                            simple — username + password + 2FA
                          </option>
                        </select>
                        {!authCfg.canEnableSimple && authCfg.mode !== 'simple' && (
                          <span className="sub">To enable: {[
                            !account?.username && 'set a username',
                            !account?.passwordSet && 'set a password',
                            account?.totp !== 'verified' && 'enroll & verify 2FA',
                          ].filter(Boolean).join(' · ')}</span>
                        )}
                      </label>
                      <label className="check" style={{ marginTop: 14 }}>
                        <input type="checkbox" checked={authCfg.allowRegistration === true}
                          onChange={(e) => toggleRegistration(e.target.checked)} />
                        Allow new users to register
                        <span className="sub">— shows "Create an account" on the login screen (applies while login is on)</span>
                      </label>
                      {authSaved && <span className="ok">Saved ✓</span>}
                      {simpleOn && (
                        <div className="setup-actions">
                          <button className="ghost" onClick={() => api.logout().finally(() => window.location.reload())}>Log out of this session</button>
                        </div>
                      )}
                    </div>

                    <div className="tg-section">
                      <h3>Demo switches</h3>
                      <p className="hint">Live kill switches for a shared or demo deployment — flip them here or from
                        chat (<code>demo pause</code>, <code>demo freeze</code>). No restart needed.</p>
                      {guard ? (
                        <>
                          <label className="check">
                            <input type="checkbox" checked={guard.demoPaused === true}
                              onChange={(e) => toggleGuard('demoPaused', e.target.checked)} />
                            Pause the demo
                            <span className="sub">— everyone but you is shut out: bots go silent, the web says "back soon"</span>
                          </label>
                          <label className="check">
                            <input type="checkbox" checked={guard.vouchFrozen === true}
                              onChange={(e) => toggleGuard('vouchFrozen', e.target.checked)} />
                            Freeze vouching
                            <span className="sub">— no new invites; people already vouched in keep their access</span>
                          </label>
                          <label className="check">
                            <input type="checkbox" checked={guard.demoSignupOpen === true}
                              onChange={(e) => toggleGuard('demoSignupOpen', e.target.checked)} />
                            Open demo signups
                            <span className="sub">— the public <code>/demo</code> page lets visitors enter their Telegram
                              handle and vouch themselves in (recorded as “vouched by @demo”)</span>
                          </label>
                          {guard.demoSignupOpen === true && (
                            <p className="hint">Share {site?.url ? <a href={`${site.url}/demo`} target="_blank" rel="noreferrer">{site.url}/demo</a> : <code>/demo</code>} to
                              invite people{!site?.url && <> — set the Site URL under Advanced below to give the link a rich preview</>}.</p>
                          )}
                          <label>Max signups per IP address <span className="sub">— caps how many seats one address can claim via <code>/demo</code>; 0 = no limit</span>
                            <input type="number" min="0" step="1" style={{ width: '6rem' }}
                              value={guard.demoSignupsPerIp ?? ''}
                              onChange={(e) => { setGuard((g) => ({ ...g, demoSignupsPerIp: e.target.value })); setGuardMsg(null); }}
                              onBlur={(e) => saveGuardNumber('demoSignupsPerIp', Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
                          </label>
                          {guardMsg && <span className="ok">{guardMsg}</span>}
                        </>
                      ) : <p className="hint">Loading…</p>}
                    </div>

                    <div className="tg-section">
                      <h3>Terminal client tokens</h3>
                      <p className="hint">Long-lived claim tokens for the terminal chat client — connect with
                        {' '}<code>fanad &lt;server&gt; &lt;token&gt;</code>. A token acts as its user (chat only, never
                        these settings) and can be revoked here any time. You can also mint from the server box:
                        {' '}<code>fanad token</code>.</p>
                      <label className="check">
                        <input type="checkbox" checked={authCfg?.cliEnabled === true}
                          onChange={(e) => api.saveAuthSettings({ cliEnabled: e.target.checked })
                            .then(setAuthCfg).catch((err) => setCliMsg(err.message))} />
                        Enable the terminal client
                        <span className="sub">— off (the default) means no tokens work and none can be minted;
                          flipping it off later instantly disables every outstanding token without revoking them</span>
                      </label>
                      {cliMinted && (
                        <div className="tg-section" style={{ borderColor: 'var(--accent, #888)' }}>
                          <p className="hint"><strong>Copy this now — it is shown once</strong> (only its hash is stored):</p>
                          {cliMinted.scope === 'read'
                            ? <p><code style={{ userSelect: 'all', wordBreak: 'break-all' }}>{cliMinted.token}</code></p>
                            : <p><code style={{ userSelect: 'all', wordBreak: 'break-all' }}>fanad {site?.url || window.location.origin} {cliMinted.token}</code></p>}
                          <div className="setup-actions">
                            <button className="ghost" onClick={() => {
                              const text = cliMinted.scope === 'read' ? cliMinted.token : `fanad ${site?.url || window.location.origin} ${cliMinted.token}`;
                              navigator.clipboard?.writeText(text).catch(() => {});
                            }}>{cliMinted.scope === 'read' ? 'Copy token' : 'Copy connect command'}</button>
                            <button className="ghost" onClick={() => setCliMinted(null)}>Done — hide it</button>
                          </div>
                        </div>
                      )}
                      <label>Label <span className="sub">— what machine is this for? (“laptop”, “work desktop”)</span>
                        <input value={cliLabel} onChange={(e) => { setCliLabel(e.target.value); setCliMsg(null); }}
                          placeholder="laptop" spellCheck={false} autoComplete="off" />
                      </label>
                      <label className="check">
                        <input type="checkbox" checked={cliReadOnly} onChange={(e) => setCliReadOnly(e.target.checked)} />
                        Read-only
                        <span className="sub">— can only read (GET); for dashboards and the Home Assistant
                          integration. It can never post chat or change anything.</span>
                      </label>
                      <label>Expires <span className="sub">— how long this token stays valid; pick “Never” for
                        always-on credentials like a Home Assistant dashboard</span>
                        <select value={cliTtlDays} onChange={(e) => { setCliTtlDays(Number(e.target.value)); setCliMsg(null); }}>
                          <option value={30}>30 days</option>
                          <option value={90}>90 days</option>
                          <option value={365}>1 year</option>
                          <option value={0}>Never (unlimited)</option>
                        </select>
                      </label>
                      <div className="settings-foot">
                        {cliMsg && <span className="ok">{cliMsg}</span>}
                        <button className="primary" onClick={mintCli} disabled={busy || authCfg?.cliEnabled !== true}
                          title={authCfg?.cliEnabled === true ? undefined : 'Enable the terminal client first'}>
                          Mint token ({cliTtlDays === 0 ? 'never expires' : cliTtlDays === 365 ? '1 year' : `${cliTtlDays} days`})
                        </button>
                      </div>
                      {cliTokens?.length > 0 && (
                        <table className="data-table" style={{ marginTop: '0.5rem' }}>
                          <thead><tr><th>Label</th><th>State</th><th>Scope</th><th>Created</th><th>Last used</th><th>Expires</th><th /></tr></thead>
                          <tbody>
                            {cliTokens.map((t) => (
                              <tr key={t.id} style={cliTokenState(t) !== 'live' ? { opacity: 0.55 } : undefined}>
                                <td>{t.label || `token #${t.id}`}</td>
                                <td>{cliTokenState(t)}</td>
                                <td>{t.scope === 'read' ? 'read-only' : 'full'}</td>
                                <td>{cliWhen(t.created_at)}</td>
                                <td>{cliWhen(t.last_used_at)}</td>
                                <td>{t.expires_at == null ? 'never' : cliWhen(t.expires_at)}</td>
                                <td>{cliTokenState(t) === 'live'
                                  ? <button className="ghost" onClick={() => revokeCli(t.id)}>Revoke</button>
                                  : null}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>

                    <div className="tg-section">
                      <h3>Web IP allowlist (optional)</h3>
                      <p className="hint">Restrict the whole web UI to specific addresses — one IP or CIDR range per
                        line (e.g. <code>192.168.1.0/24</code>). Applies whether login is on or off; empty means no
                        restriction. <code>localhost</code> always works, so you can't lock yourself out of the box
                        itself.{authStatus.clientIp ? <> The server currently sees you as <code>{authStatus.clientIp}</code>.</> : null}</p>
                      <label>Allowed IPs / ranges
                        <textarea className="ip-list" rows={4} value={ipText} onChange={(e) => { setIpText(e.target.value); setIpMsg(null); }}
                          placeholder={'192.168.1.0/24\n203.0.113.7'} spellCheck={false} />
                      </label>
                      <div className="settings-foot">
                        {ipMsg && <span className="ok">{ipMsg}</span>}
                        <button className="primary" onClick={() => saveIpList(false)} disabled={busy}>Save allowlist</button>
                      </div>
                    </div>

                    <div className="tg-section">
                      <h3>Advanced</h3>
                      {site ? (
                        <>
                          <label>Site URL <span className="sub">— the public address of this server</span>
                            <input value={site.url} onChange={(e) => { setSite({ ...site, url: e.target.value }); setSiteSaved(false); }}
                              placeholder="https://fanad.example.com" spellCheck={false} autoComplete="off" />
                          </label>
                          <p className="hint">Powers the <code>/web</code> chat command: a Telegram or Slack user
                            gets a one-time link that opens this web UI signed in as them — handy for people who only
                            ever chat with the bot. Needs web login (above) to be <strong>on</strong>; leave blank to
                            keep /web off.</p>
                          <div className="settings-foot">
                            {siteSaved && <span className="ok">Saved ✓</span>}
                            <button className="primary" onClick={saveSiteForm} disabled={busy}>Save site URL</button>
                          </div>
                        </>
                      ) : <p className="hint">Loading…</p>}
                    </div>
                  </>
                ) : <p className="hint">Loading…</p>}
              </div>
            )}

            {cat === 'data' && (
              <div className="settings-cat">
                <div className="tg-section">
                  <h3>Chat history</h3>
                  <p className="hint">Your conversation is saved so you can scroll back through it. Clear it to start
                    fresh or reclaim space — your tasks, notes, and metrics are kept.</p>
                  <div className="setup-actions">
                    <button className="ghost" onClick={() => doClearHistory('30d')}>🧹 Clear older than 30 days</button>
                    <button className="ghost danger" onClick={() => doClearHistory('all')}>🗑 Clear all history</button>
                  </div>
                  {histMsg && <span className="ok">{histMsg}</span>}
                </div>

                <div className="tg-section">
                  <h3>Delete all my data</h3>
                  <p className="hint">Type <code>/requestdeletion</code> in the chat to permanently erase
                    <strong> everything</strong> — tasks, notes, messages, moods, metrics, the lot. I’ll ask you to
                    confirm first; it can’t be undone.</p>
                  {retention && (
                    <>
                      <label className="check">
                        <input type="checkbox" checked={!!retention.enabled} onChange={(e) => toggleRetention(e.target.checked)} />
                        Keep a backup before deleting
                      </label>
                      <p className="hint">When on, a zip export of the user’s data is saved to their folder on the
                        server <em>before</em> it’s erased (for compliance or accidental-deletion recovery). Off means a
                        deletion request keeps no copy. If you turn this on, say so in your privacy policy — what you
                        keep, and for how long.</p>
                      {retentionSaved && <span className="ok">Saved ✓</span>}
                    </>
                  )}
                </div>

                <div className="tg-section">
                  <h3>Backup <span className="sub">— move this install to another server</span></h3>
                  {!instance ? <p className="hint">Loading…</p> : !instance.backupMode ? (
                    <p className="hint">Backups are off. To enable, set <code>BACKUP_MODE=1</code> in the server’s
                      environment and restart. It’s an env flag (not a setting) on purpose: the backup is your entire
                      database in one file, so the capability stays off until you deliberately need it — a migration,
                      or an occasional full backup.</p>
                  ) : (
                    <>
                      <p className="hint">Downloads one zip holding <strong>everything on this server</strong> — the
                        database (all users’ tasks, notes, messages), settings, photos, and retention archives. Restore
                        it by dropping the file onto a fresh install’s setup wizard, or with
                        <code> npm run restore</code> on a headless server. Guard the file like a password vault.</p>
                      {instance.kekSource === 'env' ? (
                        <p className="hint">Stored secrets are encrypted with your env <code>KEK</code> — set the same
                          <code> KEK</code> on the destination server (the backup never contains it).</p>
                      ) : instance.kekFileExists && (
                        <label className="check">
                          <input type="checkbox" checked={includeKek} onChange={(e) => setIncludeKek(e.target.checked)} />
                          Include the encryption key (<code>data.kek</code>) in the zip
                        </label>
                      )}
                      {instance.kekFileExists && !includeKek && instance.kekSource !== 'env' && (
                        <p className="hint">Without the key, stored secrets (API keys, bot tokens, login 2FA) in the
                          backup can’t be read — move <code>data.kek</code> to the new server yourself. Including it
                          makes the zip self-contained (and worth stealing); excluding it is the safer default.</p>
                      )}
                      <div className="setup-actions">
                        <button className="ghost" onClick={doInstanceBackup} disabled={backupBusy}>
                          {backupBusy ? '⏳ Building backup…' : '⬇ Download backup'}
                        </button>
                      </div>
                      {authCfg && authCfg.mode !== 'simple' && (
                        <p className="hint">⚠ Web login is off, so <em>anyone who can reach this server</em> can download
                          this backup while <code>BACKUP_MODE</code> is on. Enable web login (Security) on any networked
                          deployment, and turn the flag back off when you’re done migrating.</p>
                      )}
                    </>
                  )}
                </div>

                {setupMode && (
                  <div className="tg-section">
                    <h3>Settings backup &amp; restore <span className="sub">— setup mode</span></h3>
                    <p className="hint">Move your whole configuration (LLM, Telegram, Slack, weather, metrics) to another
                      server. The backup file contains your keys/tokens — keep it somewhere safe.</p>
                    <div className="setup-actions">
                      <button className="ghost" onClick={doBackup}>⬇ Backup settings</button>
                      <label className="ghost file-btn">⬆ Restore…
                        <input type="file" accept="application/json"
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) doRestore(f); e.target.value = ''; }} />
                      </label>
                    </div>
                    {restoreMsg && <span className="ok">{restoreMsg}</span>}
                  </div>
                )}
              </div>
            )}

            {error && <p className="err">⚠ {error}</p>}
          </div>
        </div>
      </div>
    </div>
    {showAiLog && <AiLog onClose={() => setShowAiLog(false)} />}
    </>
  );
}
