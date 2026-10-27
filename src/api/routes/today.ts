/**
 * /api/v1/today (v2 slice A10): the Today screen in one read, and the person's three marks on it — "I looked"
 * (per caller: what is listed under Done for you starts after it), "Done — show my day" (the morning check-in) and
 * "Good night" (the evening wrap). Reading needs `read`; the marks need `act`. No model call is made by any of them.
 */
import { ApiError, type Route } from '../router.js';
import { buildToday, markSeen, markDone, todayNow, todayTz } from '../../v2/today.js';
import { localDate } from '../../sync/tz.js';

const bodyObj = (b: unknown): Record<string, unknown> => {
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) throw new ApiError(400, 'bad_json', 'Send a JSON object.');
  return b as Record<string, unknown>;
};
/** The day a mark is for (W2 review M2): a check-in or wrap tapped (or queued) on another day must not dismiss today's. */
function dayOf(b: Record<string, unknown>): string | null {
  if (b.day === undefined || b.day === null) return null;
  if (typeof b.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.day)) throw new ApiError(400, 'bad_day', '`day` is a date like 2026-11-09.');
  return b.day;
}
const weekday = (day: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(new Date(`${day}T12:00:00Z`));

export const todayRoutes: Route[] = [
  {
    method: 'GET', path: '/today', scope: 'read',
    handler: async ({ caller }) => ({ body: await buildToday(caller) }),
  },
  {
    method: 'POST', path: '/today/seen', scope: 'act',
    handler: ({ caller, body }) => {
      // the Today the caller actually looked at (its `now`), never later than the real clock nor earlier than the last look
      const b = bodyObj(body);
      if (b.seenAt !== undefined && (typeof b.seenAt !== 'number' || !Number.isFinite(b.seenAt) || b.seenAt < 0)) throw new ApiError(400, 'bad_seen', '`seenAt` is a time in milliseconds.');
      return { body: { seenAt: markSeen(caller, typeof b.seenAt === 'number' ? Math.min(b.seenAt, todayNow()) : todayNow()) } };
    },
  },
  {
    method: 'POST', path: '/today/checkin/done', scope: 'act',
    handler: async ({ caller, body }) => {
      const want = dayOf(bodyObj(body));
      if (want && want !== localDate(todayNow(), todayTz())) return { body: { message: 'That was for another day, so nothing changed.', ignored: true, today: await buildToday(caller) } };
      const day = markDone('checkin', todayNow(), todayTz());
      return { body: { message: `Morning check-in done. Have a good ${weekday(day)}.`, today: await buildToday(caller) } };
    },
  },
  {
    method: 'POST', path: '/today/wrap/done', scope: 'act',
    handler: async ({ caller, body }) => {
      const want = dayOf(bodyObj(body));
      if (want && want !== localDate(todayNow(), todayTz())) return { body: { message: 'That was for another day, so nothing changed.', ignored: true, today: await buildToday(caller) } };
      markDone('wrap', todayNow(), todayTz());
      return { body: { message: 'See you in the morning.', today: await buildToday(caller) } };
    },
  },
];
