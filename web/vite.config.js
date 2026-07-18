import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The client build tag ("<schema>.<commits since that migration landed>") baked in at BUILD time —
// deliberately not fetched from /api/config: the point is cache-busting truth, the corner shows what
// bundle the browser actually runs, so a stale deploy is visible at a glance. Derived, never stored:
// schema = the highest "// vN -> vN+1" marker in server/db.js (same markers migrations.test.js leans
// on); build = git commits since the commit that introduced that marker (so it reads X.0 right after
// a migration ships and counts up until the next one). Falls back to "?" without git — e.g. a bare
// deploy tarball — where the schema half still renders.
function clientBuild() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const src = readFileSync(join(root, 'server', 'db.js'), 'utf8');
    const marks = [...src.matchAll(/\/\/ v(\d+) -> v(\d+)/g)].map((m) => Number(m[2]));
    if (!marks.length) return '?';
    const schema = Math.max(...marks);
    try {
      const opts = { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] };
      const mig = execFileSync('git',
        ['log', '--format=%H', '-S', `v${schema - 1} -> v${schema}`, '-1', '--', 'server/db.js'],
        opts).toString().trim();
      const count = mig ? execFileSync('git', ['rev-list', '--count', `${mig}..HEAD`], opts).toString().trim() : '?';
      return `${schema}.${count}`;
    } catch {
      return `${schema}.?`;
    }
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
