/**
 * The chat runs that are going right now, one per conversation (usability review 2026-10-24, F06, F08, F09).
 *
 * Before this, `/api/chat` streamed for the life of one request and the server kept no handle to the run: closing
 * the tab did not stop it, a reload lost the stream (the answer appeared after a second refresh), a message sent
 * during a run started a second run in the same conversation, and there was no Stop. Now each live run has an id,
 * an abort handle, a ring of its events, and an inbox: a reload re-attaches to the ring and the live stream, Stop
 * aborts it at the next step, and a message sent meanwhile can be queued into it.
 */
import { randomBytes } from 'node:crypto';

export interface LiveEvent { type: string; data: Record<string, unknown>; at: number }
export interface LiveRun {
  runId: string; session: string; message: string; startedAt: number;
  controller: AbortController; stopping: boolean;
  events: LiveEvent[]; inbox: string[];
  listeners: Set<(e: LiveEvent) => void>;
}

const RING = 300;
/** Events that end a stream: an attached reader closes on them. */
export const FINAL_EVENTS = new Set(['result', 'error']);

export class LiveRuns {
  private runs = new Map<string, LiveRun>();
  /** v2 (A4): watchers of every run's events — the app's live stream forwards progress from them. */
  private taps = new Set<(session: string, e: LiveEvent) => void>();

  /** Follow every run's events (not replayed). Returns the unsubscribe function. */
  tap(fn: (session: string, e: LiveEvent) => void): () => void { this.taps.add(fn); return () => { this.taps.delete(fn); }; }

  get(session: string): LiveRun | undefined { return this.runs.get(session); }
  /** A view with no handles — what `busy` and the list carry. */
  describe(session: string): { runId: string; message: string; startedAt: number; elapsedMs: number; stopping: boolean; stage?: Record<string, unknown> } | null {
    const r = this.runs.get(session);
    if (!r) return null;
    const last = [...r.events].reverse().find((e) => e.type === 'step' || e.type === 'plan_step');
    return { runId: r.runId, message: r.message, startedAt: r.startedAt, elapsedMs: Date.now() - r.startedAt, stopping: r.stopping, ...(last ? { stage: last.data } : {}) };
  }

  /** Begin a run for a conversation. One at a time: a second start while one is live is refused (the caller answers `busy`). */
  start(session: string, message: string, now = Date.now()): LiveRun {
    if (this.runs.has(session)) throw new Error(`a run is already live for ${session}`);
    const run: LiveRun = { runId: `live_${randomBytes(6).toString('hex')}`, session, message, startedAt: now, controller: new AbortController(), stopping: false, events: [], inbox: [], listeners: new Set() };
    this.runs.set(session, run);
    return run;
  }

  /** Keep an event and hand it to every attached reader. A reader that throws (its socket closed) is dropped. */
  record(session: string, type: string, data: Record<string, unknown>, now = Date.now()): void {
    const r = this.runs.get(session);
    if (!r) return;
    const e: LiveEvent = { type, data, at: now };
    r.events.push(e);
    if (r.events.length > RING) r.events.splice(0, r.events.length - RING);
    for (const fn of [...r.listeners]) { try { fn(e); } catch { r.listeners.delete(fn); } }
    for (const fn of [...this.taps]) { try { fn(session, e); } catch { this.taps.delete(fn); } }
  }

  /** Replay what has happened so far, then follow along. Returns the detach function. */
  attach(session: string, fn: (e: LiveEvent) => void): (() => void) | null {
    const r = this.runs.get(session);
    if (!r) return null;
    for (const e of r.events) { try { fn(e); } catch { return () => { /* already gone */ }; } }
    r.listeners.add(fn);
    return () => { r.listeners.delete(fn); };
  }

  /** The person's Stop: the run ends at its next step. Said at once as a `stopping` event. */
  stop(session: string): boolean {
    const r = this.runs.get(session);
    if (!r) return false;
    if (!r.stopping) { r.stopping = true; r.controller.abort(); this.record(session, 'stopping', { runId: r.runId }); }
    return true;
  }

  /** A message sent while the run is going, queued for its next step. */
  steer(session: string, message: string): boolean {
    const r = this.runs.get(session);
    if (!r) return false;
    r.inbox.push(message);
    this.record(session, 'steer', { runId: r.runId, message: message.slice(0, 200) });
    return true;
  }
  /** The agent drains the inbox at the top of each step. */
  takeInbox(session: string): string[] {
    const r = this.runs.get(session);
    if (!r || !r.inbox.length) return [];
    return r.inbox.splice(0, r.inbox.length);
  }

  /** The run is over: its last event has been recorded; readers have had it; forget the run. */
  finish(session: string): void {
    const r = this.runs.get(session);
    if (!r) return;
    this.runs.delete(session);
    r.listeners.clear();
  }

  /** Every live run, for a status line or a test. */
  all(): { session: string; runId: string; startedAt: number; stopping: boolean }[] {
    return [...this.runs.values()].map((r) => ({ session: r.session, runId: r.runId, startedAt: r.startedAt, stopping: r.stopping }));
  }
}

export const liveRuns = new LiveRuns();
