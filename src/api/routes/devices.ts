/**
 * Pairing and devices (v2 build, slice A2). Settings › "Put MWA on your phone" makes a one-time code (shown as a QR
 * of `<origin>/pair#c=CODE` — the fragment never reaches a server log); the phone sends it once and gets its own
 * token: an HttpOnly cookie for the installed web app, or a bearer token for a phone app. Revoke from Settings.
 */
import type { IncomingMessage } from 'node:http';
import { ApiError, type Route } from '../router.js';
import { cookieSecure } from '../trust.js';
import { pairingGate } from '../gate.js';
import { publicBaseUrl } from '../../v2/settings.js';
import {
  createPairCode, redeemPairCode, listDevices, revokeDevice, sourceOf, DEVICE_COOKIE, PHONE_SCOPES,
} from '../auth.js';

const COOKIE_MAX_AGE_S = 400 * 24 * 3600; // the longest browsers keep a cookie
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;
/**
 * Where a phone should open the pairing page. A phone cannot reach "localhost" (W5 security review, finding 8): when
 * the page was opened at a local address, the link uses the helper's public address (MWA_PUBLIC_URL, Settings › Your
 * helper, or the tailnet name in MWA_ALLOWED_HOSTS); with none known it keeps the local address and says so
 * (`reachable: false`), and the app asks for the address.
 */
function pairBase(req: IncomingMessage): { base: string; reachable: boolean } {
  const host = String(req.headers.host ?? 'localhost').trim();
  const proto = cookieSecure(req) ? 'https' : 'http';
  if (!LOCAL.test(host)) return { base: `${proto}://${host}`, reachable: true };
  const pub = publicBaseUrl();
  return pub ? { base: pub, reachable: true } : { base: `${proto}://${host}`, reachable: false };
}
function cookie(token: string, req: IncomingMessage, maxAge = COOKIE_MAX_AGE_S): string {
  return `${DEVICE_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${cookieSecure(req) ? '; Secure' : ''}`;
}

export const deviceRoutes: Route[] = [
  {
    method: 'POST', path: '/pair/codes', scope: 'admin',
    handler: ({ req, who }) => {
      const { code, expiresAt } = createPairCode(who?.id ?? 'admin', PHONE_SCOPES);
      const { base, reachable } = pairBase(req);
      return { status: 201, body: { code, expiresAt, pairUrl: `${base}/pair#c=${code}`, scopes: PHONE_SCOPES, reachable } };
    },
  },
  {
    method: 'POST', path: '/pair', scope: 'public',
    handler: async ({ req, body }) => {
      const b = (body ?? {}) as Record<string, unknown>;
      // wrong codes from one place slow that place down; a right code is never refused (gate.ts)
      const got = await pairingGate.attempt(sourceOf(req), () => {
        const r = redeemPairCode(str(b.code, 20), str(b.name, 60) || 'Phone', str(b.platform, 30) || undefined);
        return { ok: !!r, value: r };
      });
      if (!got) throw new ApiError(400, 'pair_code_invalid', 'That code is wrong, used or expired. Make a new one in Settings on your computer.');
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
