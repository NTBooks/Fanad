// Link previews for pasted URLs — the capture-time "what is this page?" fetch. When a task body carries a
// URL, ingest calls fetchLinkPreview() ONCE and stores the result on the task (tasks.link_json); nothing
// here runs on render, on a schedule, or for anyone but the capturing user. Extraction is regex over the
// first ~64KB of HTML (og:title / og:description / <title>) — deliberately no HTML-parser dependency,
// matching the codebase's native-primitives style.
//
// SECURITY (the reason half this file exists): the URL is user input and public demo boxes run this server,
// so the fetch is an SSRF surface. Guards: http/https only, no credentials in the URL, default ports only,
// DNS-resolve the host and refuse if ANY address is loopback/private/link-local/CGN/ULA/metadata, manual
// redirects (each hop re-validated, ≤3), 4s timeout, 64KB body cap, html content-types only. Residual risk,
// documented: a DNS-rebinding TOCTOU remains — native fetch re-resolves after our check and can't pin the
// vetted IP (fixing that means adding undici's custom dispatcher; out of scope). LINK_PREVIEW=off kills the
// whole feature (config.linkPreview.enabled).
//
// fetchLinkPreview NEVER throws: every outcome returns a storable record whose `status` says what happened,
// so the capture path degrades to today's behavior instead of losing the task.
import { lookup } from 'node:dns/promises';

// First http(s) URL in a text. Match greedily to the next whitespace/quote/angle, then shed the trailing
// punctuation a sentence glues on ("read https://x.com/a)." → https://x.com/a) — balanced parens inside a
// path survive because only TRAILING closers are trimmed.
export const URL_RE = /https?:\/\/[^\s<>"]+/i;
const TRAIL_RE = /[)\]}>,.!?;:'"”’]+$/;

// Pull the first URL out of a task body. isBare = the whole (trimmed) text IS that one URL — the case where
// the fetched page title becomes the task title instead of the raw link.
export function extractUrl(text) {
  const s = String(text || '');
  const m = URL_RE.exec(s);
  if (!m) return null;
  const url = m[0].replace(TRAIL_RE, '');
  if (!/^https?:\/\/[^/]/i.test(url)) return null; // scheme with no host ("http://") isn't a link
  return { url, isBare: s.trim() === url };
}

// Minimal HTML entity decode for extracted meta text — named forms that actually appear in titles plus the
// numeric forms. Not a general-purpose decoder; unknown entities pass through verbatim.
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
}
const safeCodePoint = (n) => (Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');

// One meta tag's attribute, tolerant of either attribute order and either quote style.
function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? '') : null;
}

const clean = (s, cap) => {
  const t = decodeEntities(String(s ?? '')).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, cap) : null;
};

// Extract { title, description, site } from an HTML document (possibly truncated at the byte cap — a cut-off
// tail just means fewer meta tags found). Precedence: og:title > twitter:title > <title>;
// og:description > meta[name=description]; og:site_name > the URL's hostname.
export function parseMetaFromHtml(htmlText, url) {
  const s = String(htmlText || '');
  const meta = {};
  for (const m of s.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (attr(tag, 'property') || attr(tag, 'name') || '').toLowerCase();
    if (!key || meta[key] != null) continue; // first occurrence wins (documents repeat og tags in body copies)
    const content = attr(tag, 'content');
    if (content != null) meta[key] = content;
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1];
  let host = null;
  try { host = new URL(url).hostname; } catch { /* caller passed something unparsable — site stays null */ }
  return {
    title: clean(meta['og:title'] ?? meta['twitter:title'] ?? titleTag, 200),
    description: clean(meta['og:description'] ?? meta.description, 400),
    site: clean(meta['og:site_name'], 120) || host,
  };
}

// ── SSRF address guards ──────────────────────────────────────────────────────────────────────────────────

// True when an IP (v4 dotted or v6) must never be fetched: loopback, RFC1918 private, link-local, CGN,
// benchmarking, "this network", IPv6 ULA/link-local/loopback — including the v4-mapped forms cloud metadata
// endpoints hide behind (::ffff:169.254.169.254). Unparsable input is treated as blocked (fail closed).
export function isBlockedAddress(ip) {
  let s = String(ip || '').trim().toLowerCase();
  if (!s) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) s = mapped[1];
  if (s.includes(':')) { // IPv6
    if (s === '::' || s === '::1') return true;
    return s.startsWith('fc') || s.startsWith('fd') // fc00::/7 ULA
      || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb'); // fe80::/10
  }
  const parts = s.split('.');
  if (parts.length !== 4) return true;
  const [a, b] = parts.map(Number);
  if (parts.some((p) => !/^\d+$/.test(p) || Number(p) > 255)) return true;
  return a === 0 || a === 10 || a === 127                    // 0/8, 10/8, 127/8
    || (a === 100 && b >= 64 && b <= 127)                    // 100.64/10 CGN
    || (a === 169 && b === 254)                              // 169.254/16 link-local + cloud metadata
    || (a === 172 && b >= 16 && b <= 31)                     // 172.16/12
    || (a === 192 && b === 168)                              // 192.168/16
    || (a === 198 && (b === 18 || b === 19));                // 198.18/15 benchmarking
}

