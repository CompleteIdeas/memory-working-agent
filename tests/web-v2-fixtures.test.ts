// v2 build, slice W1: fixture mode (web/src/v2/dev/fixtures.ts) answers with the contract's shapes, so screens built
// against it work against the real server: every response is validated against api/openapi.yaml. It also behaves
// like the server where the store relies on it (idempotency, the client version, /sync deltas, the stream).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { FixtureServer, type StreamMessage } from '../web/src/v2/dev/fixtures';
import { FIXTURE_NOW } from '../web/src/v2/dev/fixture-data';
import { pillFor, groupJobs } from '../web/src/v2/store/status';
import type { Job } from '../web/src/v2/api/client';

const spec = parse(readFileSync(new URL('../api/openapi.yaml', import.meta.url), 'utf8'));
const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false, allErrors: true });
(addFormats as unknown as typeof addFormats.default)(ajv);
ajv.addSchema({ $id: 'spec', components: spec.components });
function schemaFor(path: string, method: string, status: number): object {
  const op = spec.paths[path][method];
  const r = op.responses[String(status)] ?? op.responses.default;
  const resolved = r.$ref ? spec.components.responses[r.$ref.split('/').pop()] : r;
  return JSON.parse(JSON.stringify(resolved.content['application/json'].schema).replace(/"#\/components\//g, '"spec#/components/'));
}
function valid(path: string, method: string, res: { status: number; body: unknown }) {
  const fn = ajv.compile(schemaFor(path, method, res.status));
  expect(fn(res.body) ? null : `${method.toUpperCase()} ${path} ${res.status}: ${ajv.errorsText(fn.errors)}`).toBeNull();
}
const H = { 'x-mwa-client': 'web/1.0.0' };
const get = (s: FixtureServer, path: string, q = '') => s.handle({ method: 'GET', path, query: new URLSearchParams(q), headers: H, body: undefined });
let k = 0;
const post = (s: FixtureServer, path: string, body?: unknown, key = `fixture-key-${++k}`) => s.handle({ method: 'POST', path, query: new URLSearchParams(), headers: { ...H, 'idempotency-key': key }, body });

describe('fixture mode answers with the contract\'s shapes', () => {
  it('every read the screens use', () => {
    for (const scenario of ['N00', 'N06', 'states']) {
      const s = new FixtureServer(scenario);
      valid('/meta', 'get', get(s, '/meta'));
      valid('/jobs', 'get', get(s, '/jobs'));
      valid('/jobs/{id}', 'get', get(s, '/jobs/j_news'));
      valid('/sync', 'get', get(s, '/sync', 'collections=jobs,calendar,mail,projects,turns'));
      valid('/calendar', 'get', get(s, '/calendar', `from=${new Date(FIXTURE_NOW - 86_400_000).toISOString()}&to=${new Date(FIXTURE_NOW + 7 * 86_400_000).toISOString()}`));
      valid('/calendar/accounts', 'get', get(s, '/calendar/accounts'));
      valid('/mail', 'get', get(s, '/mail'));
      valid('/mail/accounts', 'get', get(s, '/mail/accounts'));
      valid('/mail/{id}', 'get', get(s, '/mail/m_m1'));
      valid('/projects', 'get', get(s, '/projects'));
      valid('/projects/{id}/thread', 'get', get(s, '/projects/{id}/thread'.replace('{id}', 'family')));
      valid('/projects/{id}/work', 'get', get(s, '/projects/ainews/work'));
      valid('/projects/{id}/files', 'get', get(s, '/projects/ainews/files'));
      valid('/jobs/{id}', 'get', get(s, '/jobs/nope')); // the error shape
    }
  });

  it('every write it acts on, and a delta after them', () => {
    const s = new FixtureServer('N06');
    s.answerDelay = 0;
    const head = (get(s, '/sync').body as { cursor: number }).cursor;
    valid('/jobs/{id}/stop', 'post', post(s, '/jobs/j_news/stop'));
    valid('/jobs/{id}/continue', 'post', post(s, '/jobs/j_learn/continue', { capUsd: 0.5 }));
    valid('/jobs/{id}/open', 'post', post(s, '/jobs/j_learn/open'));
    valid('/calendar/drafts/{id}/confirm', 'post', post(s, '/calendar/drafts/cd_e9/confirm'));
    valid('/calendar/drafts/{id}/remove', 'post', post(s, '/calendar/drafts/cd_e9/remove')); // 409: already confirmed
    valid('/projects/{id}/messages', 'post', post(s, '/projects/general/messages', { text: 'hello' }));
    const d = get(s, '/sync', `since=${head}&collections=jobs,calendar,projects,turns`);
    valid('/sync', 'get', d);
    const body = d.body as { reset: boolean; upserts: { jobs: Job[]; calendar: { id: string }[]; turns: { id: string }[] }; deletes: { calendar: string[] } };
    expect(body.reset).toBe(false);
    expect(body.upserts.jobs.map((j) => `${j.id}:${j.status.state}`).sort()).toEqual(['j_learn:working', 'j_news:stopped_by_you']);
    expect(body.deletes.calendar).toEqual(['cd_e9']);
    expect(body.upserts.calendar.map((c) => c.id)).toEqual(['google:e9']);
    expect(body.upserts.turns).toHaveLength(1);
  });
});

describe('fixture mode behaves like the server where the store relies on it', () => {
  it('a write needs an Idempotency-Key; a retry with the same key gets the first answer, not a second action', () => {
    const s = new FixtureServer('N06');
    expect(s.handle({ method: 'POST', path: '/jobs/j_news/stop', query: new URLSearchParams(), headers: H, body: undefined }).status).toBe(400);
    const a = post(s, '/jobs/j_news/stop', undefined, 'same-key-123');
    const b = post(s, '/jobs/j_news/stop', undefined, 'same-key-123');
    expect(a.status).toBe(200);
    expect(b).toMatchObject({ status: 200, headers: { 'idempotent-replay': 'true' } });
    expect(post(s, '/jobs/j_news/stop').status).toBe(409); // a new key: it is no longer running
  });

  it('426 for a client older than minClient (the old-client scenario)', () => {
    const s = new FixtureServer('old-client');
    expect(get(s, '/meta').status).toBe(200);
    const r = get(s, '/jobs');
    expect(r.status).toBe(426);
    valid('/jobs', 'get', r);
  });

  it('the stream says hello, replays what changed after the cursor, then follows along', () => {
    const s = new FixtureServer('N00');
    s.answerDelay = 0;
    const head = (get(s, '/sync').body as { cursor: number }).cursor;
    const got: StreamMessage[] = [];
    const off = s.openStream(head - 1, (m) => got.push(m));
    expect(got[0]).toMatchObject({ event: 'hello', data: { cursor: head - 1, head } });
    expect(got.slice(1).map((m) => m.id)).toEqual([head]);
    post(s, '/jobs/j_news/stop');
    const last = got.at(-1)!;
    expect(last).toMatchObject({ event: 'change', id: head + 1, data: { entity: 'job', id: 'j_news', op: 'upsert' } });
    expect((last.data as { data: Job }).data.status.state).toBe('stopped_by_you');
    off();
  });

  it('the scenarios give the prototype\'s pill and groups', () => {
    const jobsOf = (sc: string) => (get(new FixtureServer(sc), '/sync').body as { upserts: { jobs: Job[] } }).upserts.jobs;
    expect(pillFor(jobsOf('N00')).text).toBe('Working on 1 thing');
    expect(pillFor(jobsOf('N06')).text).toBe('Working on 1 · 1 waiting for you');
    expect(groupJobs(jobsOf('N06')).map((g) => `${g.title} · ${g.jobs.length}`)).toEqual(['Waiting for you · 1', 'Working now · 1']);
    expect(pillFor(jobsOf('states')).text).toBe('Working on 2 · 1 waiting for you · 1 result ready');
    expect(new Set(jobsOf('states').filter((j) => !j.archived).map((j) => j.status.state)).size).toBe(8);
  });
});
