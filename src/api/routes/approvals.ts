/**
 * Approvals for the v2 app and a phone (v2 build, slice S4): the actions your helper staged for your OK, said plainly,
 * and your decision on each.
 *
 *   GET  /approvals               the ones waiting (oldest first) and those decided in the last day (read)
 *   GET  /approvals/{id}          one, whatever its state (read)
 *   POST /approvals/{id}/approve  run it now, once (approve)
 *   POST /approvals/{id}/deny     not this time, with an optional note for the helper (approve)
 *
 * Deciding is src/approval-decisions.ts — the same code the classic app's /api/approvals/confirm and /cancel call — so
 * the guards, the audit hook, the log line and the live event ('approval' on /stream) are the same. A paired phone has
 * the `approve` scope by default: deciding from the phone is intended. A device without it can look but not decide.
 *
 * There is no "always allow this kind": the classic app has none. A decision is final: deciding one that was already
 * decided (here, on another device, or in Telegram) or that expired is 409, with the action as it now stands; one
 * whose identity check is not done is 409 `step_up_required` (it stays waiting). A retry with the same Idempotency-Key
 * gets the first answer back.
 */
import { ApiError, type Route } from '../router.js';
import { approvalView, approvalsList } from '../../v2/approvals.js';
import { decideApproval, type DecisionOutcome } from '../../approval-decisions.js';

const bodyOf = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {});

function load(id: string) {
  const v = approvalView(id);
  if (!v) throw new ApiError(404, 'not_found', 'There is no such request. It may have been cleared after a day.');
  return v;
}

/** The plain sentence for an outcome (the store's own words stay in the log and the classic app). */
const SAID: Record<DecisionOutcome, string> = {
  done: 'Done. It ran.',
  failed: 'Approved, but it failed.',
  approved: 'Approved. It runs in the app that asked for it, within a minute or so.',
  declined: 'OK — it won’t run. Nothing was changed.',
  not_found: 'There is no such request.',
  already_decided: 'This was already decided.',
  expired: 'This request expired, so nothing was done. Ask your helper again if you still want it.',
  step_up: 'Your identity needs confirming first (a code sent to your account). It is still waiting.',
  refused: 'Your helper can’t approve its own request.',
  not_here: 'This can only be approved in the app where it was asked for.',
};
const CONFLICT: Partial<Record<DecisionOutcome, { status: number; code: string }>> = {
  not_found: { status: 404, code: 'not_found' },
  already_decided: { status: 409, code: 'already_decided' },
  expired: { status: 409, code: 'expired' },
  step_up: { status: 409, code: 'step_up_required' },
  refused: { status: 409, code: 'refused' },
  not_here: { status: 409, code: 'not_here' },
};

async function decide(id: string, approve: boolean, body: unknown) {
  // refuse at once what is not waiting (the store would say so too; this keeps the state in the answer)
  const now = load(id);
  if (now.state !== 'pending') {
    const code = now.state === 'expired' ? 'expired' : 'already_decided';
    throw new ApiError(409, code, code === 'expired' ? SAID.expired : SAID.already_decided);
  }
  const b = bodyOf(body);
  const note = typeof b.note === 'string' ? b.note.slice(0, 500) : undefined;
  if (b.note !== undefined && typeof b.note !== 'string') throw new ApiError(400, 'bad_note', 'The note must be text.');
  const d = await decideApproval(id, approve, { via: 'api-v1', ...(note ? { note } : {}) });
  const c = CONFLICT[d.outcome];
  if (c) throw new ApiError(c.status, c.code, SAID[d.outcome]);
  return { body: { outcome: d.outcome, message: SAID[d.outcome], approval: load(id) } };
}

export const approvalRoutes: Route[] = [
  { method: 'GET', path: '/approvals', scope: 'read', handler: () => ({ body: approvalsList() }) },
  { method: 'GET', path: '/approvals/{id}', scope: 'read', handler: ({ params }) => ({ body: { approval: load(params.id) } }) },
  { method: 'POST', path: '/approvals/{id}/approve', scope: 'approve', handler: ({ params, body }) => decide(params.id, true, body) },
  { method: 'POST', path: '/approvals/{id}/deny', scope: 'approve', handler: ({ params, body }) => decide(params.id, false, body) },
];
