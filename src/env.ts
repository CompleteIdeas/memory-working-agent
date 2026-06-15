import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Load the .env into process.env without a dependency. Honors MWA_ENV_PATH (so the
 *  Docker/NAS image, which stores secrets on the /data volume, reads the SAME file the
 *  setup screen writes); falls back to repo-root .env in dev. Idempotent. */
let loaded = false;
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  try {
    const text = readFileSync(process.env.MWA_ENV_PATH ?? resolve(process.cwd(), '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 0) continue;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    /* no .env — rely on real env vars */
  }
}

export function requireEnv(name: string): string {
  loadEnv();
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}