const LITERAL_IP_RE = /^(\d+\.\d+\.\d+\.\d+|\[?[0-9a-f:]*:[0-9a-f:.]*\]?)$/i;

// Refuse hostnames that resolve anywhere private. Throws (message is internal-only; callers map any throw
// to status:'blocked'). Literal IPs are checked directly; names go through DNS with all:true so ONE private
// A/AAAA record among many is enough to refuse.
export async function assertPublicHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error(`blocked host ${host}`);
  }
  if (LITERAL_IP_RE.test(host)) {
    if (isBlockedAddress(host)) throw new Error(`blocked address ${host}`);
    return;
  }
  const addrs = await lookup(host, { all: true, verbatim: true });
  if (!addrs.length || addrs.some((a) => isBlockedAddress(a.address))) {
    throw new Error(`blocked resolution for ${host}`);
  }
}

// Scheme/shape gate for the URL itself (and every redirect hop). Throws on anything but plain http(s) on
// its default port with no embedded credentials.
function assertFetchableUrl(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`blocked scheme ${u.protocol}`);
  if (u.username || u.password) throw new Error('blocked credentials in URL');
  if (u.port && u.port !== (u.protocol === 'https:' ? '443' : '80')) throw new Error(`blocked port ${u.port}`);
}

// ── the fetch ────────────────────────────────────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (compatible; Fanad-LinkPreview/1.0)';

// Read at most maxBytes from a response body, then cancel the stream. A truncated document still parses —
// the interesting meta tags live in <head>.
async function readCapped(res, maxBytes) {
  const reader = res.body?.getReader?.();
  if (!reader) { // test stubs and tiny responses may not expose a stream
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.subarray(0, maxBytes);
  }
  const chunks = []; let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); total += value.length;
  }
  reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, out.length - off);
    out.set(c.subarray(0, take), off); off += take;
    if (off >= out.length) break;
  }
  return out;
}

// Bytes → text: honor a declared charset (Content-Type, then <meta charset>) when TextDecoder knows it,
// fall back to permissive UTF-8.
function decodeBody(bytes, contentType) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const declared = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1]
    || /<meta[^>]+charset=["']?([\w-]+)/i.exec(utf8)?.[1];
  if (declared && !/^utf-?8$/i.test(declared)) {
    try { return new TextDecoder(declared).decode(bytes); } catch { /* unknown label → keep utf-8 */ }
  }
  return utf8;
}

// Fetch a page's preview metadata. Never throws — the record's `status` reports the outcome:
//   'ok'      fetched + parsed (title/description may still be null if the page declares none)
//   'blocked' SSRF guard refused the URL or one of its redirect hops
//   'timeout' the site didn't answer in time
//   'error'   anything else (network failure, non-2xx, non-HTML, redirect loop)
export async function fetchLinkPreview(url, { timeoutMs = 4000, maxBytes = 65536, maxRedirects = 3 } = {}) {
  const base = { url, finalUrl: null, title: null, description: null, site: null, fetchedAt: Date.now() };
  let current = url;
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const u = new URL(current);
      assertFetchableUrl(u);
      await assertPublicHost(u.hostname);
      const res = await globalThis.fetch(u.href, {
        redirect: 'manual',
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        res.body?.cancel?.().catch?.(() => {});
        if (!loc || hop === maxRedirects) return { ...base, status: 'error' };
        current = new URL(loc, u.href).href; // relative Location resolves against the hop we just fetched
        continue;
      }
      if (!res.ok) return { ...base, status: 'error' };
      const contentType = res.headers.get('content-type') || '';
      if (!/text\/html|application\/xhtml/i.test(contentType)) return { ...base, status: 'error' };
      const bytes = await readCapped(res, maxBytes);
      const parsed = parseMetaFromHtml(decodeBody(bytes, contentType), u.href);
      return { ...base, finalUrl: u.href, ...parsed, status: 'ok' };
    }
    return { ...base, status: 'error' }; // unreachable, but keeps the loop honest
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { ...base, status: 'timeout' };
    if (/^blocked/.test(e?.message || '')) return { ...base, status: 'blocked' };
    return { ...base, status: 'error' };
  }
}
