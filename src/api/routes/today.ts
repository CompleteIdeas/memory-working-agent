/**
 * /api/v1/today (v2 slice A10): the Today screen in one read, and the person's three marks on it — "I looked"
 * (per caller: what is listed under Done for you starts after it), "Done — show my day" (the morning check-in) and
 * "Good night" (the evening wrap). Reading needs `read`; the marks need `act`. No model call is made by any of them.
 */
import { ApiError, type Route } from '../router.js';
import { buildToday, markSeen, markDone, todayNow, todayTz } from '../../v2/today.js';

const bodyObj = (b: unknown): Record<string, unknown> => {
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) throw new ApiError(400, 'bad_json', 'Send a JSON object.');
  return b as Record<string, unknown>;
};
const weekday = (day: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(new Date(`${day}T12:00:00Z`));

export const todayRoutes: Route[] = [
  {
    method: 'GET', path: '/today', scope: 'read',
    handler: async ({ caller }) => ({ body: await buildToday(caller) }),
  },
  {
    method: 'POST', path: '/today/seen', scope: 'act',
    handler: ({ caller, body }) => {
      bodyObj(body);
      return { body: { seenAt: markSeen(caller, todayNow()) } };
    },
  },
  {
    method: 'POST', path: '/today/checkin/done', scope: 'act',
    handler: async ({ caller, body }) => {
      bodyObj(body);
      const day = markDone('checkin', todayNow(), todayTz());
      return { body: { message: `Morning check-in done. Have a good ${weekday(day)}.`, today: await buildToday(caller) } };
    },
  },
  {
    method: 'POST', path: '/today/wrap/done', scope: 'act',
    handler: async ({ caller, body }) => {
      bodyObj(body);
      markDone('wrap', todayNow(), todayTz());
      return { body: { message: 'See you in the morning.', today: await buildToday(caller) } };
    },
  },
];
