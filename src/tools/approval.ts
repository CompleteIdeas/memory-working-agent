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
 * ONE STORE, SHARED AND DURABLE (BL-18). Pending actions live in a small SQLite file next to the
 * agent's database (`approvals.db`), not in a per-process Map: the web app and the Telegram
 * connector are separate processes, each with a scheduler, so an action one of them staged was
 * invisible to the other, and a restart dropped everything waiting. A stored action holds DATA — the
 * tool name, its arguments, the context it was staged in — and runs through an executor each process
 * registers by tool name (requireApproval registers the tool it wraps). A process without that
 * executor refuses rather than guessing.
 *
 * OWNER. Each row records the memory identity of the process that staged it (its AWM agent id: the
 * web app is `mwa-serve`, Telegram/mailbox/CLI are `mwa-agent`). Any channel may record the person's
 * APPROVAL, but only a process of the owning identity RUNS it — otherwise a preference staged in
 * Telegram and approved on the web was saved into the web app's memory, where Telegram never sees it
 * (BL-18 review). States: pending → approved → executing → done | failed, or cancelled / expired. A
 * process approving its own row runs it at once; an approval for another owner waits until that
 * owner's process picks it up (runApproved). Each step is one atomic UPDATE, expiry checked in the
 * first, so two processes, or two taps, can never run an action twice. An action left `executing` by a crash is
 * marked failed ("interrupted") rather than retried: a write that may have half-happened is for a
 * person to re-stage, not for the store to replay.
 *
 * Modeled on the USEA Gallop Support legacy-db dryrun→confirm flow (which guards
 * a live SQL Server) — generalized so any MWA tool can opt in.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { reviewAction, reviewMode, configuredClef, logReview, type Review } from '../approval-review.js';
import { hasPasted } from '../handoff.js';
import Database from 'better-sqlite3';
import { ToolRefusal, toolText, type RegisteredTool, type ToolContext } from './registry.js';
import { isStepUpSatisfied } from '../step-up.js';
import { dbFile } from '../paths.js';

export type ApprovalKind = 'tool' | 'captured-policy';
export type ApprovalStatus = 'pending' | 'executing' | 'done' | 'failed' | 'cancelled' | 'expired';

/** A stored action (no code — its executor is looked up by name when it runs). */
export interface PendingAction {
  id: string;
  tool: string;
  summary: string;
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  /** S6 v2 — the identity state captured at dry-run time travels WITH the action, so the step-up gate
   *  holds on every confirm path. */
  personId?: string;
  identityInDoubt?: boolean;
  /** the run that staged it — a confirm from the same run is refused (BL-03 second guard). */
  runId?: string;
  /** the conversation it came from (e.g. `tg-<chatId>`, a web session id). */
  session?: string;
  /** staged by a run that had read outside content — shown to the person beside the preview. */
  tainted?: boolean;
  /** staged by a run that had read the person's own files (F02: not "outside content", and the card says which). */
  readLocal?: boolean;
  kind?: ApprovalKind;
}

/** Audit hook — wire to AWM from the agent layer so every approval is recorded. */
export type ApprovalEvent = 'dryrun' | 'confirm' | 'cancel' | 'expired';
export type ApprovalAuditFn = (event: ApprovalEvent, a: { id: string; tool: string; summary: string }) => void;
let audit: ApprovalAuditFn | null = null;
/** Register an audit sink (e.g. write each approval event to AWM). Pass null to clear. */
export function setApprovalAudit(fn: ApprovalAuditFn | null): void { audit = fn; }

// ── the store ──────────────────────────────────────────────────────────────────────────────────
type Db = InstanceType<typeof Database>;
let db: Db | null = null;
let dbPath: string | null = null;

/** Where the store lives: MWA_APPROVALS_DB, else `approvals.db` beside the agent DB (MWA_DB), else
 *  ./data. Under vitest it is in memory unless a test points it somewhere. */
function defaultPath(): string {
  if (process.env.MWA_APPROVALS_DB) return process.env.MWA_APPROVALS_DB;
  if (process.env.VITEST) return ':memory:';
  return join(dirname(dbFile()), 'approvals.db');
}

function store(): Db {
  if (db) return db;
  dbPath = dbPath ?? defaultPath();
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY, tool TEXT NOT NULL, executor TEXT NOT NULL, args TEXT NOT NULL, summary TEXT NOT NULL,
    ctx TEXT NOT NULL, kind TEXT NOT NULL, tainted INTEGER NOT NULL, status TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    offer_chat TEXT, offer_message INTEGER, result TEXT, owner TEXT)`);
  const cols = (db.prepare(`PRAGMA table_info(approvals)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('owner')) db.exec('ALTER TABLE approvals ADD COLUMN owner TEXT');
  // BL-72: why the reviewer ran it without asking (null for an action a person decided).
  if (!cols.includes('auto')) db.exec('ALTER TABLE approvals ADD COLUMN auto TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS approvals_status ON approvals(status)');
  db.pragma('user_version = 3');
  return db;
}

