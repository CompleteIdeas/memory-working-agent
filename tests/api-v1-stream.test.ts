// v2 build, slice A4: the live stream (SSE with a resumable cursor) and /sync (offline catch-up), over real HTTP.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createV1 } from '../src/api/router.js';
import { v1Routes } from '../src/api/v1.js';
import { ALL_SCOPES, type Caller } from '../src/api/auth.js';
import { appDb, resetAppDb, recordEvent } from '../src/v2/db.js';
import { createJob, claimTry, endTry } from '../src/v2/jobs.js';
import { setStreamDeps, trimEvents, cursorTooOld, headSeq } from '../src/api/routes/stream.js';
import { liveRuns } from '../src/live-runs.js';

const ADMIN: Caller = { kind: 'session', id: 'session', scopes: new Set(ALL_SCOPES), viaCookie: true };
const PHONE: Caller = { kind: 'device', id: 'dev_1', scopes: new Set(['read', 'act', 'approve']), viaCookie: false };
let who: Caller = ADMIN;
let server: Server, base = '';

beforeEach(async () => {
  resetAppDb(':memory:'); who = ADMIN;
  setStreamDeps({ running: () => new Set(), pending: () => new Set() });
  if (!server) {
    const v1 = createV1(v1Routes(), { authenticate: () => who, sameOrigin: () => true });
    server = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(404); res.end(); } });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  }
});
afterAll(() => server?.close());

const j = async (r: Response) => ({ status: r.status, body: await r.json() });
interface Sse { event: string; id?: string; data?: any }
/** Open the stream, collect messages until `until` is satisfied (or the time runs out), then close it. */
async function listen(path: string, until: (msgs: Sse[]) => boolean, act?: () => void | Promise<void>, headers: Record<string, string> = {}, ms = 6000): Promise<Sse[]> {
  const ac = new AbortController();
  const r = await fetch(base + path, { signal: ac.signal, headers });
  expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
  const reader = r.body!.getReader(); const dec = new TextDecoder();
  let buf = ''; const msgs: Sse[] = []; let acted = false;
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((res) => setTimeout(() => res({ done: true, value: undefined }), deadline - Date.now()))]);
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const m: Sse = { event: 'message' };
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) m.event = line.slice(7);
          else if (line.startsWith('id: ')) m.id = line.slice(4);
          else if (line.startsWith('data: ')) m.data = JSON.parse(line.slice(6));
        }
        if (m.data !== undefined || m.event !== 'message') msgs.push(m);
      }
      if (!acted && act && msgs.some((m) => m.event === 'hello')) { acted = true; await act(); }
      if (until(msgs)) break;
    }
  } finally { ac.abort(); }
  return msgs;
}
const changes = (msgs: Sse[]) => msgs.filter((m) => m.event === 'change');

describe('/sync', () => {
  it('a first sync is a full snapshot; later ones carry only what changed, as current objects', async () => {
    const a = createJob({ kind: 'background', title: 'Learn the PDFs' }, { trigger: 'first' });
    const first = await j(await fetch(`${base}/sync`));
    expect(first.body).toMatchObject({ reset: true, deletes: { jobs: [] } });
    expect(first.body.upserts.jobs.map((x: any) => x.id)).toEqual([a.job.id]);
    const cursor = first.body.cursor;
    expect(cursor).toBe(headSeq());

    const same = await j(await fetch(`${base}/sync?since=${cursor}`));
    expect(same.body).toEqual({ cursor, reset: false, more: false, upserts: { jobs: [] }, deletes: { jobs: [] } });

    claimTry(a.try!.id, {});
    endTry(a.try!.id, { reason: 'done', outcome: 'changed', summary: 'Read both.' });
    const b = createJob({ kind: 'reminder', title: 'Call the farrier' });
    const next = await j(await fetch(`${base}/sync?since=${cursor}`));
    expect(next.body.reset).toBe(false);
    const byId = Object.fromEntries(next.body.upserts.jobs.map((x: any) => [x.id, x]));
    expect(Object.keys(byId).sort()).toEqual([a.job.id, b.job.id].sort());
    expect(byId[a.job.id].status.state).toBe('done'); // the job's CURRENT state, after its try ended
    expect(next.body.cursor).toBeGreaterThan(cursor);
  });
  it('a cursor older than what is kept gets a full snapshot again (reset)', async () => {
    createJob({ kind: 'background', title: 'Old' });
    const c = headSeq();
    createJob({ kind: 'background', title: 'Newer' });
    appDb().prepare('UPDATE events SET ts = 0').run();
    trimEvents();
    expect(cursorTooOld(c - 1)).toBe(true);
    const r = await j(await fetch(`${base}/sync?since=${c - 1}`));
    expect(r.body.reset).toBe(true);
    expect(r.body.upserts.jobs).toHaveLength(2);
  });
  it('refuses a cursor that is not a number and a collection it does not have', async () => {
    expect((await j(await fetch(`${base}/sync?since=abc`))).body.error.code).toBe('bad_cursor');
    expect((await j(await fetch(`${base}/sync?collections=jobs,calendars`))).body.error.code).toBe('unknown_collection');
  });
});

