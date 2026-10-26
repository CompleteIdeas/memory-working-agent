/**
 * BL-71a — after a run that worked on a goal, keep where the goal stands: what happened, the files it made,
 * what it waits on. Robert, 2026-10-22: "if I say hey report back what you were working on I should be able
 * to jump right to it." A run's own `goal_note` says it better (the next step, open items), so a run that
 * wrote one is left alone; otherwise this writes the plain facts the run's end already knows.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Memory, Goal } from './awm.js';

/** Files under `dir` changed since `since`, newest first, as absolute paths (dot-files and node_modules skipped). */
export function filesChangedSince(dir: string, since: number, limit = 12): string[] {
  const out: { p: string; m: number }[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      if (n.startsWith('.') || n === 'node_modules') continue;
      const p = join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (st.isFile() && st.mtimeMs >= since - 1000) out.push({ p, m: st.mtimeMs });
    }
  };
  walk(resolve(dir), 0);
  return out.sort((a, b) => b.m - a.m).slice(0, limit).map((x) => x.p);
}

export interface RunEnd { outcome?: string; summary: string; tainted?: boolean; staged?: string[]; reason: string; capHit?: string }

/** The record a run's end writes, in words a person reads. */
export function recordFromRun(r: RunEnd): { state: string; next?: string } {
  const said = r.summary.replace(/\s+/g, ' ').trim().slice(0, 500) || '(no summary)';
  if (r.outcome === 'blocked') return { state: `Waiting on you. ${said}`, next: r.staged?.length ? `Approve or decline the ${r.staged.length} action(s) waiting in the app, then continue.` : 'Answer what it asked, then continue.' };
  // v2 (A3b): the person's dollar cap ended it — it waits for them, it did not get stuck.
  if (r.capHit === 'usd') return { state: `Waiting on you: it reached the spending limit you set. ${said}`, next: 'Continue to finish it (you can set a new limit).' };
  if (r.outcome === 'could-not') return { state: `Stuck. ${said}`, next: r.reason === 'budget' || r.reason === 'stuck' ? 'Continue where it stopped (it ran out of time).' : 'Try again, or change the approach.' };
  return { state: said };
}

/**
 * Write the record for a goal this run worked on — unless the run wrote its own note since it started.
 * Best effort: never throws, and a missing goal or a memory without records is a no-op.
 */
export async function recordGoalProgress(memory: Memory, o: { goalId?: string; since: number; dir: string; conv?: string; result: RunEnd }): Promise<void> {
  try {
    if (!o.goalId || !memory.getGoal || !memory.setGoalRecord || !memory.getGoalRecord) return;
    const goal: Goal | null = await memory.getGoal(o.goalId);
    if (!goal) return;
    const prev = await memory.getGoalRecord(goal.id);
    if (prev && prev.by === 'note' && prev.at >= o.since) return; // the run said where it stands itself
    const files = filesChangedSince(o.dir, o.since);
    const rec = recordFromRun(o.result);
    await memory.setGoalRecord(goal, { ...rec, files, conv: o.conv, by: 'run', untrusted: o.result.tainted === true });
  } catch { /* best effort */ }
}
