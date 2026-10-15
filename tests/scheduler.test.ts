import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { backoffDelay, tickScheduler } from '../src/scheduler.js';
import { sameTask, SCHEDULE_TOOL } from '../src/agent.js';

describe('scheduler backoff', () => {
  it('uses the base interval when healthy', () => {
    expect(backoffDelay(60_000, 0)).toBe(60_000);
  });
  it('doubles with consecutive failures', () => {
    expect(backoffDelay(60_000, 1)).toBe(120_000);
    expect(backoffDelay(60_000, 2)).toBe(240_000);
    expect(backoffDelay(60_000, 3)).toBe(480_000);
  });
  it('caps at 30 minutes', () => {
    expect(backoffDelay(60_000, 10)).toBe(30 * 60_000);
    expect(backoffDelay(60_000, 99)).toBe(30 * 60_000);
  });
});

/**
 * A scheduled run must act AS the task's owner (2026-10-13).
 *
 * Without personId the run is the shared `unknown` profile, which breaks both directions at once:
 * a task owned by tg-1000000001 is invisible to its own run (so a recurring task cannot cancel
 * itself once the thing it polls for has happened), and anything that run schedules is tagged
 * person=unknown and becomes visible to every shared-profile session. Neither failure is loud.
 */
describe('scheduler: a fired task runs as whoever scheduled it', () => {
  const fakeMemory = (task: Record<string, unknown>) => ({
    async pendingScheduled() { return [task]; },
    async completeScheduled() { /* */ },
    async rescheduleTask() { /* */ },
    async setScheduledSignature() { /* */ },
  }) as never;

  const fire = async (task: Record<string, unknown>) => {
    const outRoot = mkdtempSync(join(tmpdir(), 'mwa-sched-'));
    const seen: Record<string, unknown>[] = [];
    try {
      await tickScheduler({
        memory: fakeMemory(task), brain: {} as never, worker: {} as never, outRoot,
        now: () => 10_000, checksAllowed: false,
        onFire: async () => { /* */ },
        runAgent: (async (opts: Record<string, unknown>) => { seen.push(opts); return { summary: 'ok', reason: 'done' }; }) as never,
      });
    } finally { try { rmSync(outRoot, { recursive: true, force: true }); } catch { /* */ } }
    return seen;
  };

  it('passes the owner through to the run', async () => {
    const seen = await fire({ id: 'abc12345', instruction: 'poll the deploy', due: 1, person: 'tg-1000000001' });
    expect(seen).toHaveLength(1);
    expect(seen[0].personId).toBe('tg-1000000001');
    expect(seen[0].interactive).toBe(false); // unattended is unchanged — this is identity, not permission
  });

  it('passes the owner through on a RESUME too', async () => {
    // A resume is enqueued by the harness, not the person, so it is the easiest one to leave
    // unattributed — and a resumed run that schedules would then tag person=unknown.
    const seen = await fire({ id: 'res11111', instruction: 'Resume and finish this task', due: 1, person: 'tg-1000000001', resumeAttempt: 1 });
    expect(seen[0].personId).toBe('tg-1000000001');
    expect(seen[0].resumeAttempt).toBe(1);
  });

  it('leaves an untagged legacy task unattributed, which falls back to the shared profile', async () => {
    const seen = await fire({ id: 'def67890', instruction: 'a task from before person tagging', due: 1 });
    expect(seen[0].personId).toBeUndefined();
  });
});

/**
 * A fired task must be told the timing is already settled, and must be able to reach the folder it
 * was created in (2026-10-14, found by reading the container's own log).
 *
 * `schedule`'s instruction is whatever the model wrote at schedule time, and in practice it keeps
 * the user's scheduling language. A real fired run read its own stored "In 124 minutes, ... do not
 * do it now; just schedule it for later" and answered "the safest next step is to schedule it
 * again" — on a recurring task that is a loop that burns a model call every interval and never does
 * the work. A second real task stored an absolute path from the chat session's folder
 * (/data/mwa-workspace/serve/trial-...), fired into its own fresh folder, and refused itself:
 * "the path is currently outside what I'm allowed to access". Neither failed loudly; both logged
 * reason=done and showed "0 steps" in the UI.
 */
