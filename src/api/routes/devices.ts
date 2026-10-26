/**
 * Pairing and devices (v2 build, slice A2). Settings › "Put MWA on your phone" makes a one-time code (shown as a QR
 * of `<origin>/pair#c=CODE` — the fragment never reaches a server log); the phone sends it once and gets its own
 * token: an HttpOnly cookie for the installed web app, or a bearer token for a phone app. Revoke from Settings.
 */
import type { IncomingMessage } from 'node:http';
import { ApiError, type Route } from '../router.js';
import { secureContext } from '../net.js';
import {
  createPairCode, redeemPairCode, listDevices, revokeDevice, pairingThrottled, notePairingFailure, sourceOf, DEVICE_COOKIE, PHONE_SCOPES,
} from '../auth.js';

const COOKIE_MAX_AGE_S = 400 * 24 * 3600; // the longest browsers keep a cookie
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function origin(req: IncomingMessage): string {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}
function cookie(token: string, req: IncomingMessage, maxAge = COOKIE_MAX_AGE_S): string {
  return `${DEVICE_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureContext(req) ? '; Secure' : ''}`;
}

export const deviceRoutes: Route[] = [
  {
    method: 'POST', path: '/pair/codes', scope: 'admin',
    handler: ({ req, who }) => {
      const { code, expiresAt } = createPairCode(who?.id ?? 'admin', PHONE_SCOPES);
      return { status: 201, body: { code, expiresAt, pairUrl: `${origin(req)}/pair#c=${code}`, scopes: PHONE_SCOPES } };
    },
  },
  {
    method: 'POST', path: '/pair', scope: 'public',
    handler: ({ req, body }) => {
      const source = sourceOf(req);
      if (pairingThrottled(source)) throw new ApiError(429, 'too_many_attempts', 'Too many wrong codes. Wait ten minutes and make a new code.');
      const b = (body ?? {}) as Record<string, unknown>;
      const got = redeemPairCode(str(b.code, 20), str(b.name, 60) || 'Phone', str(b.platform, 30) || undefined);
      if (!got) { notePairingFailure(source); throw new ApiError(400, 'pair_code_invalid', 'That code is wrong, used or expired. Make a new one in Settings on your computer.'); }
      const useCookie = b.cookie !== false; // the web app takes a cookie; a phone app asks for the token
      return {
        status: 201,
        body: { deviceId: got.deviceId, scopes: got.scopes, ...(useCookie ? {} : { token: got.token }) },
        headers: useCookie ? { 'set-cookie': cookie(got.token, req) } : ({} as Record<string, string>),
      };
    },
  },
  { method: 'GET', path: '/devices', scope: 'admin', handler: () => ({ body: { devices: listDevices() } }) },
  {
    method: 'DELETE', path: '/devices/{id}', scope: 'admin',
    handler: ({ params }) => {
      if (!revokeDevice(params.id)) throw new ApiError(404, 'not_found', 'No such device, or it was already removed.');
      return { body: { revoked: params.id } };
    },
  },
  {
    // "Sign out this phone": the device revokes itself, and the browser wipes its cached data for this site.
    method: 'POST', path: '/devices/me/sign-out', scope: 'read',
    handler: ({ req, who }) => {
      if (who?.kind !== 'device') throw new ApiError(400, 'not_a_device', 'Only a paired device can sign itself out.');
      revokeDevice(who.id);
      return { body: { revoked: who.id }, headers: { 'set-cookie': cookie('x', req, 0), 'clear-site-data': '"cache", "storage"' } };
    },
  },
];
