#!/usr/bin/env node
// Restore a Fanad instance backup (the zip from Settings → Data → Backup) on a box that never runs the
// setup wizard — a Coolify/Docker deploy, or any headless server. Same code path as the wizard's
// drag-and-drop; run it while the app is STOPPED (nothing may hold the DB open), then start the app:
//
//   npm run restore -- /path/to/fanad-backup-20260718-120000.zip
//   (or: node server/scripts/restore-backup.js <backup.zip>)
//
// Env is respected the same way the server resolves it: DATA_DIR / PERSIST_DATA decide where the data
// lands, KEK_FILE where an included key is written. Existing state is never destroyed — a non-empty data
// dir (and any existing key file) is renamed aside with a timestamp.
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateInstancePackage, restoreInstancePackage } from '../instancePackage.js';
import { resolveDataDir, resolveKekFile } from '../dataDirPath.js';

function main() {
  const zipPath = process.argv[2];
  if (!zipPath) {
    console.error('Usage: node server/scripts/restore-backup.js <backup.zip>');
    console.error('Stop the Fanad server first — a restore must not race a live database.');
    process.exit(2);
  }
  if (!existsSync(zipPath)) {
    console.error(`No such file: ${zipPath}`);
    process.exit(2);
  }

  let sum;
  try {
    const v = validateInstancePackage(readFileSync(zipPath));
    const dataDir = resolveDataDir();
    sum = restoreInstancePackage({ ...v, dataDir, kekFile: resolveKekFile(dataDir) });
    console.log(`Restored ${sum.fileCount} files into ${dataDir}`);
  } catch (err) {
    console.error(`Restore failed: ${err.message}`);
    process.exit(1);
  }
  if (sum.previousDataDir) console.log(`The previous data dir was kept at: ${sum.previousDataDir}`);
  if (sum.kekIncluded) {
    console.log('The encryption key rode along in the backup and was installed.');
  } else if (sum.kekSource === 'env') {
    console.log('NOTE: this backup’s stored secrets are encrypted with the OLD server’s env KEK.');
    console.log('Set the same KEK in this environment before starting, or those secrets (API keys, bot tokens, login 2FA) will be unreadable.');
  } else if (sum.kekSource === 'temp') {
    console.log('NOTE: the backup did not include the old server’s key file. Copy its "data.kek" to sit beside the data dir here,');
    console.log('or stored secrets (API keys, bot tokens, login 2FA) will be unreadable.');
  }
  console.log('Done. Start Fanad normally; an older database is migrated forward on first boot.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
