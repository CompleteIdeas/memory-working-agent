/**
 * BL-71b — "Want me to work on this and get back to you?" Robert, 2026-10-22: a request too big for one chat
 * turn should be offered to the background, not squeezed into it. His newsletter request ran inside the chat's
 * 40-step, 10-minute turn, split into sub-runs, and the report step ended blocked: he got the plan, not the report.
 *
 * The chat OFFERS before running when a request both researches and produces something; the person chooses.
 * "Work on it" creates a goal (the person's own tap: the same authority as goal_add in a clean chat) and a job
 * that fires at once in the chat's own folder, so its files sit beside the conversation's. The job's run keeps
 * the goal's record (BL-71a) and its result is posted back to the chat like any scheduled result.
 */
import { resolve, join } from 'node:path';
import { asksForLater } from './claim-check.js';
import { sessionFolder } from './files.js';
import type { MwaMemory } from './awm.js';

// The same research-and-produce signal the planner uses (model-router's isComplexTask), without its "then"
// requirement: "research X and write me a report" is the case this exists for.
const RESEARCH = /\b(find|search|research|look up|gather|compare|investigate|review|summari[sz]e|catch me up)\b/i;
const PRODUCE = /\b(write|create|build|generate|draft|produce|compile|report|spreadsheet|document|newsletter|plan|proposal|brief)\b/i;

/** Whether a chat message is worth offering to the background: it researches AND produces something, and
 *  isn't a request to set something up for later (that is a job already) or a short question. */
export function offersBackground(message: string): boolean {
  const m = message.trim();
  if (m.length < 40 || asksForLater(m)) return false;
  return RESEARCH.test(m) && PRODUCE.test(m);
}

export const OFFER_TEXT = 'This looks like it will take a while: research and then something written up. Want me to work on it in the background and get back to you here when it\'s done? Or I can do it right now while you wait.';

/** A goal title from the person's words: the first sentence, trimmed. */
export function goalTitle(message: string): string {
  const first = message.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] ?? message;
  return first.length > 100 ? `${first.slice(0, 97).replace(/\s+\S*$/, '')}…` : first;
}

export function handoffInstruction(message: string, goalShort: string): string {
  return [
    'The person asked for this in a chat and chose to have you work on it in the background and report back when it is done:',
    '"""', message.slice(0, 4000), '"""',
    'Do the whole job, not a plan of it. Save what you make as files in your working folder and link each one in your reply.',
    `When you finish, or if you have to stop partway, call goal_note for goal ${goalShort}: where it stands, the next step, and the files.`,
  ].join('\n');
}

/** Start the background work: a goal, and a one-shot job due now in the chat's folder. */
export async function startBackgroundWork(memory: MwaMemory, o: { message: string; session: string; personId: string; workspace: string }): Promise<{ goalId: string; jobId: string } | null> {
  const message = o.message.trim();
  if (!message) return null;
  const goalId = await memory.addGoal(goalTitle(message), message.slice(0, 600), 'medium', o.personId);
  if (!goalId) return null;
  await memory.setGoalStatus(goalId, 'in_progress');
  const dir = resolve(join(o.workspace, sessionFolder(o.session)));
  const jobId = await memory.addScheduledTask(handoffInstruction(message, goalId.slice(0, 8)), Date.now(), {
    notify: o.session, dir, person: o.personId, goal: goalId, task: message, request: message, depth: 0,
  });
  return jobId ? { goalId, jobId } : null;
}
