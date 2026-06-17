/**
 * Two-step write approval — a MECHANICAL gate (not a prompt rule) for
 * irreversible / production-mutating tools.
 *
 * Wrap a write tool with `requireApproval(tool)`. Calling the wrapped tool does
 * NOT execute it — it performs a dry-run: stores a pending action and returns a
 * preview + a confirmation_id. The action only runs when `confirm_action` is
 * called with that id, which is a separate, explicit step. A scheduled
 * (non-interactive) run cannot confirm a write unless explicitly allowed, so an
 * unattended agent physically cannot mutate production on its own.
 *
 * Modeled on the USEA Gallop Support legacy-db dryrun→confirm flow (which guards
 * a live SQL Server) — generalized so any MWA tool can opt in. This is the hard
 * gate the USEA→MWA migration cannot cut over without.
 */
import type { RegisteredTool, ToolContext } from './registry.js';

export interface PendingAction {
  id: string;
  tool: string;
  summary: string;
  createdAt: number;
  expiresAt: number;
  execute: (ctx: ToolContext) => Promise<string>;
}

/** Audit hook — wire to AWM from the agent layer so every approval is recorded. */
export type ApprovalEvent = 'dryrun' | 'confirm' | 'cancel' | 'expired';
export type ApprovalAuditFn = (event: ApprovalEvent, a: { id: string; tool: string; summary: string }) => void;

const pending = new Map<string, PendingAction>();
let seq = 0;
let audit: ApprovalAuditFn | null = null;

/** Register an audit sink (e.g. write each approval event to AWM). Pass null to clear. */
export function setApprovalAudit(fn: ApprovalAuditFn | null): void {
  audit = fn;
}

function ttlMs(): number {
  const v = Number(process.env.MWA_APPROVAL_TTL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 600_000; // default 10 min
}

function newId(): string {
  seq += 1;
  return `act_${Date.now().toString(36)}_${seq}`;
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
        `(WRITE — does NOT run immediately: returns a confirmation_id; after the human approves, ` +
        `call confirm_action with that id to execute.)`,
    },
    handler: async (args) => {
      prune();
      const id = newId();
      const summary = opts?.preview
        ? opts.preview(args)
        : `${tool.def.name} ${JSON.stringify(args).slice(0, 300)}`;
      const action: PendingAction = {
        id,
        tool: tool.def.name,
        summary,
        createdAt: Date.now(),
        expiresAt: Date.now() + ttlMs(),
        execute: (ctx) => tool.handler(args, ctx),
      };
      pending.set(id, action);
      audit?.('dryrun', { id, tool: action.tool, summary });
      return (
        `[APPROVAL REQUIRED] "${tool.def.name}" will NOT run until confirmed.\n` +
        `confirmation_id: ${id}\n` +
        `--- preview of what will run ---\n${summary}\n--- end preview ---\n` +
        `Present this to the human. After they explicitly approve, call confirm_action with this confirmation_id. ` +
        `Expires in ${Math.round(ttlMs() / 60000)} min.`
      );
    },
  };
}

export interface PendingView { id: string; tool: string; summary: string; expiresInSec: number; }

/** List pending actions (for the chat tool AND the Connections UI — the "both paths" model). */
export function listPendingActions(): PendingView[] {
  prune();
  const now = Date.now();
  return [...pending.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((a) => ({ id: a.id, tool: a.tool, summary: a.summary, expiresInSec: Math.max(0, Math.round((a.expiresAt - now) / 1000)) }));
}

/** Confirm + execute a pending action by id (omit id → the single most recent). Shared by
 *  the confirm_action chat tool and the UI approval endpoint. Unattended runs are gated. */
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
  if (action.expiresAt <= Date.now()) {
    pending.delete(key);
    audit?.('expired', { id: action.id, tool: action.tool, summary: action.summary });
    return `(confirmation "${key}" expired — re-run the action to get a fresh preview)`;
  }
  pending.delete(key); // single-use — a confirmation can never be replayed
  audit?.('confirm', { id: action.id, tool: action.tool, summary: action.summary });
  const result = await action.execute(ctx);
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

const confirmActionTool: RegisteredTool = {
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

/** The approval control tools — always registered so confirm/cancel are available. */
export function approvalTools(): RegisteredTool[] {
  return [confirmActionTool, cancelActionTool, listPendingTool];
}
