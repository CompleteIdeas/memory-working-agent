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
import type { Provider } from './provider.js';
import type { MwaMemory, ScheduledTask } from './awm.js';
import type { ToolRegistry } from './tools/registry.js';
import { runAgent } from './agent.js';

export interface FireResult { summary: string; files: string[]; dir: string; reason: string }

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
  now?: () => number;
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
  const due = deps.memory.pendingScheduled().filter((t) => t.due <= now());
  for (const task of due) {
    log(`⏰ firing: ${task.instruction.slice(0, 50)}${task.resumeAttempt ? ` (resume ${task.resumeAttempt})` : ''}`);
    // A RESUME task reuses the original run's folder (so it sees the files it already wrote);
    // a normal task gets a fresh per-fire folder.
    const dir = task.dir ? resolve(task.dir) : resolve(deps.outRoot, `sched-${task.id.slice(0, 8)}-${now()}`);
    mkdirSync(dir, { recursive: true });
    // Reschedule/complete BEFORE running, so a long/failed run can't re-fire next tick.
    if (task.recur) deps.memory.rescheduleTask(task.id, nextRecur(task.recur, now()));
    else deps.memory.completeScheduled(task.id);
    let r;
    try {
      // A resume continues an unfinished run — never re-plan it (it already says "do only the
      // remaining work"). Fresh scheduled tasks plan automatically if complex.
      r = await runAgent({ instruction: task.instruction, dir, memory: deps.memory, brain: deps.brain, worker: deps.worker, tools: deps.tools, session: task.notify, resumeAttempt: task.resumeAttempt, plan: task.resumeAttempt ? false : undefined, budget: { maxSteps: deps.maxSteps ?? 30, maxWallMs: (deps.maxMin ?? 8) * 60_000, consolidateEvery: 10 } });
    } catch (e) {
      r = { summary: `failed: ${(e as Error).message.slice(0, 120)}`, reason: 'error' } as any;
    }
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => !f.startsWith('.') && statSync(join(dir, f)).isFile()); } catch { /* */ }
    await deps.onFire(task, { summary: r.summary, files, dir, reason: r.reason }).catch((e) => log(`onFire failed: ${(e as Error).message.slice(0, 80)}`));
  }
  return due.length;
}

/** Poll loop — fire due tasks every interval (default 60s). */
export async function runScheduler(deps: SchedulerDeps): Promise<void> {
  for (;;) {
    try { await tickScheduler(deps); } catch (e) { (deps.onLog ?? (() => {}))(`scheduler error: ${(e as Error).message.slice(0, 100)}`); }
    await new Promise((r) => setTimeout(r, deps.intervalMs ?? 60_000));
  }
}
