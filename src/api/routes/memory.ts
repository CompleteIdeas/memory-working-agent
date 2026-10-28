/**
 * What your helper remembers, and what it has been doing, for the v2 app (v2 build, slice S5). The same code as the
 * classic Memory page and Activity log (src/memory-settings.ts, src/activity.ts, which serve.ts also calls):
 *
 *   GET  /memory                          learned facts, newest first (`q` searches their names and text, `limit`),
 *                                         the standing preferences, and the routines it proposed (read)
 *   POST /memory/{id}/correct             replace a fact with your words: the old one goes, yours is trusted (admin);
 *                                         one that came from outside needs `confirmed: true` and your own words
 *   POST /memory/{id}/forget              forget a fact for good; needs `confirmed: true` (admin)
 *   GET  /memory/export                   everything as Markdown, a download (admin)
 *   POST /memory/preferences/remove       remove a standing preference; needs `confirmed: true` (admin)
 *   POST /memory/routines/{id}/promote    its steps guide similar tasks from now on; needs `confirmed: true` (admin)
 *   POST /memory/routines/{id}/retire     it no longer does (admin)
 *   GET  /activity                        the recent runs: in your words, how each ended, the tools it used by name,
 *                                         what it cost; pasted secrets masked (read)
 *
 * Reading is `read` (a paired phone sees it); changing or exporting memory is `admin`, as the classic routes are
 * (src/api/legacy.ts). Forgetting and promoting ask first: without `confirmed: true` the answer is 409 confirm_needed
 * and nothing changes. Only a fact the list can show can be corrected or forgotten (not a job, routine or preference).
 */
import { ApiError, type Route } from '../router.js';
import {
  memoryView, forgetFact, correctFact, exportMemory, listPreferences, forgetPreference, listRoutines, setRoutine, PREVIEW, type Fact, type Routine, type Outcome,
} from '../../memory-settings.js';
import { activityView } from '../../activity.js';
import { logger } from '../../logger.js';

const bodyOf = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {});
const PERSON = /^person [^:]+:\s*/i;

/** A learned fact as the app shows it: where it came from, in a word, and whether it is trusted. `text` is the list's
 *  preview (the first 240 characters, `truncated` when there is more); `full` is the whole text, for Correct. */
export function factView(f: Fact) {
  const about = PERSON.test(f.concept);
  const source = f.trust === 'untrusted' ? 'outside' : f.provenance === 'user' || about ? 'you' : 'inferred';
  return {
    id: f.id, name: about ? f.concept.replace(PERSON, '') || 'About you' : f.concept,
    text: f.content.length > PREVIEW ? `${f.content.slice(0, PREVIEW).trimEnd()}…` : f.content, truncated: f.content.length > PREVIEW, full: f.content, about,
    source: source as 'you' | 'inferred' | 'outside', origin: f.trust === 'untrusted' ? (f.origin ?? null) : null, trusted: f.trust !== 'untrusted',
  };
}
export function routineView(r: Routine) {
  const status = r.status === 'active' ? 'active' : r.status === 'retired' ? 'retired' : 'proposed';
  return { id: r.id, name: r.name, version: r.version, status: status as 'proposed' | 'active' | 'retired', steps: r.content, tainted: r.tainted, store: r.agent };
}

const STATUS: Record<string, number> = { not_found: 404, bad_text: 400, bad_name: 400, bad_rule: 400, unknown_store: 400, truncated: 400, outside_copy: 400, confirm_needed: 409, not_done: 409, unavailable: 503 };
function refuse(o: Outcome & { ok: false }): never {
  throw new ApiError(STATUS[o.code] ?? 400, o.code, o.message, o.code === 'not_done' || o.code === 'unavailable');
}
function confirmed(b: Record<string, unknown>, ask: string): void {
  if (b.confirmed !== true) throw new ApiError(409, 'confirm_needed', ask);
}

