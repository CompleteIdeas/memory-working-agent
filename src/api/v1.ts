/**
 * The /api/v1 route table (v2 build). Each area adds its routes here as its slice lands; the OpenAPI contract
 * (api/openapi.yaml) lists the same operations and tests/api-contract.test.ts holds the two together.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createV1, API_VERSION, MIN_CLIENT, type Route, type RouterDeps } from './router.js';
import { secureContext } from './net.js';
import { deviceRoutes } from './routes/devices.js';
import { jobRoutes } from './routes/jobs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
function serverVersion(): string {
  for (const p of [join(HERE, '../../package.json'), join(HERE, '../package.json')]) {
    try { return String(JSON.parse(readFileSync(p, 'utf8')).version ?? '0.0.0'); } catch { /* next */ }
  }
  return '0.0.0';
}
const VERSION = serverVersion();

export { secureContext };

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
  return [...metaRoutes, ...deviceRoutes, ...jobRoutes];
}

export function createV1Handler(deps: RouterDeps) {
  return createV1(v1Routes(), deps);
}