/** This process's memory identity (its AWM agent id) — the owner of what it stages. */
let owner: string = process.env.MWA_APPROVAL_OWNER ?? 'local';
export function setApprovalOwner(id: string): void { owner = id; }
const ownerLabel = (o: string | null) => (o === 'mwa-serve' ? 'the web app' : o === 'mwa-agent' ? 'Telegram or the mailbox' : 'the app that asked');
/** How long finished rows are kept (their arguments are blanked at once). */
const RETAIN_MS = 7 * 24 * 60 * 60_000;
/** An approval its owner never picked up. */
const APPROVED_STALE_MS = 24 * 60 * 60_000;
/** An approval must be picked up before the action's own expiry, or within this long of the approval
 *  if that is later — never a day later, when a restart would run a command nobody expects (review). */
const APPROVAL_GRACE_MS = 10 * 60_000;
/** After this, what a finished action said and printed is cleared; the row itself goes after a week. */
const CLEAR_MS = 24 * 60 * 60_000;

/** Point the store at a file (tests, or an embedding app). Closes any open store first. */
export function setApprovalStorePath(path: string | null): void {
  if (db && path !== null && dbPath !== null && resolve(path) === resolve(dbPath)) return; // already there
  try { db?.close(); } catch { /* */ }
  db = null; dbPath = path;
}

