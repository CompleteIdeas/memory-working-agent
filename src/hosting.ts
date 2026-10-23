/**
 * Where MWA is running: on the person's own computer, or on a server (Railway, Docker, Azure Container Apps,
 * Cloud Run). The settings page said "This computer · private" and "It stays on your machine" on the Railway
 * deploy (2026-10-23 review), where "this computer" is a disk on Railway's servers. MWA_HOSTED=1/0 overrides.
 */
import { existsSync } from 'node:fs';

export function isHosted(env: NodeJS.ProcessEnv = process.env, dockerenv = () => existsSync('/.dockerenv')): boolean {
  const o = String(env.MWA_HOSTED ?? '').trim().toLowerCase();
  if (/^(1|true|yes|on)$/.test(o)) return true;
  if (/^(0|false|no|off)$/.test(o)) return false;
  if (env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID) return true;
  if (env.CONTAINER_APP_NAME || env.K_SERVICE || env.WEBSITE_SITE_NAME) return true; // Azure Container Apps, Cloud Run, App Service
  return dockerenv();
}

/** The name of the place a hosted deploy runs, for the page ("Railway", else "your server"). */
export function hostName(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID) return 'Railway';
  if (env.CONTAINER_APP_NAME) return 'Azure';
  return 'your server';
}
