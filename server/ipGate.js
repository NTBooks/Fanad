// Optional web IP allowlist (auth §9): an independent gate in front of the WHOLE web surface (API +
// static), applied whenever the list is non-empty — in either auth mode. It exists because Telegram
// handles can't vouch for local web users: on a LAN box the operator may simply pin which addresses may
// talk to the web UI at all. Matching is Node's net.BlockList (exact IPs + CIDR subnets, IPv4/IPv6 —
// no hand-rolled parsing). Two hard exemptions so a bad list can't brick the box:
//  · loopback always passes — you can never lock yourself out of localhost;
//  · /api/health always passes — it's the platform healthcheck (Coolify probes from a docker bridge IP;
//    gating it would mark every deploy unhealthy). It serves liveness booleans only (see index.js).
// NOTE: behind a reverse proxy req.ip is the proxy unless TRUST_PROXY is set (config.js).
import { BlockList, isIP } from 'node:net';
import { getAuthConfig } from './settings.js';

// Express hands IPv4 addresses through the IPv6 stack as '::ffff:a.b.c.d' — compare in dotted-quad form.
export function normalizeIp(ip) {
  const v = String(ip || '').trim();
  if (v.toLowerCase().startsWith('::ffff:') && isIP(v.slice(7)) === 4) return v.slice(7);
  return v;
}

export function isLoopback(ip) {
  const v = normalizeIp(ip);
  return v === '::1' || v.startsWith('127.');
}

// Build a BlockList from the stored entries ('1.2.3.4' or '10.0.0.0/8'). Returns { blockList, errors };
// the settings route validates with this BEFORE saving so a typo is rejected with its offending entry
// named, never silently dropped into the live gate.
export function parseAllowlist(entries) {
  const blockList = new BlockList();
  const errors = [];
  for (const raw of entries || []) {
    const e = String(raw || '').trim();
    if (!e) continue;
    const m = e.match(/^(.*)\/(\d{1,3})$/);
    try {
      if (m) {
        const fam = isIP(m[1]);
        const prefix = Number(m[2]);
        if (!fam || prefix > (fam === 4 ? 32 : 128)) { errors.push(e); continue; }
        blockList.addSubnet(m[1], prefix, fam === 6 ? 'ipv6' : 'ipv4');
      } else {
        const fam = isIP(e);
        if (!fam) { errors.push(e); continue; }
        blockList.addAddress(e, fam === 6 ? 'ipv6' : 'ipv4');
      }
    } catch {
      errors.push(e);
    }
  }
  return { blockList, errors };
}

// Would `ip` pass a gate configured with `entries`? Loopback always passes. Exposed for the settings
// route's save-time "would this lock YOU out?" check, sharing the exact matching the live gate uses.
export function ipAllowedBy(ip, entries, blockList = null) {
  const v = normalizeIp(ip);
  if (isLoopback(v)) return true;
  const fam = isIP(v);
  if (!fam) return false;
  const bl = blockList || parseAllowlist(entries).blockList;
  return bl.check(v, fam === 6 ? 'ipv6' : 'ipv4');
}

// The live gate caches its parsed BlockList keyed on the entries ARRAY IDENTITY — settings.js caches the
// auth config object, so the reference only changes when the allowlist is actually rewritten.
let cachedEntries = null;
let cachedBlockList = null;

export function ipGate(req, res, next) {
  const { ipAllowlist } = getAuthConfig();
  if (!ipAllowlist.length) return next();
  if (req.path === '/api/health') return next();
  if (ipAllowlist !== cachedEntries) {
    cachedBlockList = parseAllowlist(ipAllowlist).blockList;
    cachedEntries = ipAllowlist;
  }
  if (ipAllowedBy(req.ip, ipAllowlist, cachedBlockList)) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'This address is not on the web allowlist.' });
  return res.status(403).type('text/plain').send('403 — this address is not on the web allowlist.');
}
