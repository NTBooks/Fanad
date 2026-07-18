#!/usr/bin/env node
// Fanad CLI — the cross-platform, technical-user counterpart of installer.bat + run.bat.
//
//   npx github:NTBooks/Fanad          fresh install: copy → setup wizard → deps → build → start
//   npx github:NTBooks/Fanad setup    same, but stop before starting the server
//   npx fanad [setup|start]           inside a checkout: wizard if needed, preflight, start
//
// Zero npm dependencies — npx runs this straight from its cache before any install, and the
// setup wizard it hands off to (server/scripts/setup-server.js) has the same constraint.
import { existsSync, readFileSync, readdirSync, cpSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export function isFanadRoot(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === 'fanad'; }
  catch { return false; }
}

// Walk up from `from` looking for a fanad package root, so the CLI works from any subdirectory.
export function findFanadRoot(from) {
  let dir = resolve(from);
  for (;;) {
    if (isFanadRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// A fresh install must never inherit another box's runtime state: no DB, no secrets, no deps.
// (The npx tarball excludes most of these already via .gitignore — this is the belt to that brace.)
export const COPY_EXCLUDE = new Set(['node_modules', '.git', '.env', 'data', 'data.kek', '.claude']);

export function copyTree(src, dest) {
  cpSync(src, dest, { recursive: true, filter: (p) => !COPY_EXCLUDE.has(basename(p)) });
}

// npm is npm.cmd on Windows, which node refuses to spawn without a shell (CVE-2024-27980 fix);
// node itself is a real executable, so spawn it directly to dodge shell quoting on spaced paths.
const runNpm = (args, cwd) => spawnSync('npm', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' }).status === 0;
const runNode = (args, cwd) => spawnSync(process.execPath, args, { cwd, stdio: 'inherit' }).status === 0;

const step = (msg) => console.log(`\n▸ ${msg}`);

// Wizard if no .env yet. The wizard exits 0 once the form is saved; treat anything else
// (Ctrl+C, port failure) as "user bailed" and stop the chain.
function ensureEnv(root) {
  if (existsSync(join(root, '.env'))) return true;
  step('No .env yet — starting the setup wizard (finish the form in your browser)...');
  return runNode([join(root, 'server', 'scripts', 'setup-server.js')], root);
}

// run.bat's preflight, cross-platform: deps present, web UI built.
function preflight(root) {
  if (!existsSync(join(root, 'node_modules', 'express', 'package.json'))) {
    step('Installing dependencies (this can take a few minutes)...');
    if (!runNpm(['install'], root)) return false;
  }
  if (!existsSync(join(root, 'web', 'dist', 'index.html'))) {
    step('Building the web UI...');
    if (!runNpm(['run', 'build'], root)) return false;
  }
  return true;
}

function start(root) {
  const port = (readFileSync(join(root, '.env'), 'utf8').match(/^PORT=(\d+)/m) || [])[1] || 8787;
  step(`Starting Fanad on http://localhost:${port}  (Ctrl+C to stop)`);
  return runNode(['--env-file-if-exists=.env', join(root, 'server', 'index.js')], root);
}

const USAGE = `Fanad CLI

Fresh install (from anywhere):
  npx github:NTBooks/Fanad             copy → setup wizard → deps → build → start
  npx github:NTBooks/Fanad setup       same, but stop before starting the server
  --dir <path>                         where the install goes (default ./fanad)

Inside a Fanad folder (a git clone or a bootstrap):
  npx fanad                            setup wizard if .env is missing, then start
  npx fanad setup                      run the setup wizard only
  npx fanad start                      skip the wizard; preflight + start

Terminal chat client (connects to a running Fanad server):
  fanad <server> <token>               connect, e.g. fanad http://localhost:8787 fnd1_…
  fanad <server>                       reconnect with the token cached from a previous run
  fanad token [--user <id>] [--label <text>] [--ttl <days>] | --list | --revoke <id>
                                       mint / manage claim tokens (run on the server box)

Windows double-click equivalents: installer.bat and run.bat.`;

// Client-mode heuristic: the first positional names a server when it's a URL or a host[:port] — never a
// bare word (those are subcommands). Deliberately permissive about hosts ("fanad myserver:8787 …" works)
// while anything unrecognized still falls through to the unknown-command error with USAGE.
const RESERVED_CMDS = ['', 'setup', 'start', 'token', 'help'];
function looksLikeServer(s) {
  if (!s || RESERVED_CMDS.includes(s)) return false;
  return /^https?:\/\//i.test(s) || /^localhost(:\d+)?$/i.test(s)
    || /^[\w-][\w.-]*:\d+$/.test(s) || /^[\w-][\w.-]*\.[a-z]{2,}(:\d+)?$/i.test(s);
}

// Preflight for client mode: workspace deps present + the bundle built (the same pattern preflight()
// uses for web/dist). npx installs nothing by itself, so a fresh checkout builds here on first connect.
function preflightCli(root) {
  if (!existsSync(join(root, 'node_modules', 'ink', 'package.json'))) {
    step('Installing dependencies (first run — this can take a few minutes)...');
    if (!runNpm(['install'], root)) return false;
  }
  if (!existsSync(join(root, 'cli', 'dist', 'index.js'))) {
    step('Building the terminal client...');
    if (!runNpm(['--workspace', 'cli', 'run', 'build'], root)) return false;
  }
  return true;
}

function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) {
    console.error(`Fanad needs Node.js 24 or newer; you have ${process.versions.node}. Update at https://nodejs.org/`);
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const dirFlag = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : undefined;
  const cmd = args.find((a) => !a.startsWith('--') && a !== dirFlag) || '';
  if (['help', '-h', '--help'].includes(cmd || args[0] || '')) { console.log(USAGE); return; }

  // Where "this install" is for the subcommands below: the checkout the shell is standing in, or —
  // when invoked from anywhere else through a global shim (`npm link` / a global install) — the
  // package this very file belongs to. That second leg is what makes `fanad <server> <token>` work
  // from any directory, cloudflared-style, instead of demanding a cd into the repo first.
  const installRoot = () => findFanadRoot(process.cwd()) || (isFanadRoot(pkgRoot) ? pkgRoot : null);

  // `fanad token …` — mint/manage claim tokens. Opens the server DB, so it needs an install;
  // everything after "token" passes straight through to the script (it owns the flag parsing).
  if (cmd === 'token') {
    const root = installRoot();
    if (!root) { console.error('`fanad token` opens the server database — run it inside a Fanad install (or link one: npm link).'); process.exit(1); }
    process.exit(runNode(['--env-file-if-exists=.env', join(root, 'server', 'scripts', 'mint-cli-token.js'),
      ...args.slice(args.indexOf('token') + 1)], root) ? 0 : 1);
  }

  // `fanad <server> [token]` — the terminal chat client (cloudflared-style connect). Positional args:
  // a server URL/host, then optionally the claim token (omit to reuse the one cached by a prior run).
  if (looksLikeServer(cmd)) {
    const root = installRoot();
    if (!root) { console.error('The terminal client needs a Fanad checkout — clone the repo (or npx github:NTBooks/Fanad to install), then run this inside it (or link it globally: npm link).'); process.exit(1); }
    const positionals = args.filter((a) => !a.startsWith('--') && a !== dirFlag);
    const token = positionals[1];
    if (!preflightCli(root)) process.exit(1);
    process.exit(runNode([join(root, 'cli', 'dist', 'index.js'), '--server', cmd,
      ...(token ? ['--token', token] : [])], root) ? 0 : 1);
  }

  if (!['', 'setup', 'start'].includes(cmd)) {
    console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
    process.exit(1);
  }

  let root = findFanadRoot(process.cwd());
  if (!root) {
    // Bootstrap mode: running from the npx cache with no checkout in sight. npm already downloaded
    // the whole repo — copy it into a real folder instead of requiring git.
    const target = resolve(process.cwd(), dirFlag || 'fanad');
    if (isFanadRoot(target)) {
      console.log(`Found an existing Fanad install at ${target} — using it.`);
    } else if (existsSync(target) && readdirSync(target).length > 0) {
      console.error(`${target} already exists and is not empty. Pick another spot with --dir <path>.`);
      process.exit(1);
    } else {
      step(`Installing Fanad into ${target} ...`);
      copyTree(pkgRoot, target);
      console.log('  (a plain copy, no git history — `git clone https://github.com/NTBooks/Fanad.git` if you want that)');
    }
    root = target;
  }

  if (cmd === 'setup') {
    // Explicit setup: run the wizard (it refuses by itself if .env exists), and in a fresh
    // bootstrap also leave the install ready to start.
    const ok = runNode([join(root, 'server', 'scripts', 'setup-server.js')], root) && preflight(root);
    if (!ok) process.exit(1);
    console.log(`\nReady. Start Fanad with: npx fanad start   (from ${root})`);
    return;
  }
  if (cmd === 'start' && !existsSync(join(root, '.env'))) {
    console.error('No .env found — run `npx fanad setup` first.');
    process.exit(1);
  }
  if (!(ensureEnv(root) && preflight(root) && start(root))) process.exit(1);
}

// Real-path both sides: npm's bin shim reaches this file through a symlink on POSIX.
const isMain = process.argv[1] && (() => {
  try { return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; }
  catch { return false; }
})();
if (isMain) main();
