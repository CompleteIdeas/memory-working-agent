/**
 * The /api/v1 route table (v2 build). Each area adds its routes here as its slice lands; the OpenAPI contract
 * (api/openapi.yaml) lists the same operations and tests/api-contract.test.ts holds the two together.
 */
import type { IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createV1, API_VERSION, MIN_CLIENT, type Route, type RouterDeps } from './router.js';
import { jobRoutes } from './routes/jobs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
function serverVersion(): string {
  for (const p of [join(HERE, '../../package.json'), join(HERE, '../package.json')]) {
    try { return String(JSON.parse(readFileSync(p, 'utf8')).version ?? '0.0.0'); } catch { /* next */ }
  }
  return '0.0.0';
}
const VERSION = serverVersion();

/** True when the request reached us over HTTPS (directly or via a proxy such as `tailscale serve`), or from the
 *  same machine. Install, offline storage and push need a secure context; a phone on http://100.x… does not get one. */
export function secureContext(req: IncomingMessage): boolean {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  if (proto === 'https' || (req.socket as { encrypted?: boolean }).encrypted) return true;
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export const metaRoutes: Route[] = [
  {
    method: 'GET', path: '/meta', scope: 'public',
    handler: ({ req }) => ({
      body: {
        api: API_VERSION, server: VERSION, minClient: MIN_CLIENT,
        secure: secureContext(req),
        features: ['jobs'] as string[],
      },
    }),
  },
];

/** Every v1 route. Slices append their own arrays here. */
export function v1Routes(): Route[] {
  return [...metaRoutes, ...jobRoutes];
}

export function createV1Handler(deps: RouterDeps) {
  return createV1(v1Routes(), deps);
}
