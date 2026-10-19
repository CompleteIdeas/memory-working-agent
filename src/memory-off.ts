/**
 * MWA_MEMORY=off — MWA without AWM's knowledge, for measuring what memory adds (the promise
 * assessment's arm B, docs/assessment-2026-10-19.md). Scheduled jobs and goals are still kept, because
 * they are the cron, not memory. Nothing is recalled or remembered; there are no standing preferences,
 * no person profile and no learning, and the memory and preference tools are not offered.
 */
import type { Memory, MwaMemory, RecalledMemory, ScheduleOpts, ScheduledTask, Goal, TrustTier, JobLastRun } from './awm.js';

export const MEMORY_OFF = String(process.env.MWA_MEMORY ?? '').toLowerCase() === 'off';

/** Tools that read or write what memory knows; absent when memory is off. */
export const KNOWLEDGE_TOOLS = new Set(['memory_profile', 'memory_learn_person', 'memory_store_map', 'memory_feedback', 'policy_save', 'policy_forget', 'routine_propose']);

export class SchedulesOnlyMemory implements Memory {
  readonly enabled = false;
  readonly keepsSchedules = true;
  constructor(private readonly real: MwaMemory) {}
  // The jobs — kept in the real store, where the scheduler reads them.
  addScheduledTask(instruction: string, dueMs: number, opts: ScheduleOpts = {}): Promise<string | null> { return this.real.addScheduledTask(instruction, dueMs, opts); }
  pendingScheduled(): Promise<ScheduledTask[]> { return this.real.pendingScheduled(); }
  setJobLastRun(id: string, rec: JobLastRun): Promise<void> { return this.real.setJobLastRun(id, rec); }
  setJobFails(id: string, n: number): Promise<void> { return this.real.setJobFails(id, n); }
  getGoal(idOrPrefix: string): Promise<Goal | null> { return this.real.getGoal(idOrPrefix); }
  logAction(a: { verb: string; summary: string; effect: 'external' | 'local' | 'read'; tool?: string; namespace?: string; undo?: string }): Promise<string | null> { return this.real.logAction(a); }
  // Knowledge — none.
  async recall(): Promise<RecalledMemory[]> { return []; }
  async write(): Promise<string | null> { return null; }
  async supersede(): Promise<string | null> { return null; }
  async forget(): Promise<boolean> { return false; }
  trustOf(): TrustTier { return 'untrusted'; }
  async feedback(): Promise<void> { /* */ }
  setSessionId(): void { /* */ }
  setNamespace(): void { /* */ }
  async consolidate(): Promise<Record<string, number>> { return {}; }
  async saveSkill(): Promise<string | null> { return null; }
  async saveFriction(): Promise<string | null> { return null; }
  async savePolicy(): Promise<string | null> { return null; }
  async listPolicies(): Promise<string[]> { return []; }
  async saveQuestion(): Promise<string | null> { return null; }
  close(): void { /* the real store is closed by its owner */ }
}

/** The memory a run is given: the real store, or one that keeps only jobs when memory is off. */
export function agentMemory(real: MwaMemory): Memory {
  return MEMORY_OFF ? new SchedulesOnlyMemory(real) : real;
}
