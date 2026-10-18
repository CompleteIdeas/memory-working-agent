/**
 * BL-08 — a job's change detector starts as a DRY RUN. It runs on every fire but never skips one,
 * and its prediction ("would skip" / "would run") is scored against what the run actually found.
 * Only outcomes the run declared count. Only a PERSON arms it — by approving a card — after it has
 * agreed enough (four times, at least twice each way) or knowingly without that record. A missed
 * change resets it and is reported once per record.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MwaMemory } from '../src/awm.js';
import { tickScheduler } from '../src/scheduler.js';
import { scoreDryRun, evidenceAfter, readyToArm, detectorArmed, checkHash, detectorLine } from '../src/detector.js';
import { workTools } from '../src/tools/work.js';
import { confirmPending, listPendingActions } from '../src/tools/approval.js';

describe('scoring a dry run', () => {
  it('agreement, a missed change, a false alarm and the inconclusive outcomes', () => {
    expect(scoreDryRun(true, 'no-change')).toBe('agree-skip');
    expect(scoreDryRun(false, 'changed')).toBe('agree-run');
    expect(scoreDryRun(true, 'changed')).toBe('missed');
    expect(scoreDryRun(false, 'no-change')).toBe('false-alarm');
    for (const o of ['could-not', 'blocked', 'complete']) expect(scoreDryRun(true, o)).toBe('inconclusive');
  });
  it('a missed change wipes the record; a false alarm neither counts nor resets', () => {
    const ev = { n: 2, skips: 1, runs: 1 };
    expect(evidenceAfter(ev, 'missed')).toEqual({ n: 0, skips: 0, runs: 0 });
    expect(evidenceAfter(ev, 'false-alarm')).toBe(ev);
    expect(evidenceAfter(ev, 'agree-run')).toEqual({ n: 3, skips: 1, runs: 2 });
  });
  it('ready needs four agreements, at least two unchanged and two changed', () => {
    expect(readyToArm({ n: 6, skips: 6, runs: 0 })).toBe(false); // never seen a change: a constant would pass
    expect(readyToArm({ n: 6, skips: 0, runs: 6 })).toBe(false); // never predicted a skip
    expect(readyToArm({ n: 3, skips: 2, runs: 1 })).toBe(false); // one rollover proves little
    expect(readyToArm({ n: 4, skips: 2, runs: 2 })).toBe(true);
  });
  it('armed only for the command a person armed; a check from before BL-08 keeps skipping', () => {
    expect(detectorArmed({ check: 'x' })).toBe(true);
    expect(detectorArmed({ check: 'x', checkMode: 'dry' })).toBe(false);
    expect(detectorArmed({ check: 'x', checkMode: 'armed', checkArm: checkHash('x') })).toBe(true);
    expect(detectorArmed({ check: 'y', checkMode: 'armed', checkArm: checkHash('x') })).toBe(false);
    expect(detectorArmed({})).toBe(false);
  });
});

// The watched state is an env var the test flips; the check prints it.
const CHECK = 'node -e "process.stdout.write(process.env.DETVAL||\'\')"';

// Every tick runs the check as a real `node` process — about ten per test. Under a full parallel run
// that alone passed vitest's 5 s default (BL-33: 1 to 7 failures a run, every one passing alone).
describe('the scheduler runs a dry-run detector without ever skipping', { timeout: 30_000 }, () => {
  let dir = ''; let mem: MwaMemory; let clock = 0;
  let ran: string[] = []; let delivered: string[] = []; let nextOutcome = 'changed'; let declared = true;
  let during: (() => Promise<void>) | null = null; let throwRun = false;
  const deps = () => ({
    memory: mem, brain: {} as never, worker: {} as never, outRoot: join(dir, 'out'), checksAllowed: true,
    now: () => clock,
    runAgent: (async (a: { instruction: string }) => {
      ran.push(a.instruction);
      if (during) { const f = during; during = null; await f(); } // a person acts while the run is going
      if (throwRun) throw new Error('model down');
      return { summary: 'ok', reason: 'done', outcome: nextOutcome, ...(declared ? { outcomeDeclared: true } : {}), steps: 1, toolCalls: 0, costUsd: 0, durationMs: 1 };
    }) as never,
    onFire: async (_t: unknown, r: { summary: string }) => { delivered.push(r.summary); },
    onLog: () => {},
  });
  const tick = async (val: string, outcome: string) => { process.env.DETVAL = val; nextOutcome = outcome; clock += 120_000; await tickScheduler(deps()); };
  const task = async () => (await mem.pendingScheduled())[0];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mwa-det-'));
    mem = new MwaMemory('det-test', join(dir, 'a.db'));
    clock = 1_000_000_000; ran = []; delivered = []; declared = true; during = null; throwRun = false;
  });
  afterEach(() => { mem.close(); rmSync(dir, { recursive: true, force: true }); delete process.env.DETVAL; });

  it('never skips while dry; scores each fire; tells the person ONCE when it is ready', async () => {
    await mem.addScheduledTask('summarize new inbox items', clock, { recur: 'every:1', check: CHECK });
    expect((await task()).checkMode).toBe('dry');
    await tick('A', 'changed');    // bootstrap: no baseline, not scored
    expect((await task()).checkEv).toBeUndefined();
    await tick('A', 'no-change');  // would skip, nothing changed: agree
    await tick('B', 'changed');    // would run, something changed: agree
    await tick('B', 'no-change');  // agree
    expect(ran).toHaveLength(4);   // the unchanged fires RAN: a dry run skips nothing
    expect((await task()).checkEv).toEqual({ n: 3, skips: 2, runs: 1 });
    expect(delivered.join()).not.toMatch(/arm the detector/);
    await tick('C', 'changed');    // fourth agreement, two each way: ready
    expect(delivered[4]).toMatch(/agreed with 4 runs .* say "arm the detector for job .* approve the card/);
    await tick('C', 'no-change');  // the notice is not repeated
    expect(delivered[5]).not.toMatch(/arm the detector/);
    expect(detectorArmed(await task())).toBe(false); // ready is not armed

    const t = await task();
    await mem.setCheckMode(t.id, 'armed', checkHash(CHECK)); // what an approved card does
    await tick('C', 'no-change');  // armed, no baseline yet (arming clears it): runs, sets one
    expect(ran).toHaveLength(7);
    await tick('C', 'no-change');  // armed + unchanged: skipped
    expect(ran).toHaveLength(7);
    await tick('D', 'changed');    // armed + changed: runs
    expect(ran).toHaveLength(8);
  });

  it('an outcome the run did not declare is never evidence', async () => {
    await mem.addScheduledTask('watch', clock, { recur: 'every:1', check: CHECK });
    declared = false;
    await tick('A', 'changed'); await tick('A', 'changed'); await tick('B', 'changed');
    expect((await task()).checkEv).toBeUndefined();
    expect(delivered.join()).not.toMatch(/skipped real work/);
  });

  it('a missed change is reported once per record, not every fire', async () => {
    await mem.addScheduledTask('watch', clock, { recur: 'every:1', check: CHECK });
    await tick('A', 'no-change');
    await tick('A', 'changed'); await tick('A', 'changed'); await tick('A', 'changed');
    expect(delivered.filter((d) => /skipped real work/.test(d))).toHaveLength(1);
    await tick('A', 'no-change'); // an agreement starts a new record
    await tick('A', 'changed');   // so the next miss is news again
    expect(delivered.filter((d) => /skipped real work/.test(d))).toHaveLength(2);
  });

  it('a person disarming while a run is going is not overwritten by that run', async () => {
    await mem.addScheduledTask('watch', clock, { recur: 'every:1', check: CHECK });
    await tick('A', 'no-change'); await tick('A', 'no-change'); await tick('B', 'changed'); await tick('B', 'no-change');
    expect((await task()).checkEv).toEqual({ n: 3, skips: 2, runs: 1 });
    const id = (await task()).id;
    during = () => mem.setCheckMode(id, 'dry');
    await tick('C', 'changed');   // would have been the fourth agreement and the ready notice
    const after = await task();
    expect([after.checkEv, after.checkReady, after.lastSig]).toEqual([undefined, undefined, undefined]);
    expect(delivered.join()).not.toMatch(/arm the detector/);
  });

  it('arming while a run is going: the run does not lay a baseline the armed detector would skip on', async () => {
    await mem.addScheduledTask('watch', clock, { recur: 'every:1', check: CHECK });
    await tick('A', 'no-change');
    const id = (await task()).id;
    during = () => mem.setCheckMode(id, 'armed', checkHash(CHECK));
    throwRun = true;
    await tick('B', 'changed');   // the change at B was seen only by a run that failed
    throwRun = false;
    expect((await task()).lastSig).toBeUndefined();
    await tick('B', 'changed');   // armed, no baseline: it runs, so B is handled after all
    expect(ran).toHaveLength(3);
  });

  it('a missed change resets the record and reaches the person even when the job is set to stay silent', async () => {
    await mem.addScheduledTask('watch the folder', clock, { recur: 'every:1', check: CHECK, deliver: 'never' });
    await tick('A', 'no-change');
    await tick('A', 'no-change');  // agree-skip
    expect((await task()).checkEv).toEqual({ n: 1, skips: 1, runs: 0 });
    expect(delivered).toHaveLength(0); // deliver=never: quiet
    await tick('A', 'changed');    // the check saw nothing, the run found something: MISSED
    expect((await task()).checkEv).toEqual({ n: 0, skips: 0, runs: 0 });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/would have skipped real work/);
  });

  it('a false alarm costs a run but neither counts nor resets', async () => {
    await mem.addScheduledTask('watch the clock', clock, { recur: 'every:1', check: CHECK });
    await tick('A', 'no-change');
    await tick('A', 'no-change');  // agree-skip (1)
    await tick('B', 'no-change');  // would run, nothing found: false alarm
    expect((await task()).checkEv).toEqual({ n: 1, skips: 1, runs: 0 });
  });

  it('a detector armed for a different command is treated as a dry run', async () => {
    await mem.addScheduledTask('watch', clock, { recur: 'every:1', check: CHECK });
    const t = await task();
    await mem.setCheckMode(t.id, 'armed', checkHash('some other command'));
    await tick('A', 'no-change'); await tick('A', 'no-change');
    expect(ran).toHaveLength(2); // nothing skipped
  });
});

describe('the schedule_detector tool', { timeout: 30_000 }, () => {
  let dir = ''; let mem: MwaMemory;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mwa-det-tool-')); mem = new MwaMemory('det-tool', join(dir, 'a.db')); });
  afterEach(() => { mem.close(); rmSync(dir, { recursive: true, force: true }); });
  const tool = () => workTools(mem).find((x) => x.def.name === 'schedule_detector')!;
  const ctx = (extra: Record<string, unknown> = {}) => ({ sandboxDir: '.', personId: 'robert', interactive: true, ...extra }) as never;

  it('anyone can look; asking to arm needs an attended, clean chat and a ready record or force; only an APPROVAL arms', async () => {
    const id = (await mem.addScheduledTask('watch', Date.now() + 60_000, { recur: 'every:5', check: 'echo 1', person: 'robert' }))!;
    const short = id.slice(0, 8);
    const status = await tool().handler({ id: short, action: 'status' }, ctx({ interactive: false }));
    expect(status).toMatch(/dry run: 0 of 4/);
    expect(status).not.toContain('echo 1'); // no stored text in this tool's own output
    expect(await tool().handler({ id: short, action: 'arm' }, ctx({ interactive: false }))).toMatch(/refused/);
    expect(await tool().handler({ id: short, action: 'arm', force: true }, ctx({ tainted: true }))).toMatch(/refused/);
    expect(await tool().handler({ id: short, action: 'arm', force: true }, ctx({ readLocal: true }))).toMatch(/refused/);
    expect(await tool().handler({ id: short, action: 'arm' }, ctx())).toMatch(/not ready/);

    await mem.setCheckEvidence(id, { n: 4, skips: 2, runs: 2 }, true);
    const staged = await tool().handler({ id: short, action: 'arm' }, ctx());
    expect(staged).toContain('[APPROVAL REQUIRED]');
    expect(staged).not.toContain('echo 1'); // the model's copy carries no stored text…
    const cid = /confirmation_id: (\S+)/.exec(staged)![1];
    const card = listPendingActions({ personId: 'robert' }).find((p) => p.id === cid)!;
    expect(card.summary).toMatch(/SKIPS its run whenever this command prints the same[\s\S]*echo 1[\s\S]*agreed with 4 runs/); // …the card does
    expect(detectorArmed((await mem.pendingScheduled())[0])).toBe(false); // asking is not arming
    expect(await confirmPending(cid, ctx())).toMatch(/armed — /);
    expect(detectorArmed((await mem.pendingScheduled())[0])).toBe(true);
    expect(detectorLine((await mem.pendingScheduled())[0])).toMatch(/detector armed/);

    expect(await tool().handler({ id: short, action: 'disarm' }, ctx())).toMatch(/fresh record/);
    const after = (await mem.pendingScheduled())[0];
    expect([detectorArmed(after), after.checkEv, after.checkReady, after.lastSig]).toEqual([false, undefined, undefined, undefined]);
    const forced = await tool().handler({ id: short, action: 'arm', force: true }, ctx());
    const fid = /confirmation_id: (\S+)/.exec(forced)![1];
    expect(listPendingActions({ personId: 'robert' }).find((p) => p.id === fid)!.summary).toMatch(/NO dry-run record yet/);
  });

  it('approving a stale card arms nothing: the record changed after the card was made', async () => {
    const id = (await mem.addScheduledTask('watch', Date.now() + 60_000, { recur: 'every:5', check: 'echo 1', person: 'robert' }))!;
    await mem.setCheckEvidence(id, { n: 4, skips: 2, runs: 2 }, true);
    const staged = await tool().handler({ id: id.slice(0, 8), action: 'arm' }, ctx());
    const cid = /confirmation_id: (\S+)/.exec(staged)![1];
    await mem.recordDryRun(id, { score: 'missed', sig: 'x', prevSig: undefined }); // a fire misses meanwhile
    expect(await confirmPending(cid, ctx())).toMatch(/record changed after this card was made/);
    expect(detectorArmed((await mem.pendingScheduled())[0])).toBe(false);
  });

  it('another person’s job is not found', async () => {
    const id = (await mem.addScheduledTask('theirs', Date.now() + 60_000, { recur: 'every:5', check: 'echo 1', person: 'someone-else' }))!;
    expect(await tool().handler({ id: id.slice(0, 8), action: 'arm', force: true }, ctx())).toMatch(/no scheduled task/);
  });
});