describe('scheduler: a fired task knows it is due now and can reach its origin folder', () => {
  const fakeMemory = (task: Record<string, unknown>) => ({
    async pendingScheduled() { return [task]; },
    async completeScheduled() { /* */ },
    async rescheduleTask() { /* */ },
    async setScheduledSignature() { /* */ },
  }) as never;

  /** Fire one task; return both what reached runAgent and what reached onFire. */
  const fire = async (task: Record<string, unknown>, result: Record<string, unknown> = {}) => {
    const outRoot = mkdtempSync(join(tmpdir(), 'mwa-sched-'));
    const seen: Record<string, unknown>[] = [];
    const fired: Record<string, unknown>[] = [];
    try {
      await tickScheduler({
        memory: fakeMemory(task), brain: {} as never, worker: {} as never, outRoot,
        now: () => 10_000, checksAllowed: false,
        onFire: async (_t, r) => { fired.push(r as unknown as Record<string, unknown>); },
        runAgent: (async (opts: Record<string, unknown>) => {
          seen.push(opts);
          return { summary: 'ok', reason: 'done', steps: 7, toolCalls: 5, costUsd: 0.0382, durationMs: 21_400, ...result };
        }) as never,
      });
    } finally { try { rmSync(outRoot, { recursive: true, force: true }); } catch { /* */ } }
    return { seen, fired };
  };

  it('tells a fresh fire that the task is due NOW', async () => {
    const { seen } = await fire({ id: 'due00001', instruction: 'In 124 minutes, write note-2.txt. Do not do it now; just schedule it for later.', due: 1 });
    expect(seen[0].dueNow).toBe(true);
  });

  it('does NOT override a resume, which carries its own "do only the remaining work" framing', async () => {
    const { seen } = await fire({ id: 'res22222', instruction: 'Resume and finish this task', due: 1, resumeAttempt: 2 });
    expect(seen[0].dueNow).toBe(false);
  });

  it('passes the origin folder as an extra allowed root so a baked-in absolute path resolves', async () => {
    // Inside the workspace (outRoot's parent — here the tmpdir that fire() creates outRoot in).
    const origin = resolve(tmpdir(), 'serve', 'trial-1791952944183-3');
    const { seen } = await fire({ id: 'org33333', instruction: `Write note-3.txt in ${origin}`, due: 1, origin });
    expect(seen[0].extraRoots).toEqual([origin]);
    // The working dir is still the task's OWN fresh folder — origin widens access, it does not
    // relocate the run (that is what `dir` does, and only a resume sets it).
    expect(String(seen[0].dir)).not.toBe(origin);
  });

  it('IGNORES an origin outside the workspace — `mwa run` passes the user cwd, not a sandbox', async () => {
    // An extra root bypasses even the Locked-down preset, so a folder the person merely ran a chat
    // from must not ride along into an unattended run.
    const { seen } = await fire({ id: 'cwd77777', instruction: 'tidy the project', due: 1, origin: resolve('/home/someone/projects/payroll') });
    expect(seen[0].extraRoots).toBeUndefined();
  });

  it('passes no extra roots for a task with no origin (every task stored before this fix)', async () => {
    const { seen } = await fire({ id: 'old44444', instruction: 'summarize my inbox', due: 1 });
    expect(seen[0].extraRoots).toBeUndefined();
  });

  it('reports what the run actually cost and did, so an autonomous run is not shown as "0 steps"', async () => {
    const { fired } = await fire({ id: 'vis55555', instruction: 'create a note file', due: 1 });
    expect(fired[0]).toMatchObject({ steps: 7, toolCalls: 5, costUsd: 0.0382, durationMs: 21_400, reason: 'done' });
  });

  it('still reports numbers (zeroed) when the run throws, rather than undefined', async () => {
    const outRoot = mkdtempSync(join(tmpdir(), 'mwa-sched-'));
    const fired: Record<string, unknown>[] = [];
    try {
      await tickScheduler({
        memory: fakeMemory({ id: 'err66666', instruction: 'boom', due: 1 }), brain: {} as never, worker: {} as never,
        outRoot, now: () => 10_000, checksAllowed: false,
        onFire: async (_t, r) => { fired.push(r as unknown as Record<string, unknown>); },
        runAgent: (async () => { throw new Error('provider down'); }) as never,
      });
    } finally { try { rmSync(outRoot, { recursive: true, force: true }); } catch { /* */ } }
    expect(fired[0].reason).toBe('error');
    expect(fired[0].steps).toBe(0);
    expect(fired[0].costUsd).toBe(0);
  });
});