export const memoryRoutes: Route[] = [
  {
    method: 'GET', path: '/memory', scope: 'read',
    handler: async ({ url }) => {
      const q = (url.searchParams.get('q') ?? '').slice(0, 200);
      const limit = Number(url.searchParams.get('limit') ?? 40);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ApiError(400, 'bad_limit', '`limit` is a whole number from 1 to 500.');
      const { facts, total, preferences, routines } = await memoryView({ q, limit }); // one store open at a time (pglite)
      return { body: { facts: facts.map(factView), total, query: q, preferences, routines: routines.map(routineView) } };
    },
  },
  {
    method: 'POST', path: '/memory/{id}/correct', scope: 'admin',
    handler: async ({ params, body }) => {
      const b = bodyOf(body);
      const o = await correctFact(params.id, b.text, b.name, { confirmed: b.confirmed === true });
      if (!o.ok) refuse(o);
      logger.info('memory', 'fact corrected', { id: params.id });
      return { body: { fact: o.fact ? factView(o.fact) : null, message: o.message } };
    },
  },
  {
    method: 'POST', path: '/memory/{id}/forget', scope: 'admin',
    handler: async ({ params, body }) => {
      confirmed(bodyOf(body), 'Forget this for good? It can’t be undone. Send confirmed: true to go ahead.');
      const o = await forgetFact(params.id);
      if (!o.ok) refuse(o);
      logger.info('memory', 'fact forgotten', { id: params.id });
      return { body: { forgotten: params.id, message: o.message } };
    },
  },
  {
    method: 'GET', path: '/memory/export', scope: 'admin',
    handler: async () => ({
      raw: { contentType: 'text/markdown; charset=utf-8', body: await exportMemory() },
      headers: { 'content-disposition': 'attachment; filename="mwa-memory.md"' },
    }),
  },
  {
    method: 'POST', path: '/memory/preferences/remove', scope: 'admin',
    handler: async ({ body }) => {
      const b = bodyOf(body);
      if (typeof b.rule !== 'string' || !b.rule.trim()) throw new ApiError(400, 'bad_rule', 'Say which standing preference to remove.');
      confirmed(b, 'Remove this standing preference? It will no longer apply to new tasks. Send confirmed: true to go ahead.');
      const o = await forgetPreference(b.rule);
      if (!o.ok) refuse(o);
      logger.info('memory', 'preference removed', { removed: o.removed });
      return { body: { removed: o.removed, preferences: await listPreferences(), message: o.message } };
    },
  },
  {
    method: 'POST', path: '/memory/routines/{id}/promote', scope: 'admin',
    handler: async ({ params, body }) => {
      const b = bodyOf(body);
      const r = (await listRoutines()).find((x) => x.id === params.id && (b.store === undefined || x.agent === b.store));
      if (!r) throw new ApiError(404, 'not_found', 'That routine isn’t there any more.');
      confirmed(b, `Promote “${r.name}” ${r.version}? Its steps will guide similar tasks from now on.${r.tainted ? ' It was proposed after reading outside content: read every step first.' : ''} Send confirmed: true to go ahead.`);
      const o = await setRoutine(params.id, 'promote', r.agent);
      if (!o.ok) refuse(o);
      logger.info('memory', 'routine promoted', { id: params.id });
      return { body: { routine: o.routine ? routineView(o.routine) : null, message: o.message } };
    },
  },
  {
    method: 'POST', path: '/memory/routines/{id}/retire', scope: 'admin',
    handler: async ({ params, body }) => {
      const b = bodyOf(body);
      const r = (await listRoutines()).find((x) => x.id === params.id && (b.store === undefined || x.agent === b.store));
      if (!r) throw new ApiError(404, 'not_found', 'That routine isn’t there any more.');
      const o = await setRoutine(params.id, 'retire', r.agent);
      if (!o.ok) refuse(o);
      logger.info('memory', 'routine retired', { id: params.id });
      return { body: { routine: o.routine ? routineView(o.routine) : null, message: o.message } };
    },
  },
  {
    method: 'GET', path: '/activity', scope: 'read',
    handler: ({ url }) => {
      const limit = Number(url.searchParams.get('limit') ?? 60);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, 'bad_limit', '`limit` is a whole number from 1 to 200.');
      return { body: activityView(limit) };
    },
  },
];