// ── executors ──────────────────────────────────────────────────────────────────────────────────
/** Tool name → the code that runs it, registered per process. */
const executors = new Map<string, (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>>();
/** Register how this process runs an approved action named `name`. requireApproval does this for the
 *  tool it wraps; other staging paths (run_command, captured preferences) register their own. */
export function registerExecutor(name: string, fn: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>): void {
  executors.set(name, fn);
}
/** A closure given at staging time — runs only in the process that staged it (tests, one-offs). */
const localClosures = new Map<string, (ctx: ToolContext) => Promise<string>>();

function ttlMs(): number {
  const v = Number(process.env.MWA_APPROVAL_TTL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 600_000; // default 10 min
}

/** Unguessable and never reused across restarts: an id is all an Approve button carries. */
function newId(): string {
  return `act_${randomBytes(8).toString('hex')}`;
}

interface Row {
  id: string; tool: string; executor: string; args: string; summary: string; ctx: string; kind: string;
  tainted: number; status: string; created_at: number; expires_at: number; updated_at: number;
  offer_chat: string | null; offer_message: number | null; result: string | null; owner: string | null;
}
function parse<T>(s: string, fallback: T): T { try { return JSON.parse(s) as T; } catch { return fallback; } }
function toAction(r: Row): PendingAction {
  const ctx = parse<ToolContext>(r.ctx, { sandboxDir: '.' });
  return {
    id: r.id, tool: r.tool, summary: r.summary, createdAt: r.created_at, expiresAt: r.expires_at, status: r.status as ApprovalStatus,
    personId: ctx.personId, identityInDoubt: ctx.identityInDoubt, runId: ctx.runId, session: ctx.session,
    tainted: r.tainted === 1, readLocal: ctx.readLocal === true, kind: (r.kind as ApprovalKind) ?? 'tool',
  };
}
/** Two stagings of the same thing: same tool, same arguments (or the same summary when there are none). */
function sameStaging(a: { tool: string; args: string; summary: string }, tool: string, args: Record<string, unknown>, summary: string): boolean {
  if (a.tool !== tool) return false;
  const norm = (o: unknown) => JSON.stringify(o, Object.keys((o as Record<string, unknown>) ?? {}).sort()).toLowerCase().replace(/\s+/g, ' ');
  const mine = Object.keys(args).length ? norm(args) : '';
  return mine ? norm(parse(a.args, {})) === mine : a.summary.trim().toLowerCase() === summary.trim().toLowerCase();
}
const INTERRUPTED_MS = 15 * 60_000;

function prune(): void {
  const s = store(); const now = Date.now();
  const expired = s.prepare(`SELECT id, tool, summary FROM approvals WHERE status = 'pending' AND expires_at <= ?`).all(now) as Row[];
  if (expired.length) {
    s.prepare(`UPDATE approvals SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at <= ?`).run(now, now);
    for (const a of expired) { localClosures.delete(a.id); audit?.('expired', { id: a.id, tool: a.tool, summary: a.summary }); }
  }
  // A crash between the claim and the end of the run leaves `executing` behind: say so, never replay.
  s.prepare(`UPDATE approvals SET status = 'failed', result = 'interrupted: the app stopped while this was running. Check what it did before staging it again.', updated_at = ? WHERE status = 'executing' AND updated_at <= ?`)
    .run(now, now - INTERRUPTED_MS);
  s.prepare(`UPDATE approvals SET status = 'failed', result = 'approved, but the app that asked for it never ran it — is it still running?', updated_at = ? WHERE status = 'approved' AND updated_at <= ?`)
    .run(now, now - APPROVED_STALE_MS);
  // Retention (BL-18 review): a finished action's arguments can hold secrets (a server's command line,
  // a document's text). Blank them as soon as it is finished; drop the row after a week.
  s.prepare(`UPDATE approvals SET args = '{}' WHERE status IN ('done','failed','cancelled','expired') AND args <> '{}'`).run();
  // A command line or its output can carry a secret too: after a day keep only that it happened.
  s.prepare(`UPDATE approvals SET summary = '(cleared)', result = NULL, ctx = '{}' WHERE status IN ('done','failed','cancelled','expired') AND summary <> '(cleared)' AND updated_at <= ?`).run(now - CLEAR_MS);
  s.prepare(`DELETE FROM approvals WHERE status IN ('done','failed','cancelled','expired') AND updated_at <= ?`).run(now - RETAIN_MS);
}

/**
 * Stage an action for a person's approval. Used by requireApproval, by run_command's staging and by
 * the run-end capture of standing preferences. The ctx captured here is the one the action executes
 * with, whoever approves it. `executor` (default: `tool`) names the registered code that runs it with
 * `args`; `execute`, when given, is a process-local closure tried first.
 */
/** BL-72: how many actions one run may have run without asking — a loop the reviewer keeps passing still stops. */
export const MAX_AUTO_PER_RUN = 12;
const autoByRun = new Map<string, number>();

/**
 * BL-72 live (MWA_AUTO_APPROVE=on): review an action before it is staged; when the reviewer passes it, run it
 * now, record it (status done/failed, with the reviewer's reason in `auto`) and return what to tell the model.
 * Returns `{ ran: false, review }` when it must go to the person — the caller stages it as before, passing the
 * review on so stageAction logs it rather than asking Clef twice. Off or shadow: `{ ran: false }` at once.
 */
export async function tryAutoApprove(a: { tool: string; summary: string; command?: string; kind?: ApprovalKind; ctx?: ToolContext; args?: Record<string, unknown>; run: () => Promise<string> }): Promise<{ ran: true; text: string } | { ran: false; review?: Review }> {
  if (reviewMode() !== 'on') return { ran: false };
  const c = a.ctx ?? { sandboxDir: '.' };
  // A run with no id can't be counted against the cap: the person decides (BL-72 review).
  if (!c.runId) return { ran: false };
  // Pasted text in the person's message is someone else's words: the run counts as tainted here (review M3).
  const tainted = c.tainted === true || (c.personMessage ? hasPasted(c.personMessage) : false);
  const input = { tool: a.tool, summary: a.summary, command: a.command, kind: a.kind, request: c.personMessage ?? c.jobRequest, tainted, interactive: c.interactive, sandboxDir: c.sandboxDir };
  const review = await reviewAction(input, configuredClef());
  if (review.decision !== 'auto') return { ran: false, review };
  const runKey = c.runId;
  const used = autoByRun.get(runKey) ?? 0;
  if (used >= MAX_AUTO_PER_RUN) return { ran: false, review: { ...review, decision: 'ask', by: 'run-cap', reason: `this run already ran ${MAX_AUTO_PER_RUN} actions without asking` } };
  autoByRun.set(runKey, used + 1); if (autoByRun.size > 500) autoByRun.delete(autoByRun.keys().next().value!);
  const id = newId();
  logReview(id, input, review, 'on');
  const now = Date.now();
  const ctx: ToolContext = { sandboxDir: c.sandboxDir, tainted: c.tainted === true, interactive: c.interactive, personId: c.personId, runId: c.runId, session: c.session };
  store().prepare(`INSERT INTO approvals (id, tool, executor, args, summary, ctx, kind, tainted, status, created_at, expires_at, updated_at, owner, auto)
    VALUES (?, ?, ?, '{}', ?, ?, ?, ?, 'executing', ?, ?, ?, ?, ?)`)
    .run(id, a.tool, a.tool, a.summary, JSON.stringify(ctx), a.kind ?? 'tool', c.tainted === true ? 1 : 0, now, now, now, owner, review.reason);
  audit?.('confirm', { id, tool: a.tool, summary: `auto: ${review.reason} — ${a.summary.slice(0, 200)}` });
  try {
    const out = await a.run();
    store().prepare(`UPDATE approvals SET status = 'done', result = ?, updated_at = ? WHERE id = ?`).run(tail(out), Date.now(), id);
    return { ran: true, text: `${out}\n(ran without asking the person: the reviewer judged it safe — ${review.reason})` };
  } catch (e) {
    const msg = e instanceof ToolRefusal ? e.text : (e as Error).message;
    store().prepare(`UPDATE approvals SET status = 'failed', result = ?, updated_at = ? WHERE id = ?`).run(tail(msg), Date.now(), id);
    if (e instanceof ToolRefusal) throw e; // the tool's own refusal keeps its meaning for the registry
    return { ran: true, text: `(it ran without asking — the reviewer judged it safe — and failed: ${msg.slice(0, 300)})` };
  }
}

/** What the reviewer ran without asking in the last day, newest first — shown to the person (BL-72). */
export function recentAutoApproved(): { id: string; tool: string; summary: string; reason: string; status: ApprovalStatus; result?: string; at: number }[] {
  const rows = store().prepare(`SELECT * FROM approvals WHERE auto IS NOT NULL AND created_at > ? ORDER BY created_at DESC LIMIT 30`).all(Date.now() - 24 * 60 * 60_000) as (Row & { auto: string })[];
  return rows.map((r) => ({ id: r.id, tool: r.tool, summary: r.summary, reason: r.auto, status: r.status as ApprovalStatus, ...(r.result ? { result: r.result } : {}), at: r.created_at }));
}

export function stageAction(a: {
  tool: string; summary: string; ctx?: ToolContext; ttlMs?: number; kind?: ApprovalKind;
  args?: Record<string, unknown>; executor?: string;
  execute?: (ctx: ToolContext) => Promise<string>;
  /** BL-72: the review tryAutoApprove already did — logged, not repeated */
  reviewed?: Review;
}): string {
  prune();
  const c = a.ctx ?? { sandboxDir: '.' };
  // One card per proposal (usability review 2026-10-24, F03): the same tool with the same arguments, staged again
  // by the same conversation (or the same run) while the first card still waits, is the first card. One
  // preference request had produced three identical policy_save cards beside the captured one.
  if (c.session || c.runId) {
    const open = store().prepare(`SELECT * FROM approvals WHERE status = 'pending' AND tool = ? ORDER BY created_at DESC`).all(a.tool) as Row[];
    const twin = open.find((r) => { const x = toAction(r); return (c.session ? x.session === c.session : x.runId === c.runId) && sameStaging(r, a.tool, a.args ?? {}, a.summary); });
    if (twin) { if (a.execute) localClosures.set(twin.id, a.execute); return twin.id; }
  }
  const id = newId();
  const now = Date.now();
  // Plain data only: the context is JSON, so it survives a restart and another process can run it.
  const ctx: ToolContext = {
    sandboxDir: c.sandboxDir, extraRoots: c.extraRoots, tainted: c.tainted === true, readLocal: c.readLocal,
    interactive: c.interactive, personId: c.personId, identityInDoubt: c.identityInDoubt, runId: c.runId, session: c.session,
  };
  store().prepare(`INSERT INTO approvals (id, tool, executor, args, summary, ctx, kind, tainted, status, created_at, expires_at, updated_at, owner)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
    .run(id, a.tool, a.executor ?? a.tool, JSON.stringify(a.args ?? {}), a.summary, JSON.stringify(ctx), a.kind ?? 'tool', c.tainted === true ? 1 : 0, now, now + (a.ttlMs ?? ttlMs()), now, owner);
  if (a.execute) localClosures.set(id, a.execute);
  audit?.('dryrun', { id, tool: a.tool, summary: a.summary });
  // BL-72 shadow: review it as the reviewer would, and log that beside what the person then does.
  // Changes nothing: the action waits for the person exactly as before.
  const mode = reviewMode();
  if (mode !== 'off') {
    const input = { tool: a.tool, summary: a.summary, kind: a.kind, request: c.personMessage ?? c.jobRequest, tainted: c.tainted === true, interactive: c.interactive, sandboxDir: c.sandboxDir };
    if (a.reviewed) logReview(id, input, a.reviewed, mode);
    else void reviewAction(input, configuredClef()).then((r) => logReview(id, input, r, mode)).catch(() => { /* best effort */ });
  }
  return id;
}

/** Ids of actions a run staged that are still waiting (outcome + delivery use this). */
export function pendingStagedBy(runId: string, kind?: ApprovalKind): string[] {
  prune();
  const rows = store().prepare(`SELECT * FROM approvals WHERE status = 'pending'`).all() as Row[];
  return rows.map(toAction).filter((a) => a.runId === runId && (kind === undefined || (a.kind ?? 'tool') === kind)).map((a) => a.id);
}

/** One pending action's metadata (no args, no ctx) — the Telegram connector checks where it came from. */
export function pendingMeta(id: string): { id: string; tool: string; summary: string; session?: string; tainted: boolean; kind: ApprovalKind } | undefined {
  prune();
  const r = store().prepare(`SELECT * FROM approvals WHERE id = ? AND status = 'pending'`).get(id) as Row | undefined;
  if (!r) return undefined;
  const a = toAction(r);
  return { id: a.id, tool: a.tool, summary: a.summary, session: a.session, tainted: a.tainted === true, kind: a.kind ?? 'tool' };
}

/** Where an action stands, whatever its state (null = no such action). */
export function approvalStatus(id: string): { status: ApprovalStatus; result?: string } | null {
  prune();
  const r = store().prepare(`SELECT status, result FROM approvals WHERE id = ?`).get(id) as Pick<Row, 'status' | 'result'> | undefined;
  return r ? { status: r.status as ApprovalStatus, ...(r.result ? { result: r.result } : {}) } : null;
}

/** Number of pending actions (test/inspection helper). */
export function pendingCount(): number {
  prune();
  return (store().prepare(`SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'`).get() as { n: number }).n;
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
  // This process can run the tool once a person approves it — wherever it was staged (BL-18).
  registerExecutor(tool.def.name, async (args, ctx) => toolText(await tool.handler(args, ctx)));
  return {
    def: {
      ...tool.def,
      description:
        `${tool.def.description} ` +
        (reviewMode() === 'on'
          ? `(WRITE — MWA's reviewer may run it now if it is clearly safe; otherwise it is staged for the person to approve. You cannot approve it yourself.)`
          : `(WRITE — does NOT run now: it is staged for the person to approve in the app or with the ` +
            `Approve button in Telegram. You cannot approve it yourself.)`),
    },
    handler: async (args, ctx) => {
      const summary = opts?.preview
        ? opts.preview(args)
        : `${tool.def.name} ${JSON.stringify(args).slice(0, 300)}`;
      // BL-72: with the reviewer on, an action it passes runs now instead of waiting for the person.
      const auto = await tryAutoApprove({ tool: tool.def.name, summary, ctx, args, run: async () => toolText(await tool.handler(args, ctx)) });
      if (auto.ran) return auto.text;
      // An unattended run's request waits a day: nobody is there to see it within ten minutes (BL-03 review).
      const life = ctx?.interactive === false ? 24 * 60 * 60_000 : ttlMs();
      const id = stageAction({ tool: tool.def.name, summary, ctx, ttlMs: life, args, reviewed: auto.review });
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

/** A run with neither a session nor a person sees nothing (BL-18 review: it matched every row). */
function inScope(a: PendingAction, scope: { session?: string; personId?: string }): boolean {
  if (scope.session) return a.session === scope.session;
  if (scope.personId) return a.personId === scope.personId;
  return false;
}

/** What happened recently to actions approved elsewhere — waiting for their own app, or failed — so
 *  the person isn't left with "[APPROVED]" and nothing after it (BL-18 review). Last 24 hours. */
export function recentApprovalOutcomes(): { id: string; tool: string; status: ApprovalStatus; owner: string; summary: string; kind: ApprovalKind; session?: string; result?: string; at: number; createdAt: number }[] {
  prune();
  // Every ending, with the card's words, for a day (F02, 2026-10-24): an expired or declined card used to vanish
  // with no trace, and the chat still said "approve it in the app".
  const rows = store().prepare(`SELECT * FROM approvals WHERE status IN ('approved','failed','done','cancelled','expired') AND auto IS NULL AND updated_at > ? ORDER BY updated_at DESC LIMIT 40`).all(Date.now() - CLEAR_MS) as Row[];
  return rows.map((r) => { const a = toAction(r); return { id: r.id, tool: r.tool, status: r.status as ApprovalStatus, owner: ownerLabel(r.owner), summary: r.summary, kind: a.kind ?? 'tool', ...(a.session ? { session: a.session } : {}), ...(r.result ? { result: r.result.slice(0, 300) } : {}), at: r.updated_at, createdAt: r.created_at }; });
}

export interface PendingView { id: string; tool: string; summary: string; expiresInSec: number; expiresAt: number; tainted: boolean; readLocal: boolean; kind: ApprovalKind; session?: string; runId?: string; /** who it was staged for (v2 A10: Today shows the owner's only) */ personId?: string; /** when it was staged, so the app can place the card in the task that raised it */ createdAt: number; }

/** List pending actions, newest first. With `scope`, only those from that session or person — the
 *  model's own list/cancel tools are scoped (BL-03 review); the person's app lists everything. */
export function listPendingActions(scope?: { session?: string; personId?: string }): PendingView[] {
  prune();
  const now = Date.now();
  const rows = store().prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC`).all() as Row[];
  return rows.map(toAction)
    .filter((a) => !scope || inScope(a, scope))
    .map((a) => ({ id: a.id, tool: a.tool, summary: a.summary, expiresInSec: Math.max(0, Math.round((a.expiresAt - now) / 1000)), expiresAt: a.expiresAt, tainted: a.tainted === true, readLocal: a.readLocal === true, kind: a.kind ?? 'tool', session: a.session, ...(a.runId ? { runId: a.runId } : {}), ...(a.personId ? { personId: a.personId } : {}), createdAt: a.createdAt }));
}

/** Confirm + execute a pending action by id (omit id → the single most recent). Called only by
 *  channels the model cannot reach: the app's approval endpoint and the Telegram connector's
 *  Approve button. Unattended runs are gated, and so is the run that staged the action. */
export async function confirmPending(id: string | undefined, ctx: ToolContext): Promise<string> {
  prune();
  if (ctx.interactive === false && process.env.MWA_ALLOW_UNATTENDED_WRITES !== '1') {
    return '(refused: confirming a write needs a human present — this is an unattended/scheduled run. Set MWA_ALLOW_UNATTENDED_WRITES=1 only if you intend writes without a person watching.)';
  }
  const s = store();
  let key = (id ?? '').trim();
  if (!key) {
    const all = s.prepare(`SELECT id FROM approvals WHERE status = 'pending' ORDER BY created_at DESC`).all() as { id: string }[];
    if (all.length === 0) return '(nothing to confirm — no pending action)';
    if (all.length > 1) return `(ambiguous: ${all.length} pending actions — pass an explicit confirmation_id. Use list_pending to see them.)`;
    key = all[0].id;
  }
  const row = s.prepare(`SELECT * FROM approvals WHERE id = ?`).get(key) as Row | undefined;
  if (!row) return `(no pending action with id "${key}" — it may have expired or already run)`;
  if (row.status === 'expired') return `(confirmation "${key}" expired — re-run the action to get a fresh preview)`;
  if (row.status !== 'pending') return `(no pending action with id "${key}" — it was already ${row.status === 'executing' ? 'started' : row.status})`;
  const action = toAction(row);
  // SECOND GUARD (BL-03): the run that staged an action never approves it, whatever path it finds.
  if (ctx.runId && action.runId && ctx.runId === action.runId) {
    return '(refused: an action cannot be approved by the run that staged it — the person approves it in the app or with the Telegram button.)';
  }
  // S6 v2 STEP-UP GATE: from the identity state captured at dry-run time, on every confirm path. The
  // action stays pending so they can confirm again after completing step-up.
  if (action.identityInDoubt && action.personId && !isStepUpSatisfied(action.personId)) {
    return `(blocked: this person's identity is unverified — running "${action.tool}" requires a second factor. ` +
      `Complete step-up verification (a code sent to their validated connection) first, then confirm "${key}" again.)`;
  }
  const mine = !row.owner || row.owner === owner;
  if (mine && !localClosures.has(key) && !executors.has(row.executor)) {
    return `(this app can't run "${action.tool}" — approve it in the app where it was asked)`;
  }
  // THE APPROVAL: one atomic step out of pending, expiry included — two processes or two taps can't
  // both get past it, and a tap that lands after expiry can't approve it.
  const now = Date.now();
  const approved = s.prepare(`UPDATE approvals SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?`).run(mine ? 'executing' : 'approved', now, key, now).changes === 1;
  if (!approved) {
    const st = (s.prepare(`SELECT status FROM approvals WHERE id = ?`).get(key) as { status: string } | undefined)?.status;
    if (st === 'pending') { s.prepare(`UPDATE approvals SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'`).run(now, key); return `(confirmation "${key}" expired — re-run the action to get a fresh preview)`; }
    return `(no pending action with id "${key}" — it was already ${st === 'executing' ? 'started' : st ?? 'handled'})`;
  }
  audit?.('confirm', { id: action.id, tool: action.tool, summary: action.summary });
  // Another identity's action runs in ITS process, against its memory (BL-18 review).
  if (!mine) return `[APPROVED ${action.tool}] It runs in ${ownerLabel(row.owner)}, where it was asked for, within a minute or so.`;
  const r = await runClaimed(row);
  return r.ok ? `[CONFIRMED ${action.tool}]\n${r.result}` : `[CONFIRMED ${action.tool}] but it failed: ${r.result.slice(0, 300)}`;
}

/** Keep the head line (e.g. `exit=1`) and the TAIL — a test runner's failure summary comes last. */
function tail(s: string, n = 2000): string {
  if (s.length <= n) return s;
  const head = s.split('\n', 1)[0].slice(0, 120);
  return `${head}\n…\n${s.slice(-(n - head.length - 3))}`;
}

/** Run a row this process has claimed (status executing), in the context it was STAGED in — not the
 *  approver's — as interactive and untainted, since a person approved it. */
async function runClaimed(row: Row): Promise<{ ok: boolean; result: string }> {
  const s = store();
  const closure = localClosures.get(row.id);
  localClosures.delete(row.id);
  const exec = executors.get(row.executor);
  const stagedCtx = { ...parse<ToolContext>(row.ctx, { sandboxDir: '.' }), interactive: true, tainted: false };
  try {
    if (!closure && !exec) throw new Error(`this app has no way to run "${row.tool}"`);
    const result = String(closure ? await closure(stagedCtx) : await exec!(parse<Record<string, unknown>>(row.args, {}), stagedCtx));
    s.prepare(`UPDATE approvals SET status = 'done', result = ?, args = '{}', updated_at = ? WHERE id = ?`).run(tail(result), Date.now(), row.id);
    return { ok: true, result };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    s.prepare(`UPDATE approvals SET status = 'failed', result = ?, args = '{}', updated_at = ? WHERE id = ?`).run(tail(msg), Date.now(), row.id);
    return { ok: false, result: msg };
  }
}

/** Run the actions a person approved elsewhere that THIS process owns. Each process calls it on its
 *  own tick (Telegram on every poll, the web app beside its scheduler) and delivers the results. */
export async function runApproved(): Promise<{ id: string; tool: string; session?: string; ok: boolean; result: string }[]> {
  prune();
  const s = store();
  const rows = s.prepare(`SELECT * FROM approvals WHERE status = 'approved' AND owner = ? ORDER BY updated_at`).all(owner) as Row[];
  const out: { id: string; tool: string; session?: string; ok: boolean; result: string }[] = [];
  for (const row of rows) {
    // Too late: past the action's own expiry and past a short grace after the approval.
    if (Date.now() > Math.max(row.expires_at, row.updated_at + APPROVAL_GRACE_MS)) {
      s.prepare(`UPDATE approvals SET status = 'expired', result = 'approved, but the app that asked for it was not running in time — stage it again', args = '{}', updated_at = ? WHERE id = ? AND status = 'approved'`).run(Date.now(), row.id);
      continue;
    }
    if (s.prepare(`UPDATE approvals SET status = 'executing', updated_at = ? WHERE id = ? AND status = 'approved'`).run(Date.now(), row.id).changes !== 1) continue;
    const r = await runClaimed(row);
    out.push({ id: row.id, tool: row.tool, session: toAction(row).session, ...r });
  }
  return out;
}

/** Discard a pending action without running it. With `scope`, only one from that session or person. */
export function cancelPending(id: string, scope?: { session?: string; personId?: string }): string {
  prune();
  const s = store();
  const row = s.prepare(`SELECT * FROM approvals WHERE id = ? AND status = 'pending'`).get(id) as Row | undefined;
  if (!row) return `(no pending action with id "${id}")`;
  const a = toAction(row);
  if (scope && !inScope(a, scope)) return `(no pending action with id "${id}")`;
  if (s.prepare(`UPDATE approvals SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'`).run(Date.now(), id).changes !== 1) return `(no pending action with id "${id}")`;
  localClosures.delete(id);
  audit?.('cancel', { id: a.id, tool: a.tool, summary: a.summary });
  return `cancelled "${id}" (${a.tool}) — not executed`;
}

// ── Telegram offers (BL-18): one card per action, bound to the chat and message it was sent as ──────
/** Claim the right to offer an action in a chat. True for exactly one caller, ever. */
export function claimOffer(id: string, chat: string): boolean {
  // A claim whose card never went out (a crash between claim and send) can be re-claimed after 2 min.
  const now = Date.now();
  return store().prepare(`UPDATE approvals SET offer_chat = ?, updated_at = ? WHERE id = ? AND status = 'pending'
    AND (offer_chat IS NULL OR (offer_message IS NULL AND updated_at <= ?))`).run(chat, now, id, now - 120_000).changes === 1;
}
/** Record the message the card went out as. */
export function setOfferMessage(id: string, message: number): void {
  store().prepare(`UPDATE approvals SET offer_message = ? WHERE id = ?`).run(message, id);
}
/** Release a claim whose card failed to send, so it can be offered again. */
export function releaseOffer(id: string): void {
  store().prepare(`UPDATE approvals SET offer_chat = NULL, offer_message = NULL WHERE id = ? AND status = 'pending'`).run(id);
}
/** Where an action was offered. */
export function offerOf(id: string): { chat?: string; message?: number } {
  const r = store().prepare(`SELECT offer_chat, offer_message FROM approvals WHERE id = ?`).get(id) as Pick<Row, 'offer_chat' | 'offer_message'> | undefined;
  return { chat: r?.offer_chat ?? undefined, message: r?.offer_message ?? undefined };
}
/** Pending actions from these sessions that no channel has offered yet. */
export function unofferedFor(sessions: string[]): string[] {
  prune();
  const want = new Set(sessions);
  const rows = store().prepare(`SELECT * FROM approvals WHERE status = 'pending' AND (offer_chat IS NULL OR (offer_message IS NULL AND updated_at <= ?)) ORDER BY created_at`).all(Date.now() - 120_000) as Row[];
  return rows.map(toAction).filter((a) => a.session && want.has(a.session)).map((a) => a.id);
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
  // Its result is the WRAPPED tool's raw output, so it is classed external (BL-16) and only the
  // registry's flag can say it refused: the gate's own refusals are thrown, their words intact.
  handler: async (args, ctx) => {
    const out = await confirmPending(args.confirmation_id ? String(args.confirmation_id) : undefined, ctx);
    // A wrapped tool's result always comes back as [CONFIRMED …] or [APPROVED …]; anything else is the
    // gate's own refusal — so the prefix, not a guess at refusal wording, decides (a wrapped external
    // tool's text can't fake one).
    if (!/^\[(CONFIRMED|APPROVED) /.test(out)) throw new ToolRefusal(out);
    return out;
  },
};

/** The model sees and cancels only what its own conversation staged (BL-03 review). */
const scopeOf = (ctx: ToolContext) => (ctx.session ? { session: ctx.session } : { personId: ctx.personId });

const cancelActionTool: RegisteredTool = {
  def: {
    name: 'cancel_action',
    description: 'Discard a pending write action without running it (e.g. the human declined). Pass its confirmation_id.',
    parameters: { type: 'object', properties: { confirmation_id: { type: 'string' } }, required: ['confirmation_id'] },
  },
  handler: async (args, ctx) => cancelPending(String(args.confirmation_id ?? '').trim(), scopeOf(ctx)),
};

const listPendingTool: RegisteredTool = {
  def: {
    name: 'list_pending',
    description: 'List write actions from this conversation that await the person\'s approval (id, tool, preview, time left).',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  handler: async (_args, ctx) => {
    const all = listPendingActions(scopeOf(ctx));
    if (all.length === 0) return '(no pending actions)';
    return all.map((a) => `${a.id} — ${a.tool} — expires in ${a.expiresInSec}s\n  ${a.summary.slice(0, 200)}`).join('\n');
  },
};

/** What happened to actions this conversation staged, newest first (BL-14a): a recurring job that
 *  staged "run the tests" can read the outcome on its next fire and fix what failed. Same scope as
 *  list_pending. The output can carry what the approved command printed — text the model's own code
 *  produced — so it is classed as outside content (governance.ts) and fenced like any tool output. */
export function approvalOutcomes(scope: { session?: string; personId?: string }, limit = 10): { id: string; tool: string; status: ApprovalStatus; result?: string; at: number }[] {
  prune();
  if (!scope.session && !scope.personId) return [];
  // Filter by scope IN SQL, so a busy store can't push this conversation's results out of a window.
  const rows = (scope.session
    ? store().prepare(`SELECT * FROM approvals WHERE status <> 'pending' AND json_extract(ctx, '$.session') = ? ORDER BY updated_at DESC LIMIT ?`).all(scope.session, limit)
    : store().prepare(`SELECT * FROM approvals WHERE status <> 'pending' AND json_extract(ctx, '$.personId') = ? ORDER BY updated_at DESC LIMIT ?`).all(scope.personId, limit)) as Row[];
  return rows.map((r) => ({ r, a: toAction(r) })).filter(({ a }) => inScope(a, scope))
    .map(({ r }) => ({ id: r.id, tool: r.tool, status: r.status as ApprovalStatus, ...(r.result ? { result: r.result } : {}), at: r.updated_at }));
}

const approvalResultsTool: RegisteredTool = {
  def: {
    name: 'approval_results',
    description:
      'See what happened to actions this conversation or job staged for approval: approved and done (with what it printed), ' +
      'failed (with the error), declined, or expired. Use it on a later run to learn whether the tests or command you asked ' +
      'the person to approve passed, and fix what failed.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  handler: async (_args, ctx) => {
    const done = approvalOutcomes(scopeOf(ctx));
    if (!done.length) return '(nothing staged from this conversation has finished yet)';
    return done.map((d) => `${d.id} — ${d.tool} — ${d.status} at ${new Date(d.at).toISOString().slice(0, 16).replace('T', ' ')}${d.result ? `\n  ${tail(d.result, 1500)}` : ''}`).join('\n');
  },
};

/** The approval tools the MODEL gets: decline and look — never approve (BL-03). */
export function approvalTools(): RegisteredTool[] {
  return [cancelActionTool, listPendingTool, approvalResultsTool];
}
