// bin/fanad.js (the npx entrypoint): root detection, the bootstrap copy's exclusion contract,
// and the bin wiring itself. Importing this module must NOT run main() — that guard is what
// lets these tests exist. Like the setup wizard it hands off to, the CLI is zero-dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const { isFanadRoot, findFanadRoot, copyTree, COPY_EXCLUDE } = await import('../bin/fanad.js');

test('isFanadRoot: real repo root yes, random dir no', () => {
  assert.equal(isFanadRoot(repoRoot), true);
  assert.equal(isFanadRoot(tmpdir()), false);
});

test('findFanadRoot walks up from a subdirectory; returns null outside any checkout', () => {
  assert.equal(findFanadRoot(join(repoRoot, 'server', 'scripts')), repoRoot);
  assert.equal(findFanadRoot(mkdtempSync(join(tmpdir(), 'fanad-cli-'))), null);
});

test('copyTree carries the source but never runtime state (deps, git, secrets, DB, key)', () => {
  const src = mkdtempSync(join(tmpdir(), 'fanad-cli-src-'));
  writeFileSync(join(src, 'package.json'), '{"name":"fanad"}');
  mkdirSync(join(src, 'server'));
  writeFileSync(join(src, 'server', 'index.js'), '// app');
  for (const bad of COPY_EXCLUDE) {
    mkdirSync(join(src, bad), { recursive: true });
    writeFileSync(join(src, bad, 'leak.txt'), 'must not travel');
  }
  const dest = join(mkdtempSync(join(tmpdir(), 'fanad-cli-dest-')), 'fanad');
  copyTree(src, dest);
  assert.equal(readFileSync(join(dest, 'server', 'index.js'), 'utf8'), '// app');
  for (const bad of COPY_EXCLUDE) assert.equal(existsSync(join(dest, bad)), false, `${bad} leaked`);
});

test('package.json bin points at an existing file so npx actually resolves', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.bin.fanad, 'bin/fanad.js');
  assert.equal(existsSync(join(repoRoot, pkg.bin.fanad)), true);
  assert.match(readFileSync(join(repoRoot, pkg.bin.fanad), 'utf8'), /^#!\/usr\/bin\/env node/);
});
