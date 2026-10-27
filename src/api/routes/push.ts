/**
 * Web push routes (v2 build, slice P3).
 *
 *   GET    /push/subscriptions        (read)  this server's public VAPID key, the caller's subscriptions (an admin sees
 *                                            every one), which kinds notify, the morning time, quiet hours
 *   POST   /push/subscriptions        (act)   store a browser's subscription for THIS caller (a paired device, a
 *                                            password session, or this machine). Only https endpoints on the known
 *                                            push services (SSRF); `replaces` drops the subscription it supersedes
 *   DELETE /push/subscriptions/{id}   (act)   the caller's own (an admin: any)
 *   PATCH  /push/settings             (admin) which kinds notify, the morning time, quiet hours: shared by every
 *                                            device, so the owner's (P3 review); a phone sees them read-only
 *   POST   /push/test                 (act)   "Send a test" to the caller's own subscriptions, at once
 *
 * A subscription belongs to the device or session that made it: revoking the device, signing that session out or
 * "sign out everywhere" removes it (auth.ts, sessions.ts), and a send re-checks that its owner is still live.
 */
import type { IncomingMessage } from 'node:http';
import { ApiError, type Route } from '../router.js';
import type { Caller } from '../auth.js';
import { sessionIdOf, cookieToken } from '../sessions.js';
import { cleanDeviceName } from '../auth.js';
import { checkEndpoint, checkKeys, vapidKeys, vapidReset, vendorWords, type Vendor } from '../../v2/webpush.js';
import {
  saveSubscription, getSubscription, subscriptionByEndpoint, listSubscriptions, deleteSubscription, readPrefs, writePrefs, validMorning,
  PUSH_KINDS, PushStoreError, type PushKind, type SubRow,
} from '../../v2/push-store.js';
import { sendTest, liveSubscriptions } from '../../v2/push.js';
import { quietWindow, setQuietHours, quietEnvInvalid, parseQuietHours } from '../../quiet.js';
import { todayTz } from '../../v2/today.js';

const bodyOf = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {});

/** Whose a subscription is. A password session is told apart by its own id, so signing it out ends its notifications. */
function ownerOf(who: Caller | null, req: IncomingMessage): string {
  if (!who) throw new ApiError(401, 'locked', 'Sign in to continue.');
  if (who.kind === 'device') return `device:${who.id}`;
  if (who.kind === 'local') return 'local';
  const sid = sessionIdOf(cookieToken(req));
  if (!sid) throw new ApiError(401, 'locked', 'Sign in again to turn on notifications.', true);
  return `session:${sid}`;
}
/** The caller's owner key, or null when there is none (never throws: for reads). */
function ownerOrNull(who: Caller | null, req: IncomingMessage): string | null { try { return ownerOf(who, req); } catch { return null; } }

function subView(s: SubRow, mine: boolean) {
  return {
    id: s.id, mine, vendor: s.vendor as Vendor, service: vendorWords(s.vendor as Vendor), platform: s.platform,
    owner: s.owner.startsWith('device:') ? 'device' : s.owner.startsWith('session:') ? 'session' : 'local',
    createdAt: s.created_at, lastOk: s.last_ok, lastError: s.last_error,
    // the endpoint only to its own browser (it compares it with its own subscription); never to anyone else
    ...(mine ? { endpoint: s.endpoint } : {}),
  };
}

function quietView() {
  const w = quietWindow();
  return { value: w?.label ?? null, fixed: !!(process.env.MWA_QUIET_HOURS ?? '').trim(), invalid: quietEnvInvalid() };
}
function settingsView() {
  const p = readPrefs();
  return { kinds: p.kinds, morning: p.morning, timeZone: todayTz(), quietHours: quietView() };
}

