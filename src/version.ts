import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * MWA's own version, read from package.json at runtime so anything that reports
 * it (the MCP client handshake, future /api/status, banners) always matches the
 * shipped build instead of a hand-maintained literal that drifts.
 */
function resolveVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/version.ts (dev) and dist/version.js (build) both sit one level below root.
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const v = JSON.parse(readFileSync(join(here, rel), 'utf8')).version;
      if (typeof v === 'string' && v) return v;
    } catch {
      /* try the next candidate path */
    }
  }
  return '0.0.0';
}

export const VERSION: string = resolveVersion();
