// Entry for the terminal client. bin/fanad.js spawns this as `node cli/dist/index.js --server <url>
// [--token <fnd1_…>]`; the token may also come from FANAD_TOKEN or the per-server config cache (which
// is how `fanad <server>` reconnects without putting the credential back into shell history).
//
// The preflight heartbeat runs BEFORE the alternate screen: a bad address or dead token errors like a
// normal CLI tool — no screen flash, no mangled terminal.
import { render } from 'ink';
import { makeClient } from './client.js';
import { loadConfig, serverSlot, saveServerSlot } from './config.js';
import { enterAltScreen, exitAltScreen, installExitGuard } from './fullscreen.js';
import App from './App.jsx';
import PlainApp from './PlainApp.jsx';

const TOKEN_DEAD_MSG = 'Token rejected, expired, or revoked — mint a new one on the server with `fanad token`.';

const args = process.argv.slice(2);
const flagOf = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };

const cfg = loadConfig();
let server = flagOf('server') || process.env.FANAD_SERVER || cfg.lastServer;
if (!server) {
  console.error('Usage: fanad <server> <token>    e.g. fanad http://localhost:8787 fnd1_…');
  process.exit(1);
}
if (!/^https?:\/\//i.test(server)) server = `http://${server}`;
server = server.replace(/\/+$/, '');

const token = flagOf('token') || process.env.FANAD_TOKEN || serverSlot(cfg, server).token;
if (!token) {
  console.error(`No cached token for ${server} — connect once with:  fanad ${server} <token>`);
  console.error('(Mint one on the server box:  fanad token)');
  process.exit(1);
}

const client = makeClient({ server, token });
try {
  await client.heartbeat();
} catch (err) {
  console.error(err.status === 401 || err.status === 403 ? TOKEN_DEAD_MSG : err.message);
  process.exit(1);
}
saveServerSlot(server, { token }); // the connect worked — cache so `fanad <server>` reconnects

// --plain (or a non-TTY stdout, where the alt-screen would be meaningless bytes in a pipe): append-only
// rendering with native scrollback. Otherwise: the full-screen app owns the window.
const plain = args.includes('--plain') || process.stdout.isTTY !== true;

installExitGuard();
let fatalMsg = null;
if (!plain) enterAltScreen();
const Root = plain ? PlainApp : App;
const app = render(
  <Root client={client} server={server} onFatal={(m) => { fatalMsg = m; }} />,
  { exitOnCtrlC: true },
);
await app.waitUntilExit().catch(() => {});
exitAltScreen();
if (fatalMsg) { console.error(fatalMsg); process.exit(1); }
