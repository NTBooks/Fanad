// Pure-Node networking for the terminal client — no Ink imports. The fetch wrapper mirrors
// web/src/api.js, except the credential is the CLI claim token sent as `Authorization: Bearer` on every
// request (no cookies, no login flow — the token IS the identity, resolved server-side by
// cliTokenMiddleware). A 401/403 throws with err.status so the app can exit with the mint-a-new-one hint.
export function makeClient({ server, token }) {
  const base = String(server).replace(/\/+$/, '');

  async function req(path, opts = {}) {
    let r;
    try {
      r = await fetch(base + path, {
        ...opts,
        headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      const e = new Error(`Cannot reach ${base} (${err.cause?.code || err.message})`);
      e.network = true;
      throw e;
    }
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      const err = new Error(body.error || `HTTP ${r.status}`);
      err.status = r.status;
      err.body = body;
      throw err;
    }
    return r.json();
  }
  const post = (path, data) =>
    req(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });

  return {
    base,
    token,
    sendChat: (text) => post('/api/chat', { text }),
    sendAction: (data) => post('/api/action', { data }),
    getHistory: (before = null, limit = 30) =>
      req(`/api/chat/history?limit=${limit}${before != null ? `&before=${before}` : ''}`),
    getNewMessages: (after = 0) => req(`/api/chat/new?after=${after}`),
    getWakeups: () => req('/api/wakeups'),
    heartbeat: () => req('/api/heartbeat'),
    getConfig: () => req('/api/config'),
  };
}
