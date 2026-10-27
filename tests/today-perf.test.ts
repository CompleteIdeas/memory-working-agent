// v2 build, slice A10: Today must stay fast on a lived-in app.db — 2,000 calendar events, 200 jobs with their tries,
// 10,000 mail headers and 500 Important items, in a real file (WAL) rather than in memory. p95 of GET /today, over
// HTTP, must stay under 150 ms (run alone: `npm run test:perf`). The numbers are printed so a regression shows before it fails. The seed is a stress
// case: 125 events a day overlap into about 14,000 double-booked pairs, and Today still finds the next one in time.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV1 } from '../src/api/router.js';
import { v1Routes } from '../src/api/v1.js';
import { ALL_SCOPES, type Caller } from '../src/api/auth.js';
import { appDb, resetAppDb } from '../src/v2/db.js';
import { upsertCalEvent, createDraft } from '../src/v2/calendar.js';
import { setSyncState } from '../src/v2/sync-state.js';
import { setCalendarSyncDeps } from '../src/sync/calendar.js';
import { setMailProviders } from '../src/sync/mail.js';
import '../src/v2/mail.js'; // its tables
import { createJob, claimTry, endTry } from '../src/v2/jobs.js';
import { upsertItem } from '../src/v2/important.js';
import { setTriageDeps } from '../src/v2/triage.js';
import { setTodayDeps, buildToday } from '../src/v2/today.js';
import { recordAction } from '../src/v2/actions.js';
import { zonedToUtc, iso } from '../src/sync/tz.js';

const TZ = 'America/New_York';
const NOW = zonedToUtc('2026-11-09T09:10', TZ);
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const ACCT = 'google:me@example.com';
const OWNER: Caller = { kind: 'session', id: 'session', scopes: new Set(ALL_SCOPES), viaCookie: true };
const P95_MS = 150;
/**
 * The 150 ms target is asserted when this file runs on its own (`npm run test:perf`, or MWA_PERF_STRICT=1): inside the
 * full suite, ~150 files share the CPU in parallel and latency measures the machine, not Today (timing tests elsewhere
 * in the suite fail the same way under that load). There, a 2 s ceiling still catches a pathological regression
 * (a busy suite run measured a 3–10× slowdown).
 */
const STRICT = process.env.MWA_PERF_STRICT === '1' || process.env.npm_lifecycle_event === 'test:perf';
const LIMIT_MS = STRICT ? P95_MS : 2_000;

let dir = '', server: Server, base = '';
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mwa-a10-perf-'));
  process.env.MWA_RUNLOG = join(dir, 'runs.jsonl');
  process.env.MWA_TOKEN_LOG = join(dir, 'tokens.jsonl');
  resetAppDb(join(dir, 'app.db'));
  appDb();
  const t0 = performance.now();
  // 2,000 calendar events across the 16-day window (some today, some overlapping), plus 40 helper drafts
  const d = appDb();
  d.transaction(() => {
    for (let i = 0; i < 2_000; i++) {
      const s = NOW - DAY + (i % 16) * DAY + ((i * 37) % 14) * HOUR - 6 * HOUR;
      upsertCalEvent(ACCT, 'google', { provider_id: `ev${i}`, start_utc: iso(s), end_utc: iso(s + (30 + (i % 4) * 30) * MIN), all_day: i % 50 === 0, title: `Event ${i}` });
    }
  })();
  for (let i = 0; i < 40; i++) createDraft({ title: `Draft ${i}`, startMs: NOW + i * HOUR, endMs: NOW + i * HOUR + HOUR, allDay: false, origin: 'helper' });
  // 200 jobs: done (some with pages), waiting at the dollar limit, running, stopped; several tries each
  for (let i = 0; i < 200; i++) {
    const j = createJob({ kind: i % 20 === 0 ? 'recurring' : 'background', title: `Job ${i}`, request: `Do job ${i}`, capUsd: 0.5 }, { trigger: 'first' });
    for (let k = 0; k < 1 + (i % 3); k++) {
      const tr = k === 0 ? j.try! : (await import('../src/v2/jobs.js')).addTry(j.job.id, { trigger: 'continue' });
      if (i % 10 === 9 && k === i % 3) break; // left queued
      claimTry(tr.id, { now: NOW - (i % 9) * DAY - HOUR });
      endTry(tr.id, { reason: i % 7 === 0 ? 'budget' : 'done', outcome: i % 11 === 0 ? 'could-not' : 'changed', summary: `Run ${k} of job ${i}.`, endedAt: NOW - (i % 9) * DAY - 30 * MIN + k * MIN,
        ...(i % 5 === 0 ? { progress: { done: 40, total: i % 7 === 0 ? 73 : 40, unit: 'pages' } } : {}), ...(i % 13 === 0 ? { capHit: 'usd' } : {}) });
    }
  }
  // 10,000 mail headers (inserted directly: the sync's path is tested elsewhere, and this file must not hog the CPU the
  // rest of the suite shares)
  const ins = d.prepare(`INSERT INTO mail_headers (account, provider, provider_id, thread_id, from_name, from_addr, subject, snippet, received_at, unread, labels, list_id, has_unsub, msg_key, updated_seq)
    VALUES ('google:me@example.com', 'gmail', ?, ?, ?, ?, ?, ?, ?, ?, '["INBOX"]', ?, ?, ?, 0)`);
  d.transaction(() => {
    for (let i = 0; i < 10_000; i++) {
      ins.run(`m${i}`, `t${i}`, `Sender ${i % 300}`, `s${i % 300}@example.com`, `Subject ${i}`, `Snippet ${i}`, NOW - (i % 14) * DAY - (i % 24) * HOUR, i % 3 === 0 ? 1 : 0,
        i % 4 === 0 ? `list${i % 20}.example` : null, i % 4 === 0 ? 1 : 0, `k${i}`);
    }
  })();
  // 500 Important items from every source
  d.transaction(() => {
    const sources = ['mail', 'newsletter', 'calendar-conflict', 'job-result', 'approval', 'connection', 'deadline'] as const;
    for (let i = 0; i < 500; i++) {
      upsertItem({ source: sources[i % sources.length], dedupeKey: `perf:${i}`, ts: NOW - i * 30 * MIN, from: `From ${i}`, title: `Item ${i}`, why: `Why ${i}`, trust: 'untrusted',
        ...(i % 25 === 0 ? { caution: 'phishing' as const } : {}) }, TZ, NOW, d);
    }
  })();
  const seeded = performance.now() - t0;
  const counts = Object.fromEntries(['cal_events', 'jobs', 'tries', 'mail_headers', 'items', 'events'].map((t) => [t, (d.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n]));
  console.log(`[today perf] seeded in ${Math.round(seeded)} ms: ${JSON.stringify(counts)}`);
  expect(counts).toMatchObject({ cal_events: 2_000, jobs: 200, mail_headers: 10_000, items: 500 });

  setCalendarSyncDeps({ connected: (p) => p === 'google', accountKey: () => ACCT, now: () => NOW, tz: () => TZ });
  setSyncState(ACCT, 'calendar', { last_ok: NOW - 5 * MIN });
  setMailProviders(() => []);
  setTriageDeps({ now: () => NOW, tz: () => TZ, pendingApprovals: () => [] });
  // 300 logged actions (one app.db row each), across the last week
  d.transaction(() => { for (let i = 0; i < 300; i++) recordAction({ tool: i % 2 ? 'draft_email' : 'write_file', ts: NOW - i * 40 * MIN, person: i % 7 ? null : 'tg-1' }); })();
  setTodayDeps({
    now: () => NOW, tz: () => TZ, running: () => new Set(), greetingName: () => 'Robert', month: () => ({ usedUsd: 4.2, limitUsd: 20, state: 'ok' }),
    pendingApprovals: () => Array.from({ length: 5 }, (_, i) => ({ id: `ap${i}`, tool: 'write_file', summary: `Save file ${i}`, expiresInSec: 600, expiresAt: NOW + 600_000, tainted: false, readLocal: false, kind: 'tool' as const, createdAt: NOW - i * HOUR })),
  });
  const v1 = createV1(v1Routes(), { authenticate: () => OWNER, sameOrigin: () => true });
  server = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
}, 120_000);