describe('/stream', () => {
  it('says hello, then sends a job the moment it changes, as its current view', async () => {
    let id = '';
    const msgs = await listen('/stream', (m) => changes(m).some((x) => x.data.id === id), () => { id = createJob({ kind: 'background', title: 'Read the rules' }).job.id; });
    expect(msgs[0]).toMatchObject({ event: 'hello' });
    const c = changes(msgs).find((x) => x.data.id === id)!;
    expect(c.data).toMatchObject({ entity: 'job', op: 'upsert', data: { id, title: 'Read the rules' } });
    expect(Number(c.id)).toBe(c.data.seq);
  });
  it('a reconnect with Last-Event-ID gets exactly what it missed, and nothing it already had', async () => {
    const a = createJob({ kind: 'background', title: 'A' });
    const seen = headSeq();
    const b = createJob({ kind: 'background', title: 'B' });
    const msgs = await listen('/stream', (m) => changes(m).length >= 1, undefined, { 'last-event-id': String(seen) }, 2500);
    const ids = changes(msgs).map((x) => x.data.id);
    expect(ids).toContain(b.job.id);
    expect(ids).not.toContain(a.job.id);
  });
  it('several changes to one job in one batch arrive as one message with its latest state', async () => {
    const from = headSeq();
    const a = createJob({ kind: 'background', title: 'Busy' }, { trigger: 'first' });
    claimTry(a.try!.id, {});
    endTry(a.try!.id, { reason: 'done', outcome: 'changed', summary: 'ok' });
    const msgs = await listen(`/stream?cursor=${from}`, (m) => changes(m).length >= 1, undefined, {}, 2500);
    const forA = changes(msgs).filter((x) => x.data.id === a.job.id);
    expect(forA).toHaveLength(1);
    expect(forA[0].data.data.status.state).toBe('done');
  });
  it('device changes reach an admin but not a phone', async () => {
    const from = headSeq();
    recordEvent({ entity: 'device', id: 'dev_x', payload: { name: 'Tablet' } });
    createJob({ kind: 'background', title: 'Visible' });
    who = PHONE;
    const phone = await listen(`/stream?cursor=${from}`, (m) => changes(m).some((x) => x.data.entity === 'job'), undefined, {}, 2500);
    // (A10: a job change is also followed by the coarse 'today' notice, which carries no data)
    expect(changes(phone).map((x) => x.data.entity).filter((e) => e !== 'today')).toEqual(['job']);
    who = ADMIN;
    const admin = await listen(`/stream?cursor=${from}`, (m) => changes(m).length >= 2, undefined, {}, 2500);
    expect(changes(admin).map((x) => x.data.entity).filter((e) => e !== 'today').sort()).toEqual(['device', 'job']);
  });
  it('forwards a running job\'s progress, at most once a second per run', async () => {
    const session = `job_live_${Date.now()}`;
    liveRuns.start(session, 'read');
    try {
      const msgs = await listen('/stream', (m) => m.some((x) => x.event === 'live'), () => {
        liveRuns.record(session, 'step', { text: 'Reading pages 25–76' });
        liveRuns.record(session, 'step', { text: 'too soon, dropped' });
      }, {}, 3000);
      const live = msgs.filter((m) => m.event === 'live');
      expect(live).toHaveLength(1);
      expect(live[0].data).toMatchObject({ session, type: 'step', stage: { text: 'Reading pages 25–76' } });
    } finally { liveRuns.finish(session); }
  });
  it('a cursor that is too old is told to reset', async () => {
    createJob({ kind: 'background', title: 'x' });
    createJob({ kind: 'background', title: 'y' });
    appDb().prepare('UPDATE events SET ts = 0').run();
    trimEvents();
    const msgs = await listen('/stream?cursor=1', (m) => m.some((x) => x.event === 'reset'), undefined, {}, 2500);
    expect(msgs.find((m) => m.event === 'reset')!.data.cursor).toBe(headSeq());
  });
  it('a non-numeric Last-Event-ID is a 400, and a stranger cannot open the stream', async () => {
    expect((await fetch(`${base}/stream`, { headers: { 'last-event-id': 'abc' } })).status).toBe(400);
    who = null as unknown as Caller;
    expect((await fetch(`${base}/stream`)).status).toBe(401);
  });
});
