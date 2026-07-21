import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The client build tag — the app version (from the root package.json), baked in at BUILD time so the
// corner of the UI shows which RELEASE the browser is actually running; a stale/cached deploy is then
// visible at a glance. Read from package.json (not git), so it still resolves inside the Docker image
// or a bare deploy tarball, where there's no .git. Bump the version (all three package.json + the lock,
// see private-docs/RELEASE-CHECKLIST) and the corner updates on the next real deploy. Falls back to "?".
function clientBuild() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || '?';
  } catch {
    return '?';
  }
}

// Dev: Vite serves the SPA and proxies /api to the Express server. Prod: `vite build` → web/dist,
// which the Express server serves statically.
export default defineConfig({
  // Relative asset URLs so the built SPA works both at the site root and behind a path
  // prefix (Home Assistant ingress serves it from …/hassio_ingress/<token>/).
  base: './',
  plugins: [react()],
  define: { __CLIENT_BUILD__: JSON.stringify(clientBuild()) },
  server: {
    port: Number(process.env.PORT) || 5173,
    proxy: { '/api': 'http://localhost:8787', '/docs': 'http://localhost:8787' },
  },
  build: { outDir: 'dist' },
});