afterAll(() => {
  server?.close(); setTodayDeps(null); setCalendarSyncDeps(null); setMailProviders(null); setTriageDeps(null);
  resetAppDb(':memory:');
  delete process.env.MWA_RUNLOG; delete process.env.MWA_TOKEN_LOG;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* WAL files still closing on Windows */ }
});

describe('Today on a seeded app.db', () => {
  // one retry: the full suite runs files in parallel, and a busy machine is not a regression
  it(`GET /today: p95 under ${P95_MS} ms (2k events, 200 jobs, 10k mail headers, 500 items)`, { timeout: 120_000, retry: 1 }, async () => {
    const doc = await buildToday('session'); // warm: prepared statements, the action log
    expect(doc.nextUp.length).toBeGreaterThan(0);
    expect(doc.needsYou.length).toBeGreaterThan(1);
    expect(doc.worthALook).toHaveLength(3);
    expect(doc.agenda.length).toBeGreaterThan(50);
    for (let i = 0; i < 5; i++) await (await fetch(`${base}/today`)).json();
    const http: number[] = [], direct: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      const r = await fetch(`${base}/today`);
      await r.json();
      http.push(performance.now() - t0);
      expect(r.status).toBe(200);
      const t1 = performance.now();
      await buildToday('session');
      direct.push(performance.now() - t1);
    }
    const line = (xs: number[]) => `p50 ${pct(xs, 50).toFixed(1)} ms · p95 ${pct(xs, 95).toFixed(1)} ms · max ${Math.max(...xs).toFixed(1)} ms`;
    console.log(`[today perf] GET /today over HTTP: ${line(http)} (limit ${LIMIT_MS} ms)`);
    console.log(`[today perf] buildToday direct:   ${line(direct)}`);
    expect(pct(http, 95)).toBeLessThan(LIMIT_MS);
  });

  it(`after every calendar change (nothing memoised for the double-bookings): p95 under ${P95_MS} ms`, { timeout: 120_000, retry: 1 }, async () => {
    const http: number[] = [];
    for (let i = 0; i < 30; i++) {
      upsertCalEvent(ACCT, 'google', { provider_id: 'ev7', start_utc: iso(NOW + HOUR), end_utc: iso(NOW + HOUR + (30 + i) * MIN), all_day: false, title: `Moved ${i}` });
      const t0 = performance.now();
      const r = await fetch(`${base}/today`);
      await r.json();
      http.push(performance.now() - t0);
    }
    console.log(`[today perf] GET /today after a calendar change: p50 ${pct(http, 50).toFixed(1)} ms · p95 ${pct(http, 95).toFixed(1)} ms · max ${Math.max(...http).toFixed(1)} ms`);
    expect(pct(http, 95)).toBeLessThan(LIMIT_MS);
  });
});
