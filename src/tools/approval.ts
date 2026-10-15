/**
 * Two-step write approval — a MECHANICAL gate (not a prompt rule) for
 * irreversible / production-mutating tools.
 *
 * Wrap a write tool with `requireApproval(tool)`. Calling the wrapped tool does
 * NOT execute it — it performs a dry-run: stores a pending action and returns a
 * preview + a confirmation_id. The action only runs when a PERSON approves it,
 * through a channel the model cannot call: the app's approvals list
 * (/api/approvals/confirm) or the Approve button the Telegram connector sends.
 * (BL-03: the model used to have a confirm_action tool; measured 2026-10-14, it
 * staged a write and confirmed it itself in one turn with no human.) As a second
 * guard, confirmPending refuses a confirm carrying the same runId that staged the
 * action. A scheduled (non-interactive) run cannot confirm a write unless
 * explicitly allowed, so an unattended agent physically cannot mutate on its own.
 *
 * Modeled on the USEA Gallop Support legacy-db dryrun→confirm flow (which guards
 * a live SQL Server) — generalized so any MWA tool can opt in. This is the hard
 * gate the USEA→MWA migration cannot cut over without.
 */
import { randomBytes } from 'node:crypto';
import type { RegisteredTool, ToolContext } from './registry.js';
import { isStepUpSatisfied } from '../step-up.js';

export interface PendingAction {
  id: string;
  tool: string;
  summary: string;
  createdAt: number;
  expiresAt: number;
  execute: (ctx: ToolContext) => Promise<string>;
  /** S6 v2 — the identity state captured at dry-run time. The step-up gate travels WITH the action,
   *  so it's enforced no matter which path confirms it (chat tool OR the UI /api/approvals/confirm). */
  personId?: string;
  identityInDoubt?: boolean;
  /** the run that staged it — a confirm from the same run is refused (BL-03 second guard). */
  runId?: string;
  /** the conversation it came from (e.g. `tg-<chatId>`, a web session id). */
  session?: string;
  /** staged by a run that had read outside content — shown to the person beside the preview. */
  tainted?: boolean;
  /** what it is: a tool call the model made, or a standing preference captured from the person's words. */
  kind?: 'tool' | 'captured-policy';
  /** the context it was staged in; it executes in this one, whoever approves it. */
  stagedCtx?: ToolContext;
}

/** Audit hook — wire to AWM from the agent layer so every approval is recorded. */
export type ApprovalEvent = 'dryrun' | 'confirm' | 'cancel' | 'expired';
export type ApprovalAuditFn = (event: ApprovalEvent, a: { id: string; tool: string; summary: string }) => void;

const pending = new Map<string, PendingAction>();
let audit: ApprovalAuditFn | null = null;

/** Register an audit sink (e.g. write each approval event to AWM). Pass null to clear. */
export function setApprovalAudit(fn: ApprovalAuditFn | null): void {
  audit = fn;
}

