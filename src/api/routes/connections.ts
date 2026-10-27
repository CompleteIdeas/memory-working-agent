/**
 * Connections for the v2 app (v2 build, slice S3): everything the classic Connections page does for accounts and
 * reach, as routes over the same functions (src/connection-settings.ts, which serve.ts /api/connections and /api/save
 * also call):
 *
 *   GET    /connections                       Google, Outlook, Telegram and Tailscale: what is connected, how, whether
 *                                             one needs reconnecting, and which sign-ins work here. Never a key,
 *                                             secret, password or token, only whether one is saved (read)
 *   POST   /connections/gmail/app-password    check a Gmail address + app password over IMAP, then save them (admin)
 *   PUT    /connections/google/app            your own Google sign-in app: client ID + secret (admin)
 *   PUT    /connections/outlook/app           your own Microsoft app: client ID (+ tenant) (admin)
 *   PUT    /connections/telegram              check a bot token with Telegram, then save it (admin)
 *   PUT    /connections/tailscale             a Tailscale auth key (+ a name); used at the next restart (admin)
 *   DELETE /connections/{service}             disconnect google | outlook | telegram, or remove the Tailscale key (admin)
 *
 * Starting a Google or Outlook sign-in stays POST /accounts/{provider}/connect (routes/settings.ts), which S3 taught
 * Outlook's two ways (code or browser) and read-only access. Values go in, never out.
 */
import { ApiError, type Route } from '../router.js';
import {
  connectionState, connectGmailAppPassword, saveGoogleApp, saveMicrosoftApp, saveTelegram, saveTailscale, disconnect, SERVICES,
  type Service,
} from '../../connection-settings.js';
import type { Outcome } from '../../assistant-settings.js';
import { accountsView } from './settings.js';
import { isHosted, hostName } from '../../hosting.js';
import { logger } from '../../logger.js';

const bodyOf = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {});

export function connectionsView() {
  const s = connectionState();
  const acc = accountsView().accounts;
  const re = (p: 'google' | 'outlook') => !!acc.find((a) => a.provider === p)?.needsReconnect;
  const hosted = isHosted();
  // a sign-in in a browser window comes back to localhost on the computer your helper runs on: never on a server
  const browser = (appSaved: boolean) => (hosted ? 'server' as const : appSaved ? 'ready' as const : 'setup' as const);
  return {
    google: { ...s.google, needsReconnect: s.google.connected && re('google'), signIn: browser(s.google.appSaved) },
    outlook: { ...s.outlook, needsReconnect: s.outlook.connected && re('outlook'), browser: browser(s.outlook.appSaved) },
    telegram: s.telegram,
    tailscale: s.tailscale,
    hosted, host: hostName(),
  };
}

/** An outcome as a reply, or its refusal as an ApiError. A failed live check may pass on a retry (the network), so it
 *  is not remembered against the Idempotency-Key. */
function done(o: Outcome): { body: { connections: ReturnType<typeof connectionsView>; message: string } } {
  if (!o.ok) throw new ApiError(400, o.code, o.message, o.code === 'check_failed');
  return { body: { connections: connectionsView(), message: o.message } };
}

export const connectionRoutes: Route[] = [
  { method: 'GET', path: '/connections', scope: 'read', handler: () => ({ body: connectionsView() }) },
  {
    method: 'POST', path: '/connections/gmail/app-password', scope: 'admin',
    handler: async ({ body }) => {
      const b = bodyOf(body);
      const o = await connectGmailAppPassword({ address: b.address, appPassword: b.appPassword });
      if (o.ok) logger.info('connections', 'gmail connected with an app password', {});
      return done(o);
    },
  },
  {
    method: 'PUT', path: '/connections/google/app', scope: 'admin',
    handler: ({ body }) => {
      const b = bodyOf(body);
      const o = saveGoogleApp({ clientId: b.clientId, clientSecret: b.clientSecret });
      if (o.ok) logger.info('connections', 'google sign-in app saved', {});
      return done(o);
    },
  },
  {
    method: 'PUT', path: '/connections/outlook/app', scope: 'admin',
    handler: ({ body }) => {
      const b = bodyOf(body);
      const o = saveMicrosoftApp({ clientId: b.clientId, tenant: b.tenant });
      if (o.ok) logger.info('connections', 'microsoft app saved', { tenantGiven: !!b.tenant });
      return done(o);
    },
  },
  {
    method: 'PUT', path: '/connections/telegram', scope: 'admin',
    handler: async ({ body }) => {
      const o = await saveTelegram({ token: bodyOf(body).token });
      if (o.ok) logger.info('connections', 'telegram bot saved', {});
      return done(o);
    },
  },
  {
    method: 'PUT', path: '/connections/tailscale', scope: 'admin',
    handler: ({ body }) => {
      const b = bodyOf(body);
      const o = saveTailscale({ authKey: b.authKey, hostname: b.hostname });
      if (o.ok) logger.info('connections', 'tailscale key saved', { hostnameGiven: !!b.hostname });
      return done(o);
    },
  },
  {
    method: 'DELETE', path: '/connections/{service}', scope: 'admin',
    handler: ({ params }) => {
      const s = params.service as Service;
      if (!SERVICES.includes(s)) throw new ApiError(404, 'not_found', 'Disconnect Google, Outlook, Telegram or Tailscale.');
      const o = disconnect(s);
      logger.info('connections', 'disconnected', { service: s });
      return done(o);
    },
  },
];
