import { useState, useEffect } from 'react';
import * as api from './api.js';

// Full-screen login for auth mode 'simple' — rendered by App INSTEAD of the chat when the server says the
// session isn't authenticated. Three views: sign-in (username + password + 6-digit code, one submit),
// register (only when the owner opened registration), and the TOTP-enrollment step (QR + verify) that
// bridges both register and a login that finds 2FA unfinished. Success reloads the page — the same
// "reload is the reset" idiom as the user/notebook switchers.
export default function Login({ status }) {
  // Deep link from the /demo "create an account" link (href="/?signup"): boot straight on the register
  // view when the owner has registration open. The needsTotp effect below still wins for downgraded demo
  // accounts; the ?signup param is stripped once so a later reload doesn't re-force register.
  const wantsRegister = !!status?.allowRegistration && new URLSearchParams(window.location.search).has('signup');
  const [view, setView] = useState(wantsRegister ? 'register' : 'login'); // 'login' | 'register' | 'enroll'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [enroll, setEnroll] = useState(null); // { qrDataUrl, otpauthUri } from register / resumed login
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const secretFromUri = (uri) => { try { return new URL(uri).searchParams.get('secret') || ''; } catch { return ''; } };

  // A TOTP-less demo account whose session was downgraded because the owner turned demo mode off
  // (status.needsTotp) — fetch a fresh enrollment QR and drop the user straight on the 2FA step so they can
  // secure the account they've been using. Runs once when the login screen boots in that state.
  useEffect(() => {
    if (!status?.needsTotp) return;
    setBusy(true);
    api.totpSetup()
      .then((r) => { setEnroll(r); setView('enroll'); })
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false));
  }, [status?.needsTotp]);

  // Strip the ?signup deep-link marker so a later reload (or "Back to sign in") doesn't snap the visitor
  // back to the register view — the initial view above already consumed it.
  useEffect(() => {
    if (wantsRegister) window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  }, [wantsRegister]);

  async function doLogin(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await api.login({ username, password, totp: code });
      if (res.pendingTotp) {
        // Right password, 2FA never finished (abandoned registration) — resume enrollment with a fresh QR.
        setEnroll(res);
        setCode('');
        setView('enroll');
      } else {
        window.location.reload();
      }
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function doRegister(e) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) { setError('Passwords don’t match.'); return; }
    setBusy(true);
    try {
      const res = await api.register({ username, password });
      if (res.pendingTotp) {
        // Normal registration (demo mode off) → finish 2FA enrollment before the account is usable.
        setEnroll(res);
        setCode('');
        setView('enroll');
      } else {
        // Demo mode → the server already opened an active session (no authenticator). Straight into the app.
        window.location.reload();
      }
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function doVerify(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.totpVerify(code);
      window.location.reload();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  const switchView = (v) => { setView(v); setError(null); setPassword(''); setConfirm(''); setCode(''); };

  return (
    <div className="login-wrap">
      <div className="settings login-card">
        <div className="settings-head"><h2>🔐 Fanad</h2></div>

        {view === 'login' && (
          <form onSubmit={doLogin}>
            <p className="hint">Sign in to continue.</p>
            <label>Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
            </label>
            <label>Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
            <label>2FA code <span className="sub">— the 6 digits from your authenticator app</span>
              <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" />
            </label>
            {error && <p className="err">⚠ {error}</p>}
            <div className="settings-foot">
              {status?.allowRegistration && (
                <button type="button" className="ghost" onClick={() => switchView('register')}>Create an account</button>
              )}
              <button type="submit" className="primary" disabled={busy || !username || !password}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </div>
          </form>
        )}

        {view === 'register' && (
          <form onSubmit={doRegister}>
            <p className="hint">Pick a username and password.{status?.demoMode
              ? ' You’ll be signed straight into the demo — no authenticator app needed.'
              : ' You’ll scan a QR code with an authenticator app (Google Authenticator, Authy, 1Password…) next — 2FA is required here.'}</p>
            <label>Username <span className="sub">— 3–32 characters: letters, digits, . _ -</span>
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
            </label>
            <label>Password <span className="sub">— at least 8 characters</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </label>
            <label>Confirm password
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
            </label>
            {error && <p className="err">⚠ {error}</p>}
            <div className="settings-foot">
              <button type="button" className="ghost" onClick={() => switchView('login')}>Back to sign in</button>
              <button type="submit" className="primary" disabled={busy || !username || !password}>
                {busy ? 'Creating…' : 'Continue'}
              </button>
            </div>
          </form>
        )}

        {view === 'enroll' && enroll && (
          <form onSubmit={doVerify}>
            <p className="hint">Scan this QR code with your authenticator app, then enter the 6-digit code it
              shows to finish setting up your account.</p>
            <div className="qr-box">
              <img src={enroll.qrDataUrl} alt="TOTP enrollment QR code" />
              <span className="sub">Can’t scan? Enter this key manually: <code>{secretFromUri(enroll.otpauthUri)}</code></span>
            </div>
            <label>6-digit code
              <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" autoFocus />
            </label>
            {error && <p className="err">⚠ {error}</p>}
            <div className="settings-foot">
              <button type="button" className="ghost" onClick={() => api.logout().finally(() => window.location.reload())}>Sign out</button>
              <button type="submit" className="primary" disabled={busy || code.replace(/\D/g, '').length < 6}>
                {busy ? 'Checking…' : 'Verify & finish'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
