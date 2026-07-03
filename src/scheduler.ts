/**
 * Scheduler — the clock for AWM-stored scheduled tasks. Every interval it asks the
 * memory for pending tasks whose due (epoch ms) has passed, runs each on the agent,
 * reschedules recurring ones (or marks one-shots done), and calls onFire so the
 * caller can proactively deliver the result (e.g. a Telegram message).
 *
 * AWM = the task store (the WHAT + due tag); this loop = the WHEN; onFire = delivery.
 */
import { resolve, join } from 'node:path';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runCommandAllowed } from './tools/access.js';
import type { Provider } from './provider.js';
import type { MwaMemory, ScheduledTask } from './awm.js';
import type { ToolRegistry } from './tools/registry.js';
import { runAgent } from './agent.js';

export interface FireResult { summary: string; files: string[]; dir: string; reason: string }

/** A compact, fixed-size signature (sha1 hex) of a check command's output. Two identical outputs
 *  hash identically → "nothing changed"; any difference → "there's new work, run the agent". */
function signature(s: string): string { return createHash('sha1').update(s).digest('hex'); }

/** Run a task's cheap change-detection command through the platform shell (so pipes/redirects work),
 *  bounded by a short timeout + small output buffer. Returns { ok } false on non-zero exit / timeout /
 *  spawn error so the caller can fail OPEN (run the agent anyway rather than silently skip work). */
function runCheck(cmd: string, timeoutMs = 15_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((res) => {
    try {
      exec(cmd, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
        res({ ok: !err, out: String(stdout ?? '') });
      });
    } catch { res({ ok: false, out: '' }); }
  });
}

export interface SchedulerDeps {
  memory: MwaMemory;
  brain: Provider;
  worker: Provider;
  tools?: ToolRegistry;
  outRoot: string;
  maxSteps?: number;
  maxMin?: number;
  intervalMs?: number;
  onFire: (task: ScheduledTask, result: FireResult) => Promise<void>;
  onLog?: (m: string) => void;
  /** called once per poll iteration — a liveness heartbeat for /api/health. */
  onTick?: () => void;
  now?: () => number;
  /** Override the agent runner (tests inject a spy; production uses the real runAgent import). */
  runAgent?: typeof runAgent;
  /** May the scheduler EXECUTE a task's `check` shell command? Defaults to the unattended run_command
   *  policy (Developer preset only), so an injected/model-authored `check` can't run shell unattended
   *  in Assistant/Locked-down mode. When false, tasks with a check simply fire every interval (no shell). */
  checksAllowed?: boolean;
}

/** Next due (epoch ms) for a recurring spec ("every:<min>" or "daily:HH:MM"). */
function nextRecur(recur: string, fromMs: number): number {
  if (recur.startsWith('every:')) return fromMs + Number(recur.slice(6)) * 60_000;
  if (recur.startsWith('daily:')) {
    const [h, m] = recur.slice(6).split(':').map(Number);
    const d = new Date(fromMs); d.setHours(h || 0, m || 0, 0, 0);
    let due = d.getTime(); if (due <= fromMs) due += 86_400_000; return due;
  }
  return fromMs + 60_000;
}

