/**
 * Deciding an approval — ONE implementation for every app (v2 build, slice S4).
 *
 * The classic app's POST /api/approvals/confirm and /api/approvals/cancel (serve.ts, through handleLegacyApprovals
 * below) and the v2 app's POST /api/v1/approvals/{id}/approve and /deny all come here, so a decision behaves the same
 * whichever app made it: the same store calls (confirmPending / cancelPending in src/tools/approval.ts: one atomic
 * step out of `pending`, the BL-03 guards, the step-up gate, the owner rule, the audit hook), the same log line, and
 * the same live event (the store writes it). The action runs in the context it was staged in; the job that staged it
 * reads the outcome on its next run (approval_results), exactly as before.
 *
 * What it adds is a plain verdict for the v1 API (`outcome`), read from the store's own words and the action's state
 * before and after — the store's message itself is returned unchanged, so the classic app's replies do not change.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { approvalStatus, cancelPending, confirmPending, pendingMeta, listPendingActions, recentApprovalOutcomes, recentAutoApproved } from './tools/approval.js';
import { logger } from './logger.js';

export type DecisionOutcome =
  | 'done'            // approved and it ran
  | 'failed'          // approved; it ran and failed
  | 'approved'        // approved; it runs in the app that asked for it (Telegram or the mailbox)
  | 'declined'        // not this time: it will not run
  | 'not_found'       // no such action
  | 'already_decided' // someone (another device, Telegram) decided it first
  | 'expired'         // too late: it expired
  | 'step_up'         // the person's identity must be confirmed first (it stays waiting)
  | 'refused'         // the store refused (the run that staged it, an unattended caller)
  | 'not_here'        // this app has no way to run it
  | 'not_done';       // approved, but the action itself refused when it ran (a guard inside the tool): nothing happened

export interface Decision { outcome: DecisionOutcome; message: string; tool?: string }

/** Approve (run it) or decline one action, by id. `via` names the app for the log; `note` is the person's reason for
 *  declining, kept for the run that asked. */
export async function decideApproval(id: string, approve: boolean, o: { via: string; note?: string; sandboxDir?: string }): Promise<Decision> {
  const key = String(id ?? '').trim();
  if (!key) return { outcome: 'not_found', message: '(no pending action with id "")' };
  const before = approvalStatus(key);
  const meta = pendingMeta(key);
  let message: string, outcome: DecisionOutcome;
  if (approve) {
    // An explicit id only: a person approves the card they are looking at, never "the latest". The action runs in the
    // context it was staged in (BL-03), so the ctx here only gates.
    message = await confirmPending(key, { sandboxDir: o.sandboxDir ?? resolve('.'), interactive: true });
    outcome = message.startsWith('[CONFIRMED')
      ? (/^\[CONFIRMED [^\]]*\] but it failed:/.test(message) ? 'failed' : refusedInside(message) ? 'not_done' : 'done')
      : message.startsWith('[APPROVED') ? 'approved'
        : refusal(message, before?.status);
  } else {
    message = cancelPending(key, undefined, o.note);
    outcome = message.startsWith('cancelled "') ? 'declined' : refusal(message, before?.status);
  }
  const tool = meta?.tool;
  logger.info('approvals', approve ? 'approve' : 'decline', { id: key, ...(tool ? { tool } : {}), outcome, via: o.via, ...(o.note && !approve ? { note: true } : {}) });
  return { outcome, message, ...(tool ? { tool } : {}) };
}

/** "[CONFIRMED tool]\n(refused: …)" / "(blocked: …)": the person approved, but the tool's own guard said no when it
 *  ran (review of S4: this used to count as done). The reason, or null when it ran. */
export function refusedInside(message: string): string | null {
  const body = message.replace(/^\[CONFIRMED [^\]]*\]\s*/, '').trim();
  const m = /^\((refused|blocked)\b:?\s*([\s\S]*?)\)?$/.exec(body);
  return m ? (m[2] || m[1]).replace(/\s+/g, ' ').trim().slice(0, 300) : null;
}

function refusal(message: string, before: string | undefined): DecisionOutcome {
  if (!before) return 'not_found';
  if (before === 'expired' || /expired/.test(message)) return 'expired';
  if (before !== 'pending') return 'already_decided';
  if (message.startsWith('(blocked')) return 'step_up';
  if (message.startsWith("(this app can't run")) return 'not_here';
  if (message.startsWith('(refused')) return 'refused';
  return 'already_decided'; // pending a moment ago: another tap or device got there first
}

/**
 * The classic app's approval endpoints (moved out of serve.ts's if-chain unchanged, so the two apps share the decision
 * above and the classic replies stay exactly as they were):
 *   GET  /api/approvals          { pending, recent, auto }
 *   POST /api/approvals/confirm  { id } → { ok, message }   (ok: it ran here)
 *   POST /api/approvals/cancel   { id } → { message }
 * Returns false for any other path. Same-origin and scope are checked by the caller (serve.ts, src/api/legacy.ts) —
 * same-origin again here, as before.
 */
export async function handleLegacyApprovals(req: IncomingMessage, res: ServerResponse, p: string, o: {
  sameOrigin: (req: IncomingMessage) => boolean; readBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
}): Promise<boolean> {
  const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (p === '/api/approvals' && req.method === 'GET') {
    json(200, { pending: listPendingActions(), recent: recentApprovalOutcomes(), auto: recentAutoApproved() });
    return true;
  }
  if ((p === '/api/approvals/confirm' || p === '/api/approvals/cancel') && req.method === 'POST') {
    if (!o.sameOrigin(req)) { json(403, { ok: false, error: 'cross-origin request blocked' }); return true; }
    const b = await o.readBody(req);
    if (p.endsWith('/confirm')) {
      if (!b.id) { json(400, { ok: false, message: 'which approval? (id is required)' }); return true; }
      const d = await decideApproval(String(b.id), true, { via: 'classic' });
      json(200, { ok: d.message.startsWith('[CONFIRMED'), message: d.message });
      return true;
    }
    const d = await decideApproval(String(b.id ?? ''), false, { via: 'classic' });
    json(200, { message: d.message });
    return true;
  }
  return false;
}