/**
 * `sameTask` backs the guard that stops an unattended run re-creating its own task. It must be
 * fuzzy (a model paraphrases rather than repeating verbatim) without collapsing genuinely
 * different follow-up work into "that's the same thing".
 */
describe('sameTask — the self-reschedule guard predicate', () => {
  it('matches a paraphrase of the same task', () => {
    expect(sameTask(
      'In 124 minutes, write a file called note-2.txt saying check 2 ran',
      'write a file called note-2.txt saying check 2 ran',
    )).toBe(true);
  });

  it('matches the EXACT pair that was measured, scheduling filler and all', () => {
    // The real stored instruction from the 2026-10-14 container run, against the bare task a fired
    // run would re-schedule. On raw words this scored 0.5 and the guard did not fire.
    expect(sameTask(
      'In 124 minutes, write a file called note-2.txt saying check 2 ran. Do not do it now; just schedule it for later.',
      'write a file called note-2.txt saying check 2 ran',
    )).toBe(true);
  });

  it('matches the exact same instruction', () => {
    const s = 'Write note-3.txt in the workspace saying check 3 ran';
    expect(sameTask(s, s)).toBe(true);
  });

  it('does NOT match genuinely different follow-up work', () => {
    expect(sameTask(
      'summarize the inbox and email me the result',
      'write a file called note-2.txt saying check 2 ran',
    )).toBe(false);
  });

  it('does not match a different file in the same family — a real follow-up must stay allowed', () => {
    expect(sameTask(
      'Write note-2.txt saying check 2 ran, then delete the old draft and email Sarah a summary',
      'Write note-2.txt saying check 2 ran',
    )).toBe(false);
  });

  it('is false for empty input rather than vacuously true', () => {
    expect(sameTask('', 'anything at all')).toBe(false);
    expect(sameTask('   ', '')).toBe(false);
  });
});

/**
 * The `schedule` description is a CONTRACT, and on 2026-10-14 a well-meaning edit to it caused a
 * honesty regression within one test round. The edit told the model that "reporting that you could
 * not schedule something you just scheduled is worse than saying nothing" — intended to stop it
 * second-guessing a successful call. Measured effect: 2 of 4 interactive attempts answered "I
 * scheduled the task to run later" and "I've set up a later run for the requested file write" while
 * emitting no schedule event and leaving nothing pending. Claiming a side effect that did not
 * happen is strictly worse than the dead end the edit was trying to fix.
 *
 * These assert the parts of the contract that must hold, not the exact prose.
 */
describe('the schedule tool description contract', () => {
  const d = SCHEDULE_TOOL.description;

  it('names itself as the tool that CREATES a scheduled task', () => {
    // The original defect: schedule_list said "call it before scheduling anything" and nothing
    // said which tool actually schedules, so the agent listed, found nothing, and gave up.
    expect(d.toLowerCase()).toMatch(/creates|this is the tool/);
  });

  it('says an empty schedule_list is not a blocker', () => {
    expect(d.toLowerCase()).toMatch(/empty schedule_list|not a reason you cannot/);
  });

  it('requires the tool call to have succeeded before claiming something is scheduled', () => {
    // Must REINFORCE AGENT_SYSTEM's rule, never soften it.
    expect(d.toLowerCase()).toMatch(/only say something is scheduled if|returned success/);
  });

  it('never discourages reporting a failure honestly', () => {
    // The exact shape of the regression: do not tell the model that saying "it failed" is bad.
    expect(d.toLowerCase()).not.toMatch(/worse than saying nothing|do not report|avoid saying/);
  });

  it('still documents the three timing modes', () => {
    for (const k of ['in_minutes', 'daily_at', 'every_minutes']) expect(d).toContain(k);
  });

  it('tells the model the instruction runs with no memory of this conversation', () => {
    // §9/§10: the stored instruction executes in a fresh session, in a different folder.
    const instr = String((SCHEDULE_TOOL.parameters as Record<string, any>).properties.instruction.description).toLowerCase();
    expect(instr).toMatch(/no memory of this conversation|fresh session/);
    expect(instr).toMatch(/absolute path|relative/);
  });
});
