/**
 * Builds the service worker (v2 build, slices P1/P2) after Vite has written the app: lists every file in the output
 * (the hashed assets, index.html, manifests, icons), hashes them, and bundles src/pwa/sw.ts into `sw.js` with that
 * list. So sw.js changes byte-for-byte whenever any file of the build changes, which is what makes the browser install
 * a new worker (it then waits for the page's "Reload"). Also writes `pwa-build.json` (the same facts, for tests and
 * support; not precached).
 */
import type { Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildInfo, PrecacheEntry } from './src/pwa/sw-logic';

/** Not precached: the worker itself, its facts, source maps, and the dev fixtures' files. */
const SKIP = (rel: string) => rel === 'sw.js' || rel === 'pwa-build.json' || rel.endsWith('.map') || rel.startsWith('__');
/** Names that carry their content hash (Vite's assets/name-HASH.ext). */
const HASHED = (rel: string) => /^assets\/.+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(rel);

function walk(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, root));
    else out.push(relative(root, p).split(sep).join('/'));
  }
  return out.sort();
}

/** The entry script index.html loads ("assets/index-AbC.js"). */
export function entryOf(indexHtml: string): string {
  const m = /<script[^>]*type="module"[^>]*src="(?:\.\/|\/)?([^"]+)"/.exec(indexHtml);
  if (!m) throw new Error('vite-pwa: index.html has no module entry script');
  return m[1];
}

export function buildInfo(outDir: string, version: string): BuildInfo {
  const files: PrecacheEntry[] = [];
  const all = createHash('sha256').update(version);
  for (const rel of walk(outDir)) {
    if (SKIP(rel)) continue;
    const h = createHash('sha256').update(readFileSync(join(outDir, rel))).digest('hex').slice(0, 16);
    files.push({ url: rel, rev: HASHED(rel) ? null : h });
    all.update(`${rel}:${h}\n`);
  }
  if (!files.some((f) => f.url === 'index.html')) throw new Error('vite-pwa: no index.html in the build');
  return { buildId: all.digest('hex').slice(0, 12), entry: entryOf(readFileSync(join(outDir, 'index.html'), 'utf8')), version, files };
}

export function mwaPwa(opts: { version: string }): Plugin {
  let outDir = '';
  return {
    name: 'mwa-pwa',
    apply: 'build',
    configResolved(c) { outDir = c.build.outDir; },
    async closeBundle() {
      const info = buildInfo(outDir, opts.version);
      const { build } = await import('esbuild');
      const r = await build({
        entryPoints: [fileURLToPath(new URL('./src/pwa/sw.ts', import.meta.url))],
        bundle: true, format: 'iife', target: 'es2020', minify: true, write: false, legalComments: 'none',
        define: { __MWA_BUILD__: JSON.stringify(info) },
      });
      writeFileSync(join(outDir, 'sw.js'), `/* MWA service worker · build ${info.buildId} · web ${info.version} */\n${r.outputFiles[0].text}`);
      writeFileSync(join(outDir, 'pwa-build.json'), JSON.stringify({ buildId: info.buildId, entry: info.entry, version: info.version, files: info.files.length }, null, 2));
    },
  };
}
