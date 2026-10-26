/**
 * The schedule as the app sees it, and the controls on it (usability review 2026-10-24, F04).
 *
 * Before this, `GET /api/schedule` returned instruction, due and recur with no id, so the interface could show a
 * job and do nothing to it; there was no write endpoint; and three cancel requests in chat ended "I can't cancel them
 * from here". A five-minute watch ran until the server was stopped. Now a job is listed with its id and controls:
 * cancel (with a ten-minute undo), pause and resume, and change (time, days, interval, instruction), each scoped to
 * the person asking, through the same tools the model uses, so the ownership and timing rules are in one place.
 */
import type { MwaMemory, ScheduledTask } from './awm.js';
import { normalizePersonId } from './person.js';
import { workTools, visibleTo } from './tools/work.js';

import { liveRuns } from './live-runs.js';

/** A tool's reply as text (a tool may also return an image for the model; these never do). */
const asText = (out: string | { text: string }): string => (typeof out === 'string' ? out : out.text);
import { friendlySchedule, recurWords, isWatch } from './schedule-request.js';

export interface ScheduleRow {
  id: string;
  /** reminder: delivered as written; watch: reports changes or waits for a condition; task: work done each time */
  kind: 'reminder' | 'watch' | 'task';
  /** the person's own words, when a person set it up; else the instruction */
  request: string;
  instruction: string;
  due: number;
  recur: string | null;
  when: string;
  paused: boolean;
  tainted: boolean;
  /** what the job may do unattended in the browser (saved logins, named clicks), or null */
  allow: import('./tools/registry.js').JobAllow | null;
  /** the job's run going right now, with its last stage, or null (attach with session=job_<id>) */
  live: ReturnType<typeof liveRuns.describe>;
  goal?: string;
  /** the conversation it reports to, so the app can show it in the task that set it up */
  session?: string;
  lastRun?: { at: number; summary: string; value?: string };
  fails?: number;
}

/** This person's jobs, soonest first. Resume tasks (the harness finishing its own work) are not theirs to control. */
export async function scheduleRows(memory: MwaMemory, person: string): Promise<ScheduleRow[]> {
  const me = normalizePersonId(person);
  const all = await memory.pendingScheduled();
  return all.filter((t) => visibleTo(t, me) && !t.resumeAttempt).sort((a, b) => a.due - b.due).map((t) => ({
    id: t.id, kind: t.kind === 'reminder' ? 'reminder' : isWatch(t) ? 'watch' : 'task',
    request: t.request ?? t.task ?? t.instruction, instruction: t.instruction,
    due: t.due, recur: t.recur ?? null, when: t.recur ? recurWords(t.recur) : friendlySchedule(t.due, t.recur), paused: t.paused === true, tainted: t.tainted === true, allow: t.allow ?? null, live: liveRuns.describe(`job_${t.id}`),
    ...(t.goal ? { goal: t.goal } : {}),
    ...(t.notify && !t.notify.startsWith('tg-') ? { session: t.notify } : {}),
    ...(t.lastRun ? { lastRun: { at: t.lastRun.at, summary: t.lastRun.summary, ...(t.lastRun.value ? { value: t.lastRun.value } : {}) } } : {}),
    ...(t.fails ? { fails: t.fails } : {}),
  }));
}

export type ScheduleAction = 'cancel' | 'uncancel' | 'pause' | 'resume' | 'update';

/** One control, by id, for one person. `body` carries the id and, for `update`, the same fields as schedule_update. */
export async function scheduleControl(memory: MwaMemory, person: string, action: ScheduleAction, body: Record<string, unknown>, nowMs = Date.now()): Promise<{ ok: boolean; message: string; id?: string }> {
  const id = String(body.id ?? '').trim();
  if (id.length < 4) return { ok: false, message: 'Which job? (id is required)' };
  const me = normalizePersonId(person);
  const mine = async (): Promise<ScheduledTask | null> => {
    const hits = (await memory.pendingScheduled()).filter((t) => visibleTo(t, me) && !t.resumeAttempt && t.id.toLowerCase().startsWith(id.toLowerCase()));
    return hits.length === 1 ? hits[0] : null;
  };
  const tools = Object.fromEntries(workTools(memory).map((t) => [t.def.name, t]));
  // The person clicked the control: that IS the request to stop or change this job (the BL-47 guard's question).
  const ctx = { sandboxDir: '.', interactive: true, personId: me, asksJobChange: true, personMessage: typeof body.message === 'string' ? body.message : undefined };
  if (action === 'cancel') {
    const t = await mine();
    if (!t) return { ok: false, message: 'No such job.' };
    const out = asText(await tools.schedule_cancel.handler({ id: t.id }, ctx));
    return out.startsWith('canceled') ? { ok: true, id: t.id, message: `Cancelled. It was ${t.recur ? recurWords(t.recur) : friendlySchedule(t.due)}. Undo within ten minutes.` } : { ok: false, message: out };
  }
  if (action === 'uncancel') {
    const cur = await memory.getScheduled(id);
    if (!cur || !visibleTo({ person: cur.person } as ScheduledTask, me)) return { ok: false, message: 'No such job.' };
    const ok = await memory.uncancelScheduled(cur.id, undefined, nowMs);
    return ok ? { ok: true, id: cur.id, message: 'Restored. It will run as before.' } : { ok: false, message: 'Too late to undo this one. Ask for it again and it will be scheduled afresh.' };
  }
  if (action === 'pause' || action === 'resume') {
    const t = await mine();
    if (!t) return { ok: false, message: 'No such job.' };
    if (action === 'pause') { if (t.paused) return { ok: true, id: t.id, message: 'Already paused.' }; await memory.pauseScheduled(t.id); return { ok: true, id: t.id, message: 'Paused. It keeps its settings and will not run until you resume it.' }; }
    if (!t.paused) return { ok: true, id: t.id, message: 'It is not paused.' };
    await memory.resumeScheduled(t.id, nowMs);
    const after = await memory.getScheduled(t.id);
    return { ok: true, id: t.id, message: `Resumed. Next run ${after ? friendlySchedule(after.due, after.recur) : 'at its next slot'}.` };
  }
  const t = await mine();
  if (!t) return { ok: false, message: 'No such job.' };
  const args: Record<string, unknown> = { id: t.id };
  for (const k of ['instruction', 'at', 'daily_at', 'days', 'every_minutes'] as const) if (body[k] !== undefined && body[k] !== null && String(body[k]).trim() !== '') args[k] = k === 'every_minutes' ? Number(body[k]) : String(body[k]);
  const out = asText(await tools.schedule_update.handler(args, ctx));
  return out.startsWith('updated') ? { ok: true, id: t.id, message: out.replace(/ Tell the person which job changed and how\.$/, '') } : { ok: false, message: out };
}