/** Run any due tasks once. Returns how many fired. */
export async function tickScheduler(deps: SchedulerDeps): Promise<number> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.onLog ?? (() => {});
  const run = deps.runAgent ?? runAgent;
  // Gate `check` shell execution on the unattended run_command policy — so a model/injection-authored
  // check can't run shell unattended unless the operator is in Developer mode (or a test opts in).
  const allowChecks = deps.checksAllowed ?? runCommandAllowed(false).ok;
  const due = (await deps.memory.pendingScheduled()).filter((t) => t.due <= now());
  let fired = 0;
  for (const task of due) {
    // Cheap change-detection gate: before the (expensive) agent run, if the task carries a `check`
    // command whose output signature matches the last actual fire, skip it entirely — one small
    // subprocess, ZERO model tokens. This is what keeps an idle recurring poll ~free: a fresh
    // runAgent per fire already keeps context small; the gate avoids even paying for the fire when
    // there's nothing new. A resume never gates (it's continuing committed work, not polling).
    let newSig: string | undefined;
    if (task.check && !task.resumeAttempt && allowChecks) {
      const c = await runCheck(task.check);
      if (c.ok) {
        const s = signature(c.out.trim());
        if (task.lastSig && s === task.lastSig) {
          // Nothing changed: advance a recurring task's clock; leave a one-shot pending so it fires
          // whenever the watched thing finally changes. No run, no notify.
          if (task.recur) await deps.memory.rescheduleTask(task.id, nextRecur(task.recur, now()));
          log(`⏭  skip (no change): ${task.instruction.slice(0, 50)}`);
          continue;
        }
        newSig = s; // changed (or first-ever fire) → run, then persist this as the new baseline
      } else {
        log(`check failed — running anyway: ${task.instruction.slice(0, 50)}`); // fail OPEN: never silently drop work
      }
    }

    log(`⏰ firing: ${task.instruction.slice(0, 50)}${task.resumeAttempt ? ` (resume ${task.resumeAttempt})` : ''}`);
    // A RESUME task reuses the original run's folder (so it sees the files it already wrote);
    // a normal task gets a fresh per-fire folder.
    const dir = task.dir ? resolve(task.dir) : resolve(deps.outRoot, `sched-${task.id.slice(0, 8)}-${now()}`);
    mkdirSync(dir, { recursive: true });
    // Reschedule/complete BEFORE running, so a long/failed run can't re-fire next tick.
    if (task.recur) await deps.memory.rescheduleTask(task.id, nextRecur(task.recur, now()));
    else await deps.memory.completeScheduled(task.id);
    let r; let ranOk = false;
    try {
      // A resume continues an unfinished run — never re-plan it (it already says "do only the
      // remaining work"). Fresh scheduled tasks plan automatically if complex.
      r = await run({ instruction: task.instruction, dir, memory: deps.memory, brain: deps.brain, worker: deps.worker, tools: deps.tools, session: task.notify, resumeAttempt: task.resumeAttempt, plan: task.resumeAttempt ? false : undefined, interactive: false, budget: { maxSteps: deps.maxSteps ?? 30, maxWallMs: (deps.maxMin ?? 8) * 60_000, consolidateEvery: 10 } });
      ranOk = true;
    } catch (e) {
      r = { summary: `failed: ${(e as Error).message.slice(0, 120)}`, reason: 'error' } as any;
    }
    fired++;
    // Persist the new baseline only after a clean run — if the run threw, we WANT the next tick to
    // re-detect the same change and retry (at-least-once), not treat it as already handled.
    if (ranOk && newSig) await deps.memory.setScheduledSignature(task.id, newSig);
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => !f.startsWith('.') && statSync(join(dir, f)).isFile()); } catch { /* */ }
    await deps.onFire(task, { summary: r.summary, files, dir, reason: r.reason }).catch((e) => log(`onFire failed: ${(e as Error).message.slice(0, 80)}`));
  }
  return fired;
}

/** Backoff delay after `fails` consecutive errors: base interval when healthy, doubling up to
 *  a 30-minute ceiling so a persistent outage degrades gracefully instead of hammering. */
export function backoffDelay(base: number, fails: number): number {
  return fails === 0 ? base : Math.min(base * 2 ** Math.min(fails, 5), 30 * 60_000);
}

/** Poll loop — fire due tasks every interval (default 60s). On repeated failure it backs
 *  off exponentially (to 30 min max) and stops log-spamming, so a persistent provider/DB
 *  outage degrades gracefully instead of retrying + logging every 60s forever. */
export async function runScheduler(deps: SchedulerDeps): Promise<void> {
  const base = deps.intervalMs ?? 60_000;
  const log = deps.onLog ?? (() => {});
  let fails = 0;
  for (;;) {
    deps.onTick?.();
    try {
      await tickScheduler(deps);
      fails = 0;
    } catch (e) {
      fails++;
      // log the first failure and then only every 5th — not every tick
      if (fails === 1 || fails % 5 === 0) log(`scheduler error (${fails} in a row): ${(e as Error).message.slice(0, 100)}`);
    }
    await new Promise((r) => setTimeout(r, backoffDelay(base, fails)));
  }
}