export const pushRoutes: Route[] = [
  {
    method: 'GET', path: '/push/subscriptions', scope: 'read',
    handler: ({ who, req }) => {
      const owner = ownerOrNull(who, req);
      const admin = !!who?.scopes.has('admin');
      const subs = listSubscriptions().filter((s) => admin || s.owner === owner);
      const vapidPublicKey = vapidKeys().publicKey; // first: reading the key file is what finds it corrupt
      const reset = vapidReset();
      return { body: { vapidPublicKey, keysReset: reset ? reset.at : null, subscriptions: subs.map((s) => subView(s, s.owner === owner)), settings: settingsView() } };
    },
  },
  {
    method: 'POST', path: '/push/subscriptions', scope: 'act',
    handler: ({ who, req, body }) => {
      const owner = ownerOf(who, req);
      const b = bodyOf(body);
      const keys = bodyOf(b.keys);
      const ep = checkEndpoint(b.endpoint);
      if (!ep.ok) throw new ApiError(400, 'bad_endpoint', ep.why);
      const k = checkKeys(keys.p256dh, keys.auth);
      if (!k) throw new ApiError(400, 'bad_keys', 'The subscription’s keys are missing or malformed. Turn notifications off and on again.');
      const exp = b.expirationTime;
      const expiresAt = typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? Math.floor(exp) : null;
      const platform = typeof b.platform === 'string' ? cleanDeviceName(b.platform, 30) || null : null;
      // the browser changed its subscription (pushsubscriptionchange): the old one goes, if it was this caller's
      if (typeof b.replaces === 'string' && b.replaces !== b.endpoint) {
        const old = subscriptionByEndpoint(b.replaces);
        if (old && old.owner === owner) deleteSubscription(old.id);
      }
      let s: SubRow;
      try {
        s = saveSubscription({ endpoint: ep.url.href, p256dh: String(keys.p256dh).replace(/=+$/, ''), auth: String(keys.auth).replace(/=+$/, ''), owner, platform, vendor: ep.vendor, expiresAt, vapid: vapidKeys().publicKey });
      } catch (e) {
        // P3 review: another device's endpoint is never moved to this caller; past the cap, no live device is cut off
        if (e instanceof PushStoreError) throw new ApiError(409, e.code, e.message);
        throw e;
      }
      return { status: 201, body: { subscription: subView(s, true) } };
    },
  },
  {
    method: 'DELETE', path: '/push/subscriptions/{id}', scope: 'act',
    handler: ({ params, who, req }) => {
      const s = getSubscription(params.id);
      const owner = ownerOrNull(who, req);
      // someone else's is "no such" to a non-admin: no telling which ids exist
      if (!s || (s.owner !== owner && !who?.scopes.has('admin'))) throw new ApiError(404, 'not_found', 'No such subscription, or it was already removed.');
      deleteSubscription(s.id);
      return { body: { removed: s.id } };
    },
  },
  {
    method: 'PATCH', path: '/push/settings', scope: 'admin',
    handler: ({ body }) => {
      const b = bodyOf(body);
      const known = ['kinds', 'morning', 'quietHours'];
      const extra = Object.keys(b).filter((k) => !known.includes(k));
      if (extra.length || !Object.keys(b).length) throw new ApiError(400, 'bad_body', `Send one or more of: ${known.join(', ')}.`);
      // check everything before saving anything
      let kinds: Partial<Record<PushKind, boolean>> | undefined;
      if (b.kinds !== undefined) {
        const k = bodyOf(b.kinds);
        if (!Object.keys(k).length || Object.entries(k).some(([n, v]) => !PUSH_KINDS.includes(n as PushKind) || typeof v !== 'boolean')) {
          throw new ApiError(400, 'bad_kinds', `Kinds are ${PUSH_KINDS.join(', ')}, each true or false.`);
        }
        kinds = k as Partial<Record<PushKind, boolean>>;
      }
      let morning: string | undefined;
      if (b.morning !== undefined) {
        const m = validMorning(b.morning);
        if (!m) throw new ApiError(400, 'bad_time', 'Pick a morning time between 5:00 and 11:30, like 07:30.');
        morning = m;
      }
      let quiet: string | undefined;
      if (b.quietHours !== undefined) {
        if ((process.env.MWA_QUIET_HOURS ?? '').trim()) throw new ApiError(400, 'fixed', 'Quiet hours were set when this helper was installed, so they can’t be changed here.');
        const q = b.quietHours === null ? 'off' : typeof b.quietHours === 'string' ? b.quietHours.trim() : '';
        if (q !== 'off' && !parseQuietHours(q)) throw new ApiError(400, 'bad_quiet', 'Give quiet hours as a start and end, like 22:00-07:00 (at most 16 hours), or turn them off.');
        quiet = q;
      }
      if (quiet !== undefined) {
        try { setQuietHours(quiet); } catch (e) { throw new ApiError(409, 'bad_config', (e as Error).message); }
      }
      if (kinds || morning) writePrefs({ kinds, morning });
      return { body: settingsView() };
    },
  },
  {
    method: 'POST', path: '/push/test', scope: 'act',
    handler: async ({ who, req, caller }) => {
      const owner = ownerOf(who, req);
      const subs = liveSubscriptions().filter((s) => s.owner === owner);
      if (!subs.length) throw new ApiError(409, 'not_subscribed', 'Notifications aren’t on for this device yet. Turn them on first.', true);
      const r = await sendTest(caller, subs);
      if (r.limited) throw new ApiError(429, 'too_many_tests', 'That’s a lot of tests. Wait a few minutes and try again.', true);
      const d = r.delivery;
      const services = [...new Set(d.per.filter((p) => p.outcome === 'accepted').map((p) => vendorWords(p.vendor as Vendor)))];
      const message = d.accepted
        ? `Sent to ${services.join(' and ')}. It should show on this device in a few seconds. If it doesn’t, check that notifications are allowed for MWA.`
        : d.gone ? 'This device’s notification subscription had expired, so I removed it. Turn notifications on again.'
        : d.retry ? 'The push service didn’t answer just now. Try again in a minute.'
        : 'The push service refused the test. Turn notifications off and on again on this device.';
      return { body: { accepted: d.accepted, gone: d.gone, failed: d.failed + d.retry, results: d.per.map((p) => ({ id: p.id, outcome: p.outcome, status: p.status })), message }, transient: !d.accepted };
    },
  },
];