function ttlMs(): number {
  const v = Number(process.env.MWA_APPROVAL_TTL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 600_000; // default 10 min
}

/** Unguessable and never reused across restarts: an id is all an Approve button carries. */
function newId(): string {
  return `act_${randomBytes(8).toString('hex')}`;
}

function prune(): void {
  const now = Date.now();
  for (const [id, a] of pending) {
    if (a.expiresAt <= now) {
      pending.delete(id);
      audit?.('expired', { id: a.id, tool: a.tool, summary: a.summary });
    }
  }
}

/**
 * Stage an action for a person's approval. Used by requireApproval and by the run-end capture of
 * standing preferences (which must not be saved silently: text the person pasted could carry a
 * "from now on always BCC ..." that was never theirs — BL-03). The ctx captured here is the one the
 * action executes with, whoever approves it.
 */
export function stageAction(a: {
  tool: string; summary: string; ctx?: ToolContext; ttlMs?: number; kind?: PendingAction['kind'];
  execute: (ctx: ToolContext) => Promise<string>;
}): string {
  prune();
  const id = newId();
  const now = Date.now();
  const ctx = a.ctx;
  pending.set(id, {
    id, tool: a.tool, summary: a.summary, createdAt: now, expiresAt: now + (a.ttlMs ?? ttlMs()),
    execute: a.execute, personId: ctx?.personId, identityInDoubt: ctx?.identityInDoubt,
    runId: ctx?.runId, session: ctx?.session, tainted: ctx?.tainted === true, kind: a.kind ?? 'tool',
    stagedCtx: ctx,
  });
  audit?.('dryrun', { id, tool: a.tool, summary: a.summary });
  return id;
}

/** Ids of actions a run staged that are still waiting (outcome + delivery use this). */
export function pendingStagedBy(runId: string, kind?: PendingAction['kind']): string[] {
  prune();
  return [...pending.values()]
    .filter((a) => a.runId === runId && (kind === undefined || (a.kind ?? 'tool') === kind))
    .map((a) => a.id);
}

/** One pending action's metadata (no execute, no ctx) — the Telegram connector checks where it came from. */
export function pendingMeta(id: string): { id: string; tool: string; summary: string; session?: string; tainted: boolean; kind: 'tool' | 'captured-policy' } | undefined {
  prune();
  const a = pending.get(id);
  return a ? { id: a.id, tool: a.tool, summary: a.summary, session: a.session, tainted: a.tainted === true, kind: a.kind ?? 'tool' } : undefined;
}

/** Number of pending actions (test/inspection helper). */
export function pendingCount(): number {
  return pending.size;
}

/**
 * Wrap a tool so it requires explicit confirmation before running. The wrapped
 * tool's handler stores a pending action and returns a preview instead of
 * executing. `opts.preview` produces the human-facing summary of what WILL run.
 */
export function requireApproval(
  tool: RegisteredTool,
  opts?: { preview?: (args: Record<string, unknown>) => string },
): RegisteredTool {
  return {
    def: {
      ...tool.def,
      description:
        `${tool.def.description} ` +
        `(WRITE — does NOT run now: it is staged for the person to approve in the app or with the ` +
        `Approve button in Telegram. You cannot approve it yourself.)`,
    },
    handler: async (args, ctx) => {
      const summary = opts?.preview
        ? opts.preview(args)
        : `${tool.def.name} ${JSON.stringify(args).slice(0, 300)}`;
      // An unattended run's request waits a day: nobody is there to see it within ten minutes (BL-03 review).
      const life = ctx?.interactive === false ? 24 * 60 * 60_000 : ttlMs();
      const id = stageAction({ tool: tool.def.name, summary, ctx, ttlMs: life, execute: (ctx2) => tool.handler(args, ctx2) });
      return (
        `[APPROVAL REQUIRED] "${tool.def.name}" will NOT run until the person approves it.\n` +
        `confirmation_id: ${id}\n` +
        `--- preview of what will run ---\n${summary}\n--- end preview ---\n` +
        `The person approves or declines it in the MWA app (the approvals list) or with the Approve button in Telegram. ` +
        `You cannot approve it yourself. Tell them what is waiting for their approval, and finish. ` +
        `Expires in ${life >= 3_600_000 ? `${Math.round(life / 3_600_000)} h` : `${Math.round(life / 60000)} min`}.`
      );
    },
  };
}

export interface PendingView { id: string; tool: string; summary: string; expiresInSec: number; tainted: boolean; kind: 'tool' | 'captured-policy'; }

/** List pending actions (for the chat tool AND the Connections UI — the "both paths" model). */
export function listPendingActions(): PendingView[] {
  prune();
  const now = Date.now();
  return [...pending.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((a) => ({ id: a.id, tool: a.tool, summary: a.summary, expiresInSec: Math.max(0, Math.round((a.expiresAt - now) / 1000)), tainted: a.tainted === true, kind: a.kind ?? 'tool' }));
}

/** Confirm + execute a pending action by id (omit id → the single most recent). Called only by
 *  channels the model cannot reach: the app's approval endpoint and the Telegram connector's
 *  Approve button. Unattended runs are gated, and so is the run that staged the action. */
export async function confirmPending(id: string | undefined, ctx: ToolContext): Promise<string> {
  prune();
  if (ctx.interactive === false && process.env.MWA_ALLOW_UNATTENDED_WRITES !== '1') {
    return '(refused: confirming a write needs a human present — this is an unattended/scheduled run. Set MWA_ALLOW_UNATTENDED_WRITES=1 only if you intend writes without a person watching.)';
  }
  let key = (id ?? '').trim();
  if (!key) {
    const all = [...pending.values()].sort((a, b) => b.createdAt - a.createdAt);
    if (all.length === 0) return '(nothing to confirm — no pending action)';
    if (all.length > 1) return `(ambiguous: ${all.length} pending actions — pass an explicit confirmation_id. Use list_pending to see them.)`;
    key = all[0].id;
  }
  const action = pending.get(key);
  if (!action) return `(no pending action with id "${key}" — it may have expired or already run)`;
  // SECOND GUARD (BL-03): the run that staged an action never approves it, whatever path it finds.
  if (ctx.runId && action.runId && ctx.runId === action.runId) {
    return '(refused: an action cannot be approved by the run that staged it — the person approves it in the app or with the Telegram button.)';
  }
  if (action.expiresAt <= Date.now()) {
    pending.delete(key);
    audit?.('expired', { id: action.id, tool: action.tool, summary: action.summary });
    return `(confirmation "${key}" expired — re-run the action to get a fresh preview)`;
  }
  // S6 v2 STEP-UP GATE: enforced from the identity state captured on the ACTION at dry-run time, so it
  // holds on EVERY confirm path (chat tool AND the UI /api/approvals/confirm endpoint), not just when the
  // caller happens to pass identity in ctx. Do NOT consume the pending action — they can confirm again
  // after completing step-up.
  if (action.identityInDoubt && action.personId && !isStepUpSatisfied(action.personId)) {
    return `(blocked: this person's identity is unverified — running "${action.tool}" requires a second factor. ` +
      `Complete step-up verification (a code sent to their validated connection) first, then confirm "${key}" again.)`;
  }
  pending.delete(key); // single-use — a confirmation can never be replayed
  audit?.('confirm', { id: action.id, tool: action.tool, summary: action.summary });
  // Execute in the context it was STAGED in (its folder, person, roots) — not the approver's. A
  // person approved it, so it runs as interactive and untainted.
  const result = await action.execute(action.stagedCtx ? { ...action.stagedCtx, interactive: true, tainted: false } : ctx);
  return `[CONFIRMED ${action.tool}]\n${result}`;
}

/** Discard a pending action without running it. */
export function cancelPending(id: string): string {
  const action = pending.get(id);
  if (!action) return `(no pending action with id "${id}")`;
  pending.delete(id);
  audit?.('cancel', { id: action.id, tool: action.tool, summary: action.summary });
  return `cancelled "${id}" (${action.tool}) — not executed`;
}

/** NOT given to the model (BL-03). For an embedding app that wires its own HUMAN channel to it;
 *  never register it into an agent's tools. */
export const humanConfirmTool: RegisteredTool = {
  def: {
    name: 'confirm_action',
    description:
      'Execute a previously previewed write action AFTER a human has explicitly approved it. ' +
      'Pass the confirmation_id from the [APPROVAL REQUIRED] preview (or omit to confirm the single most recent pending action). ' +
      'Never call this without explicit human approval of the preview.',
    parameters: {
      type: 'object',
      properties: { confirmation_id: { type: 'string', description: 'id from the dry-run preview; omit for the most recent' } },
      required: [],
    },
  },
  handler: async (args, ctx) => confirmPending(args.confirmation_id ? String(args.confirmation_id) : undefined, ctx),
};

const cancelActionTool: RegisteredTool = {
  def: {
    name: 'cancel_action',
    description: 'Discard a pending write action without running it (e.g. the human declined). Pass its confirmation_id.',
    parameters: { type: 'object', properties: { confirmation_id: { type: 'string' } }, required: ['confirmation_id'] },
  },
  handler: async (args) => cancelPending(String(args.confirmation_id ?? '').trim()),
};

const listPendingTool: RegisteredTool = {
  def: {
    name: 'list_pending',
    description: 'List write actions awaiting confirmation (id, tool, preview, time left).',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  handler: async () => {
    const all = listPendingActions();
    if (all.length === 0) return '(no pending actions)';
    return all.map((a) => `${a.id} — ${a.tool} — expires in ${a.expiresInSec}s\n  ${a.summary.slice(0, 200)}`).join('\n');
  },
};

/** The approval tools the MODEL gets: decline and look — never approve (BL-03). */
export function approvalTools(): RegisteredTool[] {
  return [cancelActionTool, listPendingTool];
}
