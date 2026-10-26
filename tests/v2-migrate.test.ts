// v2 slice A3a: `mwa migrate-v2` — existing goals, scheduled tasks (resumes included) and job results become Jobs and
// Tries. Lossless (the store and the log files are untouched), idempotent (a second run changes nothing), and a dry
// run reports exactly what a real run does without writing. Fixtures are real engrams in a real memory store.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MwaMemory } from '../src/awm.js';
import { appDb, resetAppDb } from '../src/v2/db.js';
import { migrateV2, migrateV2Once, describeReport, DATA_MIGRATION } from '../src/v2/migrate.js';
import { listJobs, triesOf, viewJob } from '../src/v2/jobs.js';

const dir = mkdtempSync(join(tmpdir(), 'mwa-migrate-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const DAY = 86_400_000;
const T0 = 1_790_000_000_000;

async function fixtures() {
  const mem = new MwaMemory('migrate-test', join(dir, 'm.db'));
  // goals: one in progress (handed off, ran out of room, a resume is pending), one done, one paused
  const goalA = (await mem.addGoal('Learn the USEF eventing rules', 'Read the rules PDF and write study notes', 'medium', 'p1'))!;
  await mem.setGoalStatus(goalA, 'in_progress');
  const gA = (await mem.getGoal(goalA))!;
  await mem.setGoalRecord(gA, { state: 'Read 40 of 73 pages; notes in rules-notes.md', next: 'Read pages 41-73', by: 'note' });
  const goalB = (await mem.addGoal('Draft the board briefing', '', 'medium', 'p1'))!;
  await mem.setGoalStatus(goalB, 'done');
  const goalC = (await mem.addGoal('Compare saddle fitters', '', 'low', 'p1'))!;
  await mem.setGoalStatus(goalC, 'blocked');
  // the hand-off's task for goal A: it fired (completed), then a resume of it is pending
  const handoff = (await mem.addScheduledTask('The person asked for this in a chat… read the rules', T0, { notify: 'web-rules', dir: join(dir, 'web-rules'), person: 'p1', goal: goalA, request: 'Learn the rules' }))!;
  await mem.completeScheduled(handoff);
  const resume = (await mem.addScheduledTask('Resume and finish this task — an earlier attempt ran out of time before completing it (resume 1 of 2).\n\nTHE TASK: read the rules', T0 + 60_000,
    { notify: 'web-rules', person: 'p1', goal: goalA, resumeAttempt: 1, resumeOf: handoff }))!;
  // a recurring watch that has fired twice, a one-off due tomorrow, a reminder, and an orphaned resume
  const watch = (await mem.addScheduledTask('Check the price of roses at the florist', T0 + DAY, { recur: 'daily:09:00', person: 'p1', notify: 'web-roses', request: 'Tell me when roses get cheaper', deliver: 'changed' }))!;
  const oneOff = (await mem.addScheduledTask('Email the farrier about Thursday', T0 + DAY, { person: 'p1', notify: 'web-farrier' }))!;
  const reminder = (await mem.addScheduledTask('Sign the permission slip', T0 + DAY, { person: 'p1', kind: 'reminder' }))!;
  const orphan = (await mem.addScheduledTask('Resume and finish this task — an earlier attempt ran out of time (resume 1 of 2).\n\nTHE TASK: something long gone', T0, { resumeAttempt: 1, resumeOf: 'deadbeef', person: 'p1' }))!;

  const notifyFile = join(dir, 'notifications.jsonl');
  const runsFile = join(dir, 'runs.jsonl');
  const n = (o: Record<string, unknown>) => JSON.stringify(o);
  writeFileSync(notifyFile, [
    n({ ts: T0 + 120_000, instruction: 'The person asked for this in a chat… read the rules', summary: 'I ran out of room after 40 pages.', reason: 'budget', outcome: 'could-not', steps: 60, toolCalls: 58, costUsd: 0.11, durationMs: 115_000, job: handoff, fire: `${handoff.slice(0, 8)}-${T0 + 120_000}`, title: 'Learn the USEF eventing rules', session: 'web-rules' }),
    n({ ts: T0 + 3_000, instruction: 'Check the price of roses at the florist', summary: 'Roses are $1.10 a stem.', reason: 'done', outcome: 'changed', steps: 5, toolCalls: 4, costUsd: 0.02, durationMs: 3_000, job: watch, fire: `${watch.slice(0, 8)}-${T0 + 3_000}` }),
    n({ ts: T0 + DAY + 4_000, instruction: 'Check the price of roses at the florist', summary: 'Roses went up to $1.45 a stem.', reason: 'done', outcome: 'changed', steps: 6, toolCalls: 5, costUsd: 0.03, durationMs: 4_000, job: watch, fire: `${watch.slice(0, 8)}-${T0 + DAY + 4_000}` }),
    n({ ts: T0 + 5_000, instruction: 'Look up the ferry times', summary: 'The 8:40 still runs.', reason: 'done', outcome: 'changed', costUsd: 0.01, job: 'gone1234-0000-0000-0000-000000000000', fire: `gone1234-${T0 + 5_000}` }),
    n({ ts: T0 + 6_000, instruction: '📥 Inbox · a newsletter', summary: 'Saved two facts.', reason: 'done', outcome: 'changed' }), // no job: not a Try
  ].join('\n') + '\n');
  writeFileSync(runsFile, [
    n({ ts: T0 + 5_000, job: handoff, instruction: 'The person asked for this in a chat… read the rules', reason: 'budget', outcome: 'could-not', steps: 60, toolCalls: 58, durationMs: 115_000, costUsd: 0.11, pagesRead: 40 }),
    n({ ts: T0, job: watch, instruction: 'Check the price of roses at the florist', reason: 'done', outcome: 'changed', durationMs: 3_000, costUsd: 0.02, pagesRead: 1 }),
    n({ ts: T0 + DAY, job: watch, instruction: 'Check the price of roses at the florist', reason: 'done', outcome: 'changed', durationMs: 4_000, costUsd: 0.03, pagesRead: 2 }),
    n({ ts: T0 + 2 * DAY, session: 'web-x', instruction: 'unrelated chat', reason: 'done' }),
  ].join('\n') + '\n');
  return { mem, notifyFile, runsFile, ids: { goalA, goalB, goalC, handoff, resume, watch, oneOff, reminder, orphan } };
}

const snapshot = async (mem: MwaMemory, files: string[]) => JSON.stringify({
  goals: await mem.listGoals(), records: (await mem.listGoalRecords()).map((r) => ({ ...r })), pending: await mem.pendingScheduled(),
  files: files.map((f) => readFileSync(f, 'utf8')),
});
const counts = () => {
  const d = appDb();
  const c = (t: string) => (d.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n;
  return { jobs: c('jobs'), tries: c('tries'), events: c('events') };
};

describe('migrate-v2', () => {
  it('maps goals, tasks, resumes and results losslessly; a dry run reports the same counts and writes nothing; a second run is a no-op', async () => {
    const { mem, notifyFile, runsFile, ids } = await fixtures();
    try {
      resetAppDb(':memory:'); // the fixtures' own store hooks wrote Jobs; start from an app.db that has never seen them
      const before = await snapshot(mem, [notifyFile, runsFile]);

      const dry = await migrateV2(mem, { notifyFile, runsFile, dryRun: true });
      expect(counts()).toMatchObject({ jobs: 0, tries: 0 }); // nothing written
      expect(appDb().prepare('SELECT 1 FROM migrations WHERE name = ?').get(DATA_MIGRATION)).toBeUndefined();
      console.log(`dry run on the fixtures:\n${describeReport(dry)}`);

      const real = await migrateV2Once(mem, { notifyFile, runsFile });
      expect({ ...real!, dryRun: true }).toEqual(dry); // the dry run said exactly what the real run did
      expect(real!.jobs).toEqual({ goals: 3, recurring: 1, reminders: 1, oneOff: 1, fromResults: 1, orphanResumes: 1 });
      expect(real!.tries).toEqual({ ended: 4, enriched: 3, queued: 2, resumes: 2, fromGoalStatus: 2 });
      expect(real!.ignoredLines).toBe(1);
      expect(real!.orphans.map((o) => [o.kind, o.id])).toEqual([['result', 'gone1234-0000-0000-0000-000000000000'], ['resume', ids.orphan]]);
      expect(counts()).toMatchObject({ jobs: 8, tries: 10 });

      // lossless: the store and the files are exactly as they were
      expect(await snapshot(mem, [notifyFile, runsFile])).toBe(before);

      // what came out
      const jobs = listJobs();
      const byGoal = (g: string) => jobs.find((j) => j.legacy_goal_id === g)!;
      const view = (j: (typeof jobs)[number]) => viewJob(j, { running: new Set(), pending: new Set(), now: T0 });
      const a = byGoal(ids.goalA);
      expect(triesOf(a.id).map((t) => [t.trigger, t.state, t.reason, t.pages_read])).toEqual([['first', 'ended', 'budget', 40], ['auto-continue', 'queued', null, null]]);
      expect(view(a).status.state).toBe('continuing'); // ran out of room, a resume waits: continuing, never failed
      expect(a.where_it_stands).toMatch(/Read 40 of 73 pages/);
      expect(view(byGoal(ids.goalB)).status.state).toBe('done');
      expect(view(byGoal(ids.goalC)).status.state).toBe('partly_done');
      const watch = jobs.find((j) => j.schedule_id === ids.watch)!;
      expect(watch.kind).toBe('recurring');
      expect(triesOf(watch.id).map((t) => [t.trigger, t.summary, t.pages_read])).toEqual([['fire', 'Roses are $1.10 a stem.', 1], ['fire', 'Roses went up to $1.45 a stem.', 2]]);
      expect(jobs.find((j) => j.schedule_id === ids.oneOff)).toMatchObject({ kind: 'background', session: 'web-farrier' });
      expect(view(jobs.find((j) => j.schedule_id === ids.oneOff)!).status.state).toBe('scheduled');
      expect(jobs.find((j) => j.schedule_id === ids.reminder)).toMatchObject({ kind: 'reminder' });

      // idempotent: a second run (the CLI, or a start after the marker was lost) changes nothing
      const events = counts();
      const again = await migrateV2(mem, { notifyFile, runsFile });
      expect(again.jobs).toEqual({ goals: 0, recurring: 0, reminders: 0, oneOff: 0, fromResults: 0, orphanResumes: 0 });
      expect(again.tries).toEqual({ ended: 0, enriched: 0, queued: 0, resumes: 0, fromGoalStatus: 0 });
      expect(again.skipped).toBeGreaterThanOrEqual(8);
      expect(counts()).toEqual(events);
      expect(await migrateV2Once(mem, { notifyFile, runsFile })).toBe(null); // recorded: the start-up run does not repeat
    } finally { mem.close(); }
  }, 120_000);
});
