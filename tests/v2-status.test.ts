// v2 slice A3a: a Job's status is a pure function of its Tries — the truth table, first match wins.
// The baseline findings it fixes: SR-F02 (FAILED while a continuation ran), SR-F05 (no Continue after a budget end),
// SR-F16 (DONE while incomplete), SR-F03 (a result arrived silently: "result ready" until opened).
import { describe, it, expect } from 'vitest';
import { jobStatus, money, type StatusTry, type StatusJob, type JobState } from '../src/v2/status.js';

const T = (n: number, o: Partial<StatusTry>): StatusTry => ({ n, trigger: n === 1 ? 'first' : 'auto-continue', state: 'ended', ended_at: 1000 + n, ...o });
const bg: StatusJob = { kind: 'background', status: 'active', seen_at: null };
const ctx = { running: new Set<string>(), pendingApprovals: 0, now: 10_000 };

type Row = { name: string; job?: Partial<StatusJob>; tries: StatusTry[]; ctx?: Partial<typeof ctx>; state: JobState; label: string; detail: RegExp; action?: string; actionLabel?: string; ready?: boolean };
const rows: Row[] = [
  // 1. working
  { name: 'a running Try', tries: [T(1, { state: 'running', live_key: 'job_a' })], state: 'working', label: 'Working', detail: /Working on it now/, action: 'stop' },
  { name: 'a queued Try whose run is live in this process', tries: [T(1, { state: 'queued', live_key: 'job_b', trigger: 'first', due_at: 99_999 })], ctx: { running: new Set(['job_b']) }, state: 'working', label: 'Working', detail: /Working on it/, action: 'stop' },
  { name: 'the person\'s Continue, due now', tries: [T(1, { reason: 'stopped' }), T(2, { state: 'queued', trigger: 'continue', due_at: 5_000 })], state: 'working', label: 'Working', detail: /Starting now/, action: 'stop' },
  { name: 'running beats a pending approval', tries: [T(1, { state: 'running' })], ctx: { pendingApprovals: 2 }, state: 'working', label: 'Working', detail: /Working/ },
  { name: 'running shows how far the last Try got', tries: [T(1, { reason: 'budget', progress_done: 3, progress_total: 5, progress_unit: 'stories' }), T(2, { state: 'running' })], state: 'working', label: 'Working', detail: /3 of 5 stories done so far/ },
  // 2. waiting for you
  { name: 'an approval a Try staged', tries: [T(1, { reason: 'done', outcome: 'blocked' })], ctx: { pendingApprovals: 1 }, state: 'waiting', label: 'Waiting for you', detail: /needs your OK/, action: 'review', actionLabel: 'Review' },
  { name: 'the dollar limit (N06: 63 of 73 pages at 15¢, about 3¢ more)', job: { cap_usd: 0.15 }, tries: [T(1, { reason: 'budget', cap_hit: 'usd', progress_done: 63, progress_total: 73, progress_unit: 'pages', est_usd: 0.03 })],
    state: 'waiting', label: 'Waiting for you', detail: /^It reached the 15¢ limit you set\. Finish the last 10 pages\? About 3¢\.$/, action: 'continue', actionLabel: 'Finish the last 10 pages' },
  { name: 'the dollar limit beats a queued continuation', job: { cap_usd: 0.15 }, tries: [T(1, { reason: 'budget', cap_hit: 'usd' }), T(2, { state: 'queued', due_at: 99_999 })], state: 'waiting', label: 'Waiting for you', detail: /15¢ limit/, action: 'continue', actionLabel: 'Finish the rest' },
  // 3. continuing — never failed
  { name: 'budget + queued auto-continue = continuing, never failed', tries: [T(1, { reason: 'budget', outcome: 'could-not', cap_hit: 'steps' }), T(2, { state: 'queued', trigger: 'auto-continue', due_at: 70_000 })],
    state: 'continuing', label: 'Continuing', detail: /ran out of room, so it's picking up where it left off/, action: 'stop' },
  { name: 'stuck + could-not + queued auto-continue is still continuing', tries: [T(1, { reason: 'stuck', outcome: 'could-not' }), T(2, { state: 'queued', trigger: 'auto-continue', due_at: 70_000 })], state: 'continuing', label: 'Continuing', detail: /picking up/ },
  { name: 'continuing says how far it got', tries: [T(1, { reason: 'budget', progress_done: 40, progress_total: 73, progress_unit: 'pages' }), T(2, { state: 'queued', trigger: 'auto-continue', due_at: 70_000 })], state: 'continuing', label: 'Continuing', detail: /after 40 of 73 pages/ },
  { name: 'a resume after a restart', tries: [T(1, { reason: 'error', outcome: 'could-not' }), T(2, { state: 'queued', trigger: 'resume-after-restart', due_at: 70_000 })], state: 'continuing', label: 'Continuing', detail: /A restart cut it off/ },
  // 4. stopped by you
  { name: 'the person\'s Stop (N06: kept 3 stories)', tries: [T(1, { reason: 'stopped', progress_done: 3, progress_total: 5, progress_unit: 'stories' })], state: 'stopped_by_you', label: 'Stopped by you', detail: /^Kept 3 stories\.$/, action: 'continue', actionLabel: 'Continue' },
  { name: 'stopped before it made progress', tries: [T(1, { reason: 'stopped' })], state: 'stopped_by_you', label: 'Stopped by you', detail: /Kept what it had/, action: 'continue' },
  { name: 'a paused recurring job', job: { kind: 'recurring', status: 'paused' }, tries: [T(1, { trigger: 'fire', reason: 'done', outcome: 'changed' })], state: 'stopped_by_you', label: 'Paused', detail: /until you resume/, action: 'resume' },
  { name: 'a cancelled recurring job', job: { kind: 'recurring', status: 'cancelled' }, tries: [T(1, { trigger: 'fire', reason: 'done', outcome: 'changed' })], state: 'stopped_by_you', label: 'Stopped by you', detail: /will not run again/ },
  // 5. partly done
  { name: 'done but remaining = partly done', tries: [T(1, { reason: 'done', outcome: 'changed', remaining: 'pages 64-73 of the rules', summary: 'I read the first 63 pages.' })],
    state: 'partly_done', label: 'Partly done', detail: /Still to do: pages 64-73 of the rules\./, action: 'continue', actionLabel: 'Finish the rest' },
  { name: 'done but progress short of its total', tries: [T(1, { reason: 'done', outcome: 'changed', progress_done: 63, progress_total: 73, progress_unit: 'pages' })], state: 'partly_done', label: 'Partly done', detail: /^Got through 63 of 73 pages\.$/, action: 'continue', actionLabel: 'Finish the last 10 pages' },
  { name: 'budget with no continuation left (SR-F05: Continue offered)', tries: [T(1, { reason: 'budget' }), T(2, { reason: 'budget' }), T(3, { reason: 'budget', outcome: 'could-not' })], state: 'partly_done', label: 'Partly done', detail: /ran out of room before it finished/, action: 'continue' },
  { name: 'partly done beats could-not when it got somewhere', tries: [T(1, { reason: 'done', outcome: 'could-not', progress_done: 2, progress_total: 5, progress_unit: 'items' })], state: 'partly_done', label: 'Partly done', detail: /2 of 5 items/ },
  // 6. stopped (could not)
  { name: 'could-not and no progress', tries: [T(1, { reason: 'done', outcome: 'could-not', summary: 'The site was down all morning. I tried twice.' })], state: 'stopped', label: 'Stopped', detail: /^It couldn't finish: The site was down all morning\.$/, action: 'start-over', actionLabel: 'Try again' },
  // scheduled
  { name: 'a recurring job that has not run yet', job: { kind: 'recurring' }, tries: [], state: 'scheduled', label: 'Scheduled', detail: /has not run yet/ },
  { name: 'a one-off due tomorrow', tries: [T(1, { state: 'queued', due_at: 86_400_000 })].map((t) => ({ ...t, trigger: 'first' })), state: 'scheduled', label: 'Scheduled', detail: /Not started yet/ },
  // 7. done
  { name: 'done, not opened = result ready', tries: [T(1, { reason: 'done', outcome: 'changed', summary: 'Your eventing notes are ready. They cite pages.' })], state: 'done', label: 'Result ready', detail: /^Your eventing notes are ready\.$/, action: 'open', ready: true },
  { name: 'done and opened', job: { seen_at: 5_000 }, tries: [T(1, { reason: 'done', outcome: 'changed' })], state: 'done', label: 'Done', detail: /Finished/, action: 'open', ready: false },
  { name: 'opened before a newer Try ended = result ready again', job: { seen_at: 1001 }, tries: [T(1, { reason: 'done', outcome: 'changed' }), T(2, { trigger: 'continue', reason: 'done', outcome: 'changed', ended_at: 2000 })], state: 'done', label: 'Result ready', detail: /Finished/, ready: true },
  { name: 'after two auto-continues the last one finished: done (SR-F16 the other way)', tries: [T(1, { reason: 'budget' }), T(2, { reason: 'budget' }), T(3, { reason: 'done', outcome: 'changed' })], state: 'done', label: 'Result ready', detail: /Finished/, ready: true },
  { name: 'a recurring job between fires is scheduled, with what its last fire said (no-change is not failed)', tries: [T(1, { trigger: 'fire', reason: 'done', outcome: 'no-change', summary: 'Checked: nothing new.' })], job: { kind: 'recurring' }, state: 'scheduled', label: 'Result ready', detail: /^Last run: Checked: nothing new\.$/ },
];

describe('jobStatus truth table (first match wins)', () => {
  for (const r of rows) {
    it(r.name, () => {
      const s = jobStatus({ ...bg, ...r.job }, r.tries, { ...ctx, ...r.ctx });
      expect(s.state).toBe(r.state);
      expect(s.label).toBe(r.label);
      expect(s.detail).toMatch(r.detail);
      if (r.action) expect(s.primaryAction?.action).toBe(r.action);
      if (r.actionLabel) expect(s.primaryAction?.label).toBe(r.actionLabel);
      if (r.ready !== undefined) expect(s.resultReady).toBe(r.ready);
    });
  }
  it('never answers "failed" for a run that is continuing: no state or label says failed', () => {
    for (const r of rows) {
      const s = jobStatus({ ...bg, ...r.job }, r.tries, { ...ctx, ...r.ctx });
      expect(`${s.state} ${s.label} ${s.detail}`).not.toMatch(/fail/i);
    }
  });
  it('the order of tries in the input does not matter (n decides)', () => {
    const tries = [T(2, { state: 'queued', trigger: 'auto-continue', due_at: 70_000 }), T(1, { reason: 'budget' })];
    expect(jobStatus(bg, tries, ctx).state).toBe('continuing');
  });
  it('covers all eight states', () => {
    expect(new Set(rows.map((r) => r.state))).toEqual(new Set(['working', 'waiting', 'continuing', 'stopped_by_you', 'partly_done', 'stopped', 'scheduled', 'done']));
  });
  it('money reads as the prototype does', () => {
    expect([money(0.15), money(0.03), money(1.2), money(0.004)]).toEqual(['15¢', '3¢', '$1.20', '0¢']);
  });
});
