/**
 * AWM substrate wrapper — in-process (proven by smoke.mjs).
 *
 * Exposes the essential decision-continuity trio the brain needs:
 *   recall(query)  → prior decisions/directions/patterns primed into context
 *   write(...)     → persist decisions/learnings (canonical pipeline: novelty,
 *                    salience, reinforce-on-dup, supersede-on-correction)
 *   feedback(...)  → close the Hebbian loop on recalled memories
 *
 * NullMemory is the AWM-OFF arm of the A/B/C ablation: recall→[], write→noop.
 * The brain is identical across arms; only the Memory impl swaps.
 *
 * (Formal task-ledger via getNextTask + cognitive scoring is a fast-follow;
 * v1 represents the brain's plan/decisions AS recallable memories — the pure
 * "decision continuity" thesis — which is what the benchmark measures.)
 */
// AWM's internals come through one file (BL-11): an AWM upgrade that moves them breaks awm-api.ts only.
import { loadEngines, loadSqliteStore, loadPGliteStore, loadPostgresStore, loadConflictOrder, type AwmEngines } from './awm-api.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isReservedConcept, unreservedConcept } from './reserved-concept.js';
import { scanRoutine, nextVersion } from './tools/routines.js';
import { normalizePersonId, type PersonNote, type PersonNoteKind } from './person.js';
import { nextDailyDue } from './schedule-request.js';
import { parseEvidence, formatEvidence, evidenceAfter, readyToArm, type DetectorEvidence, type DryScore } from './detector.js';

export interface RecalledMemory {
  id: string;
  concept: string;
  content: string;
  score: number;
  /** SPINE trust tier of the source engram. F2 reads this to isolate untrusted (inbox/web-mined)
   *  facts in the prompt so they can't be obeyed as instructions. Absent on non-AWM arms. */
  trust?: TrustTier;
  /** BL-48: when the memory was written (epoch ms), shown with it so newer can beat older. */
  at?: number;
  /** BL-55 (AWM 0.18): another returned memory about the same thing with a different time, date, amount, number or
   *  status — and whether THIS one is the newer. Under 0.18's default rerank the order no longer says which is newer. */
  conflicts?: { id: string; newer: boolean; slot: string }[];
}

/**
 * SPINE — where a memory or action came from. This is the security-critical axis:
 * `trust` is DERIVED from provenance and STAMPED by write() (see TRUST_BY_PROVENANCE),
 * never read from model output or memory content. Untrusted ingested content therefore
 * cannot self-elevate its own trust (the prompt-injection boundary F2 relies on).
 *   user     — a direct human utterance (only human-channel code paths may set this)
 *   inferred — the agent's own reasoning / learnings (default for legacy callers)
 *   ingested — extracted from external content (email/web) → untrusted
 *   tool     — tool output, which may derive from external data → untrusted (fail closed)
 */
export type Provenance = 'user' | 'inferred' | 'ingested' | 'tool';
export type TrustTier = 'high' | 'medium' | 'untrusted';

/** Provenance → trust. Stamped by the API; NOT influenced by content. */
export const TRUST_BY_PROVENANCE: Record<Provenance, TrustTier> = {
  user: 'high',
  inferred: 'medium',
  ingested: 'untrusted',
  tool: 'untrusted',
};

/** Rank for the "mixed sources → take the lowest" downgrade rule. */
const TRUST_RANK: Record<TrustTier, number> = { untrusted: 0, medium: 1, high: 2 };
/** Lowest of a set of trust tiers (fail toward untrusted). Empty → untrusted. */
export function lowestTrust(tiers: TrustTier[]): TrustTier {
  if (!tiers.length) return 'untrusted';
  return tiers.reduce<TrustTier>((lo, t) => (TRUST_RANK[t] < TRUST_RANK[lo] ? t : lo), 'high');
}

/** Tag prefixes the write API OWNS — a caller (or the model) may not supply these by hand;
 *  write() strips any it finds and re-derives them, so trust/provenance can't be smuggled in. */
// Tags the write API OWNS + re-derives → stripped from caller input so content can't smuggle them.
// NOTE: status=/version=/due=/effect=/undo= are deliberately NOT here — legitimate callers pass them
// in their tags array (scheduled tasks, routines, the action log), so stripping them would break
// those features. The invariant that keeps THAT safe is upstream: no caller ever forwards
// model-chosen tags to write() (every caller hardcodes its tag array), so content can't reach them.
// promoted=: only promoteRoutine sets it, through WriteOpts.promotedOf (BL-12 review).
const RESERVED_TAG_PREFIXES = ['trust=', 'src=', 'ns=', 'origin=', 'proj=', 'session=', 'promoted='];

/** Normalize a free-text namespace into a stable slug for the `ns=` tag. A non-empty input that
 *  slugs to empty (all-symbol) falls back to a constant rather than silently disabling scoping. */
function nsSlug(ns: string): string {
  const s = String(ns).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return s || 'ns';
}

export interface WriteOpts {
  canonical?: boolean;
  eventType?: 'observation' | 'decision' | 'friction' | 'surprise' | 'causal';
  surprise?: number;
  /** SECURITY: stamped into `trust=`; defaults to 'inferred' (medium). Never set from model/content. */
  provenance?: Provenance;
  /** Human-readable origin (sender / domain / url) for the provenance display in the Glass Box. */
  origin?: string;
  /** Soft topic namespace (`ns=`) for scoped recall (F5). */
  namespace?: string;
  /** F5: keep this write GLOBAL (cross-topic) — bypasses the instance's active namespace. Used by
   *  policies/skills/lessons/questions/scheduled-tasks so they're never trapped inside one topic. */
  global?: boolean;
  /** Never merge this write into an existing memory with the same concept (reinforcement). */
  noMerge?: boolean;
  /** INTERNAL — set only by promoteRoutine: this write is the skill a person promoted from that routine. */
  promotedOf?: string;
  /** INTERNAL — the lesson and skill stores' own writes (saveFriction, saveSkill, promoteRoutine): only
   *  these may use a `lesson:` / `skill:` concept (BL-38). */
  reservedConcept?: boolean;
  /** the PERSON named this memory themselves (onboarding): their concept is kept as written (BL-38). */
  ownName?: boolean;
  /** BL-74: the last day the fact holds (YYYY-MM-DD) — recalled after it as old, not as current (AWM temporal validity). */
  validTo?: string;
  /** BL-74: MWA's own logs (run records): short-lived, never canonical. */
  ephemeral?: boolean;
}

export { isReservedConcept, unreservedConcept } from './reserved-concept.js';

/** One recorded action the agent took (the "what it did" history + undo substrate). */
export interface ActionRecord {
  id: string;
  verb: string;
  summary: string;
  effect: 'external' | 'local' | 'read';
  tool?: string;
  undo?: string;
}

export interface Memory {
  readonly enabled: boolean;
  /** Keeps scheduled jobs although `enabled` is false (MWA_MEMORY=off, src/memory-off.ts): the jobs are
   *  the cron, not memory. */
  readonly keepsSchedules?: boolean;
  recall(query: string, opts?: { limit?: number; workspace?: string; full?: boolean; fast?: boolean; rerank?: boolean; expand?: boolean; namespace?: string }): Promise<RecalledMemory[]>;
  /** BL-75: the memories an abstract one (an `insight:`, a `position:`) rests on — its `causal` links, strongest
   *  first — so a conclusion is primed with the numbers under it. Optional: the comparison arms (src/gauntlet) have
   *  no links; AWM reads them. */
  sourcesOf?(id: string, limit?: number): Promise<RecalledMemory[]>;
  write(concept: string, content: string, tags?: string[], opts?: WriteOpts): Promise<string | null>;
  supersede(oldId: string, concept: string, content: string, tags?: string[], opts?: WriteOpts): Promise<string | null>;
  /** SPINE — record a side-effecting action (Glass Box history + undo). */
  logAction(a: { verb: string; summary: string; effect: 'external' | 'local' | 'read'; tool?: string; namespace?: string; undo?: string }): Promise<string | null>;
  /** SPINE — hard-delete a memory (F1 "forget"). */
  forget(id: string): Promise<boolean>;
  /** SPINE — trust tier stamped on an engram (fail-closed to 'untrusted'). */
  trustOf(engram: any): TrustTier;
  feedback(id: string, useful: boolean): Promise<void>;
  /** Lightly links all subsequent writes from this session via a `session=` tag (entity-bridge boost). */
  setSessionId(id: string): void;
  /** F5: set/clear the active topic namespace — scopes recall + stamps fact-writes (no cross-topic bleed). */
  setNamespace(ns?: string): void;
  /** Sleep consolidation (cluster/strengthen/decay); no-op when AWM is off. Returns cycle stats. */
  consolidate(): Promise<Record<string, number>>;
  /** Persist a scheduled task (due = epoch ms) in the AWM task store. */
  addScheduledTask(instruction: string, dueMs: number, opts?: ScheduleOpts): Promise<string | null>;
  /** All pending scheduled tasks — the fan-out budget counts them (BL-05). Absent when AWM is off. */
  pendingScheduled?(): Promise<ScheduledTask[]>;
  /** BL-56: changes recurring jobs' sources announced, for one person, newest first. Absent when AWM is off. */
  listChanges?(opts: { sinceMs: number; person: string; limit?: number }): Promise<{ content: string; at: number }[]>;
  /** BL-44: keep what a job's last good run reported. Absent when AWM is off. */
  setJobLastRun?(id: string, rec: JobLastRun): Promise<void>;
  /** BL-51: how many fires of this job in a row could not finish. Absent when AWM is off. */
  setJobFails?(id: string, n: number): Promise<void>;
  /** A goal by id or short id (BL-05). Absent when AWM is off. */
  getGoal?(idOrPrefix: string): Promise<Goal | null>;
  /** BL-71a: where a goal stands. Absent when AWM is off. */
  setGoalRecord?(goal: Goal, rec: { state: string; next?: string; open?: string[]; files?: string[]; conv?: string; by: GoalRecord['by']; untrusted?: boolean }): Promise<string | null>;
  getGoalRecord?(goalId: string): Promise<GoalRecord | null>;
  listGoalRecords?(): Promise<GoalRecord[]>;
  /** Persist a reusable procedure ("skill") recalled on similar future tasks. */
  saveSkill(name: string, steps: string, opts?: LearnOpts): Promise<string | null>;
  /** Persist a verbal failure reflection ("X failed because Y; next time Z") recalled
   *  before similar future tasks — the Reflexion learn-from-failure counterpart to saveSkill. */
  saveFriction(topic: string, lesson: string, opts?: LearnOpts): Promise<string | null>;
  /** Persist a STANDING user preference/policy ("never send without review", "keep summaries
   *  to 5 bullets") that should be honored on EVERY future task — not just relevant ones. */
  savePolicy(rule: string): Promise<string | null>;
  /** All standing preferences/policies (content), surfaced to the prompt every run. */
  listPolicies(): Promise<string[]>;
  /** Persist an open question the agent wants answered later (self-learning loop). */
  saveQuestion(question: string): Promise<string | null>;
  /** AWM 0.20: credits recalled memories whose identifiers appear in `text` (a reply, a write). Optional. */
  noteUse?(text: string, source: string): Promise<number>;
  close(): void;
}

/** How a run-end lesson or skill is stored. A run that read external content still teaches, but
 *  its lesson is untrusted (provenance `ingested`, flagged when recalled, never auto-primed) and not
 *  canonical; a run that read local files teaches at normal trust but not canonical. (BL-17) */
export interface LearnOpts { canonical?: boolean; untrusted?: boolean; /** the area a lesson is about, from the BL-35 judge — stored as an `area=` tag */ area?: string }

/** Options for a scheduled task — the job contract (BL-02) plus delivery and lineage. */
export interface ScheduleOpts {
  recur?: string; notify?: string; dir?: string; origin?: string; resumeAttempt?: number; check?: string; person?: string; tainted?: boolean;
  /** completion condition in plain words; a confirmed `complete` outcome stops a recurring job. */
  /** the job's own task, without resume framing (BL-10) */
  task?: string;
  until?: string;
  /** hard limits shown to every fire. */
  limits?: string;
  /** when to message the person: always (default) | changed | never. Failures always deliver. */
  deliver?: 'always' | 'changed' | 'never';
  /** what the job may do unattended in the browser (saved logins, named clicks), given by the person (2026-10-25). */
  allow?: import('./tools/registry.js').JobAllow;
  /** lineage (BL-05): 0 = a person scheduled it; a job made by a fire is its parent's depth + 1. */
  depth?: number;
  /** the job whose fire created this one (short id). */
  parent?: string;
  /** the goal that owns this job (full id). */
  goal?: string;
  /** the run that created it (short id) — a planned run's steps share one. */
  byRun?: string;
  /** a resume continues this job (short id): it keeps the job's lineage, so a resume can't reset depth. */
  resumeOf?: string;
  /** the person was told, once, that a follow-up this job wanted was refused by the fan-out budget. */
  budgetNotified?: boolean;
  /** skips quiet hours (BL-07) — set only from an attended, untainted conversation. */
  urgent?: boolean;
  /** BL-43: a reminder is DELIVERED as written when it fires — no run, nothing carried out. */
  kind?: 'reminder';
  /** BL-44: the person's own message that set the job up, verbatim — every fire sees their words and sources. */
  request?: string;
  /** v2 (A3a): the Job this task belongs to in app.db, and the queued Try it runs (src/v2/jobs.ts). A task carrying
   *  them was created by v2 code; one without them is mapped to a Job by the store hook (storeHooks.scheduled). */
  v2job?: string;
  v2try?: string;
}

/**
 * v2 (A3a): what the app's own state (app.db: Jobs and Tries, src/v2/jobs.ts) needs to hear from the memory store,
 * without the store knowing about it. A scheduled task added, paused, resumed, cancelled or restored, and where a
 * goal stands, all pass through here: the model's tools, the schedule controls, hand-offs and resumes alike. A hook
 * never throws into the store (each call is wrapped).
 */
export interface StoreHooks {
  scheduled?: (id: string, instruction: string, dueMs: number, opts: ScheduleOpts) => void;
  scheduleChanged?: (id: string, change: 'paused' | 'resumed' | 'canceled' | 'uncanceled' | 'moved', due?: number) => void;
  goalStatus?: (goalId: string, status: GoalStatus) => void;
  goalRecord?: (goalId: string, rec: { state: string; next?: string; by: string; untrusted?: boolean }) => void;
}
export const storeHooks: StoreHooks = {};
function hook(fn: () => void): void { try { fn(); } catch (e) { console.error('[awm] store hook failed:', (e as Error).message.slice(0, 160)); } }

/** BL-44: what a job's last good run reported, kept on the job itself — deterministic, per job, not recall.
 *  A watch keeps its last value and a short history of changes; a brief keeps when it last ran and what it said. */
export interface JobLastRun {
  at: number;
  summary: string;
  value?: string;
  valueAt?: number;
  /** each value this job has seen change to, oldest first (capped) */
  history?: { at: number; value: string }[];
  /** the memory holding this job's latest observation, superseded on the next change (BL-48) */
  obs?: string;
  /** a fingerprint of the whole last message, for "the same as last time" (BL-51) */
  sumHash?: string;
}

/** A goal (BL-05): an AWM task that owns scheduled jobs. Its status is the source of truth for
 *  whether those jobs run: done stops them, blocked pauses them. */
export type GoalStatus = 'open' | 'in_progress' | 'blocked' | 'done';
export type GoalPriority = 'urgent' | 'high' | 'medium' | 'low';
/** BL-71a: where a goal stands — its newest record. `by`: a run's end ('run'), MWA's own note ('note'), the person ('person'). */
export interface GoalRecord { id: string; goalId: string; text: string; at: number; by: 'run' | 'note' | 'person'; conv?: string; trust?: TrustTier }
export interface Goal { id: string; title: string; detail: string; status: GoalStatus; priority: GoalPriority; person?: string; createdAt?: number }
export const GOAL_STATUSES: GoalStatus[] = ['open', 'in_progress', 'blocked', 'done'];
export const GOAL_PRIORITIES: GoalPriority[] = ['urgent', 'high', 'medium', 'low'];

/** A pending scheduled task read back from the store. */
export interface ScheduledTask {
  id: string;
  instruction: string;
  due: number; // epoch ms
  recur?: string; // e.g. "every:60" (minutes) or "daily:09:00"
  notify?: string; // where to send the result (e.g. a session id)
  dir?: string; // working dir to REUSE (resume tasks reuse the original run's folder + files)
  /** The folder the task was CREATED in. Unlike `dir` it does NOT become the fired run's working
   *  folder — it is passed as an extra allowed root, so an absolute path the model baked into the
   *  instruction at schedule time still resolves when the task fires in its own fresh folder. */
  origin?: string;
  /** created by a run that had read external content — the fired run starts tainted (BL-17). */
  tainted?: boolean;
  /** the job contract (BL-02) */
  /** the job's own task, without resume framing (BL-10) */
  task?: string;
  until?: string;
  limits?: string;
  deliver?: 'always' | 'changed' | 'never';
  /** the person's allowance for unattended browser work (saved logins, named clicks). */
  allow?: import('./tools/registry.js').JobAllow;
  /** a fire reported `complete`; the next fire must confirm before the job stops. */
  pendingComplete?: boolean;
  resumeAttempt?: number; // 1-based resume count (auto-resume of an unfinished long run); absent = not a resume
  check?: string; // cheap change-detection command: if its output signature is unchanged, the fire is skipped (no model call)
  lastSig?: string; // signature (sha1 hex) of the check output at the last actual fire
  /** BL-08: a new check is a dry run until a person arms it (bound to the command's hash). Absent on
   *  checks from before BL-08, which keep skipping as they always did. */
  checkMode?: 'dry' | 'armed';
  checkArm?: string;
  checkEv?: DetectorEvidence;
  /** the person was told, once, that the dry run is ready to arm. */
  checkReady?: boolean;
  /** the last scored dry fire missed a change (reported once per record). */
  checkMissed?: boolean;
  /** Who scheduled it (normalized personId). Absent on tasks written before person tagging — those
   *  are treated as belonging to the shared/unknown profile, never to an identified person. */
  person?: string;
  /** lineage and ownership (BL-05) — see ScheduleOpts. Absent depth = 0. */
  depth?: number;
  parent?: string;
  goal?: string;
  byRun?: string;
  resumeOf?: string;
  budgetNotified?: boolean;
  urgent?: boolean;
  /** Paused by the person (usability review 2026-10-24, F04): the scheduler skips it until resumed. */
  paused?: boolean;
  /** BL-43: delivered as written when due — see ScheduleOpts.kind. */
  kind?: 'reminder';
  /** BL-44 — see ScheduleOpts.request and JobLastRun. */
  request?: string;
  lastRun?: JobLastRun;
  /** BL-51: fires in a row that could not finish (absent = 0). */
  fails?: number;
  /** v2 (A3a): see ScheduleOpts.v2job / v2try. */
  v2job?: string;
  v2try?: string;
}

// BL-59: AWM 0.18 orders the final window by the cross-encoder alone (rerank2, on by default), so recency no longer
// breaks a tie (F4 failed under it). AWM 0.18.1 marks two memories about one thing with different values and says
// which is newer; MWA's policy is newer beats older, so recall puts the newer of a marked pair first.

export class MwaMemory implements Memory {
  readonly enabled = true;
  private store: any;
  private activation: any;
  private connections: any;
  private consolidationEngine: any;
  /** AWM's engines and write pipeline, loaded in init (BL-11: loading them is no longer an import side effect). */
  private eng!: AwmEngines;
  private sessionId?: string;
  /** F5: the active topic namespace. When set, fact-writes are stamped ns=<topic> and recalls scope
   *  to that topic (+ global) — so rapid task-switching never bleeds one topic's facts into another. */
  private currentNamespace?: string;

  /** Workspace for cross-agent/hive recall (OPT-IN: isolated by default). When set, this agent
   *  registers into the workspace and recall spans every agent in it — so insights/decisions
   *  written by one agent/LLM/CLI are recallable by another sharing the workspace. */
  private readonly workspace?: string;

  private initPromise?: Promise<void>;

  constructor(
    private readonly agentId: string,
    private readonly dbPath: string,
    workspace?: string,
  ) {
    // The store + engines are created LAZILY (in init()) because a non-SQLite backend (PGlite /
    // Postgres) opens asynchronously. Construction stays sync + cheap; every method awaits init().
    this.workspace = workspace || process.env.MWA_WORKSPACE_SHARE || undefined;
  }

  /**
   * Lazily open the store for the configured backend (AWM_STORE_BACKEND: sqlite [default] | pglite |
   * postgres) and build the cognitive engines on it. Idempotent (single shared promise). MWA controls
   * the PATH via the constructor arg (a file for sqlite, a directory for pglite, or a connection string
   * for postgres) and the BACKEND via the env var — so multiple instances with different paths don't
   * clash (the gauntlet). await-over-a-sync-result is a no-op, so SQLite behaves exactly as before.
   */
  private async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      // The engines first: if AWM can't load, fail before a store is opened (BL-11 review).
      this.eng = await loadEngines();
      const backend = (process.env.AWM_STORE_BACKEND || '').toLowerCase();
      if (backend === 'pglite') {
        mkdirSync(this.dbPath, { recursive: true }); // PGlite path is a DIRECTORY
        const PGliteEngramStore = await loadPGliteStore();
        const s: any = new PGliteEngramStore(this.dbPath);
        await s.ready();
        this.store = s;
      } else if (backend === 'postgres') {
        // The postgres server adapter (pg + pgvector) ships in AWM; awm-api resolves it at run time.
        const PostgresEngramStore = await loadPostgresStore();
        const s: any = new PostgresEngramStore(process.env.AWM_DATABASE_URL ?? this.dbPath);
        if (typeof s.ready === 'function') await s.ready();
        this.store = s;
      } else {
        mkdirSync(dirname(this.dbPath), { recursive: true }); // SQLite path is a FILE
        const EngramStore = await loadSqliteStore();
        this.store = new EngramStore(this.dbPath);
      }
      this.activation = new this.eng.ActivationEngine(this.store);
      this.connections = new this.eng.ConnectionEngine(this.store, this.activation);
      if (this.workspace) this.joinWorkspace(this.workspace);
    })();
    this.initPromise.catch(() => { this.initPromise = undefined; }); // a failed init may be retried
    return this.initPromise;
  }

  /** Register this agent into a shared workspace (coord_agents) so workspace-scoped recall
   *  resolves it via getWorkspaceAgentIds. SQLite-only (reaches the raw better-sqlite3 db); a
   *  non-SQLite backend has no `.db`, so workspace coordination is skipped there. Best-effort. */
  private joinWorkspace(workspace: string): void {
    try {
      const db = (this.store as unknown as { db: any }).db;
      if (!db || typeof db.prepare !== 'function') return; // not SQLite → no coordination tables
      this.eng.initCoordinationTables(db);
      db.prepare(
        `INSERT OR REPLACE INTO coord_agents (id, name, workspace, status, role, last_seen)
         VALUES (?, ?, ?, 'idle', 'worker', datetime('now'))`,
      ).run(`${workspace}:${this.agentId}`, this.agentId, workspace);
    } catch (err) {
      console.error('[awm] joinWorkspace error:', (err as Error).message);
    }
  }

  async recall(query: string, opts: { limit?: number; workspace?: string; full?: boolean; fast?: boolean; rerank?: boolean; expand?: boolean; namespace?: string; internal?: boolean } = {}): Promise<RecalledMemory[]> {
    try {
      await this.init();
      const want = opts.limit ?? 5;
      const ns0 = opts.namespace ?? this.currentNamespace;
      const ns = ns0 ? nsSlug(ns0) : undefined;
      // Not routines or the action log (below). Fetched at the size asked, and again with 8 more only when the filter
      // dropped some from a full page — over-fetching every recall grew the reranker's pool by a third (BL-54 review).
      const activate = (limit: number) => this.activation.activate({
        agentId: this.agentId,
        context: query,
        // F5: when scoping to a topic, over-fetch generously then post-filter so we still return
        // `want` in-scope. This is best-effort, not a hard guarantee — on a heavily-interleaved
        // corpus an in-scope fact ranked beyond the over-fetch window can be missed (a false negative,
        // never a cross-topic bleed). Scoped recall is opt-in; the proper fix (push ns= into the
        // activation query) is the follow-on.
        limit,
        minScore: 0.05,
        // Default = RERANK-ONLY (rerank on, query-expansion OFF). Measured: expansion recovers
        // ZERO needles rerank-only misses even on heavy-paraphrase/vocab-mismatch queries (its
        // designed strength) — semantic embeddings + rerank already handle paraphrase — while it
        // ~doubles recall latency by inflating the rerank candidate pool. So it's off by default;
        // opt back in with expand:true. `fast` still drops both stages. (AWM_RECALL_EXPAND=1
        // restores expansion-by-default as an escape hatch.)
        useReranker: opts.rerank ?? !opts.fast,
        useExpansion: opts.expand ?? (opts.fast ? false : process.env.AWM_RECALL_EXPAND === '1'),
        // compact summaries truncate the precise value (e.g. drops "sqlite AND pglite");
        // for fact-lookup callers pass full:true to get the complete stored fact.
        granularity: opts.full ? 'full' : 'compact',
        // default to this agent's configured workspace → cross-agent recall when shared.
        workspace: opts.workspace ?? this.workspace,
        // BL-67: a real recall must count as one. internal:true (here since v1) skipped AWM's touch (the fade clock),
        // co-activation, the activation log and the recent-recalls list that implicit feedback credits, so MWA's
        // memories faded while in use and retrieval_feedback stayed empty. Benchmarks pass internal:true so their
        // probes don't train the store they measure.
        internal: opts.internal ?? process.env.MWA_RECALL_INTERNAL === '1', // =1 restores the old behaviour to compare
      });
      const kept = (rows: any[]) => rows.filter((r: any) => { const t = this.parseTags(r.engram.tags); return !t.includes('topic=routine') && !t.includes('topic=action-log'); });
      let results = await activate(ns ? want * 8 + 24 : want);
      if (!ns && results.length >= want && kept(results).length < want) results = await activate(want + 8);
      results = (await loadConflictOrder())(results, results.map((r: any) => r.conflictsWith ?? []));
      // F5 namespace scope: keep facts in THIS topic OR global (no ns=), drop OTHER topics — the
      // no-bleed guarantee. Global facts (user prefs, etc.) stay relevant across every topic.
      const rows: any[] = ns
        ? results.filter((r: any) => { const t = this.parseTags(r.engram.tags).find((x: string) => String(x).startsWith('ns=')); return !t || t.slice(3) === ns; })
        : results;
      // A ROUTINE never comes back from recall, by any path (BL-12 review: the model's own recall action
      // surfaced a proposed one). Its promoted copy is a skill; the routine itself is for the person's review.
      // Nor does the ACTION LOG (BL-54): it is the "what I did" record, read by recentActions. Recalled, each entry
      // is a snapshot of a tool's output — twelve copies of a flight page's old 10:15 outranked the job that saw
      // it move to 8:40 (BL-53 second pass).
      return kept(rows).slice(0, want).map((r: any) => ({
        id: r.engram.id,
        concept: r.engram.concept,
        content: opts.full ? r.engram.content : (r.summary ?? r.engram.content),
        score: r.score,
        trust: this.trustOf(r.engram),
        // BL-48: when it was noted, so an answer can tell the newer of two disagreeing facts.
        ...(r.engram.createdAt ? { at: new Date(r.engram.createdAt).getTime() } : {}),
        ...(Array.isArray(r.conflictsWith) && r.conflictsWith.length ? { conflicts: r.conflictsWith.map((c: any) => ({ id: String(c.id), newer: c.newer === true, slot: String(c.slot) })) } : {}),
      }));
    } catch (err) {
      console.error('[awm] recall error:', (err as Error).message);
      return [];
    }
  }

  /**
   * BL-75 — what an abstract memory rests on. Reconsolidation links an insight to its sources both ways with `causal`
   * associations (experience pilot, 2026-10-24); AWM's own spreading activation is off (D11), so the links are read here.
   * Only live memories come back: active, not superseded, not retracted.
   */
  async sourcesOf(id: string, limit = 3): Promise<RecalledMemory[]> {
    try {
      await this.init();
      const links = this.store.getAssociationsFor(id).filter((a: any) => a.type === 'causal').sort((a: any, b: any) => b.weight - a.weight);
      const ids = [...new Set(links.map((a: any) => (a.fromEngramId === id ? a.toEngramId : a.fromEngramId)))].filter((x) => x !== id).slice(0, limit * 2);
      if (!ids.length) return [];
      return (this.store.getEngramsByIds(ids) as any[])
        .filter((e) => e.stage === 'active' && !e.supersededBy && !e.retracted)
        .slice(0, limit)
        .map((e) => ({ id: e.id, concept: e.concept, content: e.content, score: 0, trust: this.trustOf(e), ...(e.createdAt ? { at: new Date(e.createdAt).getTime() } : {}) }));
    } catch (err) {
      console.error('[awm] sourcesOf error:', (err as Error).message);
      return [];
    }
  }

  async write(concept: string, content: string, tags: string[] = [], opts: WriteOpts = {}): Promise<string | null> {
    // Every model-chosen write comes through here (remember, auto-learn, recorded changes, the MCP memory
    // tools): none may land under a lesson or skill concept (BL-38).
    // Not a name the person chose themselves (ownName: onboarding) — "Skills: React" is theirs. Not keyed on
    // provenance 'user': a scheduled run's teach capture stamps that on model-written text (BL-38 review 3).
    if (!opts.reservedConcept && !opts.ownName && isReservedConcept(concept)) concept = unreservedConcept(concept);
    try {
      await this.init();
      // SPINE: stamp provenance + trust OUT OF BAND. Strip any reserved tags a caller (or the
      // model, via a caller that forwards model-chosen tags) tried to supply, then re-derive
      // them from the typed opts — so untrusted content can never set its own trust. Fail to
      // 'inferred'/medium for legacy callers; only explicit provenance:'user' earns high trust.
      const provenance: Provenance = opts.provenance ?? 'inferred';
      const trust = TRUST_BY_PROVENANCE[provenance];
      const safeTags = tags.filter((t) => !RESERVED_TAG_PREFIXES.some((p) => String(t).toLowerCase().startsWith(p)));
      if (opts.promotedOf) safeTags.push(`promoted=${opts.promotedOf}`);
      // Only a promotion may carry a person's "(promoted vN)" label: any other write that uses it — a model
      // saving a lookalike of a promoted skill — is stored without it (BL-12 review).
      if (!opts.promotedOf && /\s*\(promoted v\d+\)\s*$/i.test(concept)) concept = concept.replace(/\s*\(promoted v\d+\)\s*$/i, '');
      // F5: stamp the active topic namespace unless this write is explicitly global (policies etc.).
      const effectiveNs = opts.global ? undefined : (opts.namespace ?? this.currentNamespace);
      const stamped = [
        ...safeTags,
        `src=${provenance}`,
        `trust=${trust}`,
        ...(opts.origin ? [`origin=${String(opts.origin).replace(/[\r\n]+/g, ' ').slice(0, 80)}`] : []),
        ...(effectiveNs ? [`ns=${nsSlug(effectiveNs)}`] : []),
        'proj=MWA',
        ...(this.sessionId ? [`session=${this.sessionId}`] : []),
      ];
      // TRUST NEVER CROSSES A MERGE. AWM merges on concept equality into whichever same-concept memory
      // is closest in CONTENT, and the merged memory keeps the OLD memory's trust — so a merge across
      // trust classes either launders untrusted text into a trusted memory, or buries clean text in an
      // untrusted one. Four isolated-review rounds (BL-17) broke every narrower guard: blocking every
      // untrusted merge duplicated re-ingested facts; checking only the newest same-concept memory was
      // walked around with a planted decoy; letting identical text short-circuit ignored noMerge.
      // The rule: AWM may merge only when no same-concept memory of the OTHER trust class exists. When
      // the classes are mixed, MWA picks the target itself, and only within the write's own tier: an
      // identical write returns the existing memory, a correction supersedes the newest one.
      let mayMerge = !opts.noMerge;
      let correctionOf: string | null = null;
      if (mayMerge) {
        try {
          const c80 = concept.slice(0, 80);
          const find = async (tags?: string[]) => (await this.store.findActiveMatchByConcept(this.agentId, c80, tags)) ?? null;
          // A skill a PERSON promoted (BL-12) is their approved text: nothing merges into it or supersedes
          // it, whatever its trust — a same-named write is stored on its own.
          const sameConcept: any = await find();
          if (sameConcept && this.parseTags(sameConcept.tags).some((t: string) => String(t).startsWith('promoted='))) throw Object.assign(new Error('promoted'), { promoted: true });
          let otherClass: unknown = null;
          if (trust === 'untrusted') {
            otherClass = (await find(['trust=high'])) ?? (await find(['trust=medium']));
            if (!otherClass) { const newest = await find(); if (newest && this.trustOf(newest) !== 'untrusted') otherClass = newest; }
          } else {
            otherClass = await find(['trust=untrusted']);
          }
          const isCorrection = opts.eventType === 'surprise' || opts.eventType === 'friction';
          if (otherClass) {
            mayMerge = false;
            const mine = await find([`trust=${trust}`]);
            if (mine) {
              if (mine.content === content) return mine.id;
              if (isCorrection) correctionOf = mine.id;
            }
          } else if (trust === 'untrusted' && isCorrection) {
            // AWM's own correction path supersedes by concept in ANY stage (staged, archived) — out of
            // reach of an active-only check. So for untrusted text MWA always does the correction itself,
            // on a target verified untrusted, and AWM never sees a correction event (below).
            const mine = await find(['trust=untrusted']);
            // MWA does the correction, so AWM must not merge it into the old fact as a plain observation.
            if (mine && mine.content !== content) { correctionOf = mine.id; mayMerge = false; }
          }
        } catch { mayMerge = false; correctionOf = null; } // can't tell the classes apart, or a promoted skill → write it on its own
      }
      const result = await this.eng.performWrite(
        { store: this.store, connectionEngine: this.connections },
        {
          agentId: this.agentId,
          concept: concept.slice(0, 80),
          content,
          tags: stamped,
          memoryClass: opts.ephemeral ? 'ephemeral' : opts.canonical ? 'canonical' : 'working',
          ...(opts.validTo ? { validTo: opts.validTo } : {}),
          memoryType: 'semantic',
          enableReinforcement: mayMerge,
          // An untrusted write never reaches AWM as a correction: its supersede path has no stage check, so
          // it could retire a staged or archived TRUSTED memory (fifth BL-17 review). MWA corrects instead.
          eventType: trust === 'untrusted' && (opts.eventType === 'surprise' || opts.eventType === 'friction') ? 'observation' : (opts.eventType ?? 'observation'),
          surprise: opts.surprise ?? 0.3,
          decisionMade: opts.eventType === 'decision',
          causalDepth: 0.4,
          resolutionEffort: 0.3,
        },
      );
      const newId: string | null = result?.engram?.id ?? null;
      // ENFORCE ON WHAT HAPPENED, not on a prediction of it. AWM can match memories no pre-check sees —
      // archived (revived on match), staged, or the replacement of a superseded one, which may carry a
      // different concept. If it reinforced an existing memory with untrusted text, that memory now
      // contains untrusted text, so it IS untrusted: lower its trust. Worst case an attacker gets a fact
      // flagged; never text smuggled in under a trusted label (fifth BL-17 review).
      if (result?.action === 'reinforce' && trust === 'untrusted' && newId) {
        let merged: any = null;
        try { merged = await this.store.getEngram(newId); } catch (err) { console.error('[awm] SECURITY: could not re-read a merged memory:', newId, (err as Error).message); }
        if (merged && this.trustOf(merged) !== 'untrusted') {
          const mt: string[] = this.parseTags(merged.tags);
          const lowered = [...mt.filter((t) => !t.startsWith('trust=') && !t.startsWith('src=')), 'trust=untrusted', 'src=ingested'];
          // Retry once, then fail LOUDLY: a trusted label left on merged untrusted text is the exact
          // failure this exists to prevent.
          try { await this.store.updateTags(newId, lowered); } catch {
            try { await this.store.updateTags(newId, lowered); } catch (err) { console.error('[awm] SECURITY: could not mark a merged memory untrusted:', newId, (err as Error).message); }
          }
          // Visible, not silent: the person can see a fact of theirs was flagged, and why.
          try {
            await this.logAction({ verb: 'flagged a memory as untrusted', summary: `"${String(merged.concept ?? concept).slice(0, 60)}" now also holds text from an outside source, so it is shown as untrusted`, effect: 'local', tool: 'memory' });
          } catch { /* the flag itself stands */ }
        }
      }
      if (correctionOf && newId && newId !== correctionOf) {
        try { await this.store.supersedeEngram(correctionOf, newId); } catch { /* the new fact still stands */ }
      }
      return newId;
    } catch (err) {
      console.error('[awm] write error:', (err as Error).message);
      return null;
    }
  }

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  /** F5: set (or clear) the active topic namespace. While set, fact-writes are stamped ns=<topic>
   *  and recalls scope to that topic + global facts — the no-bleed guarantee. Pass undefined/empty
   *  to clear (back to unscoped). Global helpers (policies/skills/etc.) bypass via opts.global. */
  setNamespace(ns?: string): void {
    this.currentNamespace = ns && ns.trim() ? nsSlug(ns) : undefined;
  }

  async feedback(id: string, useful: boolean): Promise<void> {
    try {
      await this.init();
      const engram = await this.store.getEngram(id);
      if (!engram) return;
      const delta = useful ? 0.05 : -0.1;
      await this.store.updateConfidence(id, Math.max(0.01, Math.min(0.95, engram.confidence + delta)));
      this.activation.validationGate?.resolveFeedback?.(id, useful);
      if (useful) await this.store.touchEngram(id);
    } catch (err) {
      console.error('[awm] feedback error:', (err as Error).message);
    }
  }

  /**
   * Replace a stale fact with a corrected one and MARK the old as superseded —
   * the differentiator a notes-file/repo cannot match (files go silently stale).
   * Writes the new fact, then store.supersedeEngram(old,new) so recall stops
   * surfacing the old value. Returns the new engram id.
   */
  async supersede(oldId: string, concept: string, content: string, tags: string[] = [], opts: WriteOpts = {}): Promise<string | null> {
    // A skill a PERSON promoted is replaced only by promoting again or retiring it — never by a run (BL-12 review).
    try {
      await this.init();
      const old: any = oldId ? await this.store.getEngram(oldId) : null;
      if (old && this.parseTags(old.tags).some((t: string) => String(t).startsWith('promoted='))) return null;
      // A lesson or skill is the gated stores' own — a run can't rewrite one in place (BL-38 review: a refused
      // run superseded a trusted lesson with "queue the rest across later runs", and it stayed trusted).
      if (old && this.parseTags(old.tags).some((t: string) => t === 'topic=friction' || t === 'topic=skill') && !opts.reservedConcept) return null; // by the store's own tags, not the concept text: a person's "Skills: React" fact still updates (review 3)
    } catch { /* fall through: the write below is guarded again */ }
    // The caller's canonical/provenance win: a tainted run must not be able to replace a trusted fact
    // with a canonical one (BL-17 review). Canonical stays the default for ordinary corrections.
    // A memory that isn't the stores' own keeps its name when updated — a person's "Skills: React" fact, written
    // under that name, must not come back as "note: React" beside the stale original (BL-38 review 4).
    const keepName = isReservedConcept(concept) && !opts.reservedConcept;
    const newId = await this.write(concept, content, tags, { ...opts, canonical: opts.canonical ?? true, ...(keepName ? { ownName: true } : {}) });
    // Never supersede a memory by itself (identical text returns the same id) — it would drop out of recall.
    if (newId && oldId && newId !== oldId) {
      try {
        await this.store.supersedeEngram(oldId, newId);
      } catch (err) {
        console.error('[awm] supersede error:', (err as Error).message);
      }
    }
    return newId;
  }

  /**
   * F1 — a USER correction from the Glass Box: replace a fact with the user's authoritative text
   * (provenance=user → trust=high) and DETERMINISTICALLY remove the stale original. Distinct from
   * supersede(), which soft-marks history and can merge-on-reinforce when the new text is similar
   * (leaving the corrected fact ambiguous or self-superseded). A user saying "that's wrong, here's
   * the right value" wants the wrong value gone, not kept as fuzzy history — so forget-then-write.
   */
  async correctFact(oldId: string, concept: string, content: string): Promise<string | null> {
    await this.init();
    // Refuse to mint a high-trust memory for an id that doesn't resolve — blocks a forged/blind id
    // (e.g. a CSRF POST with a made-up id) from creating a trusted record out of thin air.
    let old: any = null;
    try { old = oldId ? await this.store.getEngram(oldId) : null; } catch { old = null; }
    if (!old) return null;
    // Forget the original FIRST so the corrected write can't reinforce-MERGE into the stale value
    // (which would leave a contradictory old+new blend). Then write the user's authoritative text.
    await this.forget(oldId);
    const newId = await this.write(concept.slice(0, 80) || 'correction', content, ['topic=world', 'intent=decision', 'confidence_level=verified'], { provenance: 'user', canonical: true, ownName: true }); // the person's own correction keeps their name (BL-38)
    if (!newId) {
      // Write failed — ROLL BACK: restore the original (content + its original trust tier) so the
      // user's data is never lost on the very operation meant to fix it.
      const t = this.trustOf(old);
      const prov: Provenance = t === 'high' ? 'user' : t === 'untrusted' ? 'ingested' : 'inferred';
      try { await this.write(String(old.concept ?? concept), String(old.content ?? ''), ['topic=world', 'intent=finding', 'confidence_level=observed'], { provenance: prov, canonical: true, ownName: true }); } catch { /* best-effort restore */ }
      return null;
    }
    return newId;
  }

  /**
   * Sleep consolidation — the mechanism that makes recall mature over time:
   * cluster overlapping engrams, strengthen intra-cluster edges, bridge related
   * topics, decay/forget noise, sweep staging. Run between sessions ("sleep").
   * Returns the cycle stats (clustersFound, edgesStrengthened, bridgesCreated, …).
   */
  async consolidate(): Promise<Record<string, number>> {
    try {
      await this.init();
      if (!this.consolidationEngine) this.consolidationEngine = new this.eng.ConsolidationEngine(this.store, this.connections);
      return (await this.consolidationEngine.consolidate(this.agentId)) as Record<string, number>;
    } catch (err) {
      console.error('[awm] consolidate error:', (err as Error).message);
      return {};
    }
  }

  // --- Scheduled tasks: AWM engrams tagged topic=scheduled-task + status + due=<epochMs>.
  // The task ledger holds the WHAT; the `due` tag is the WHEN (a universal integer).
  private parseTags(t: unknown): string[] {
    if (Array.isArray(t)) return t as string[];
    if (typeof t === 'string') { try { const p = JSON.parse(t); return Array.isArray(p) ? p : t.split(','); } catch { return t.split(','); } }
    return [];
  }

  async addScheduledTask(instruction: string, dueMs: number, opts: ScheduleOpts = {}): Promise<string | null> {
    const tags = ['topic=scheduled-task', 'status=pending', `due=${Math.round(dueMs)}`];
    // WHOSE task this is. One agent id serves every person on a shared deployment (serve, Telegram),
    // so without this tag a "what have I got scheduled?" tool would read back other people's
    // instructions. Always tagged (an unidentified caller normalizes to `unknown`) so the absence of
    // the tag means "written before person tagging existed", not "belongs to nobody".
    tags.push(`person=${normalizePersonId(opts.person)}`);
    if (opts.recur) tags.push(`recur=${opts.recur}`);
    if (opts.notify) tags.push(`notify=${opts.notify}`);
    if (opts.dir) tags.push(`dir=${opts.dir}`);
    // origin = where the task was CREATED. `dir` means "run in this folder" (resume); origin only
    // widens what the fired run may touch, so an absolute path baked into the instruction resolves.
    if (opts.origin) tags.push(`origin=${opts.origin}`);
    // Scheduled from a run that read external content: the fired run starts tainted, so what it
    // learns or schedules in turn stays marked (BL-17). Without this, one tainted turn could launder
    // itself through an unattended run that starts clean.
    if (opts.tainted) tags.push('tainted=1');
    // The job contract (BL-02). Free text goes base64 in tags, like `check`, so it survives as data.
    if (opts.until) tags.push(`until64=${Buffer.from(opts.until, 'utf8').toString('base64')}`);
    // A resume's own task, without its framing (BL-10): what a later resume must finish.
    if (opts.task) tags.push(`task64=${Buffer.from(opts.task.slice(0, 4000), 'utf8').toString('base64')}`);
    if (opts.limits) tags.push(`limits64=${Buffer.from(opts.limits, 'utf8').toString('base64')}`);
    if (opts.deliver && opts.deliver !== 'always') tags.push(`deliver=${opts.deliver}`);
    if (opts.allow && (opts.allow.vault?.length || opts.allow.click?.length)) tags.push(`allow64=${Buffer.from(JSON.stringify(opts.allow), 'utf8').toString('base64')}`);
    if (opts.resumeAttempt) tags.push(`resume=${opts.resumeAttempt}`);
    // Lineage and ownership (BL-05): what the fan-out budget counts, and what a goal owns.
    if (opts.depth) tags.push(`depth=${Math.max(0, Math.floor(opts.depth))}`);
    if (opts.parent) tags.push(`parent=${opts.parent.slice(0, 8)}`);
    if (opts.goal) tags.push(`goal=${opts.goal}`);
    if (opts.byRun) tags.push(`byrun=${opts.byRun.slice(0, 8)}`);
    if (opts.resumeOf) tags.push(`resumeof=${opts.resumeOf.slice(0, 8)}`);
    if (opts.urgent) tags.push('urgent=1');
    if (opts.kind === 'reminder') tags.push('kind=reminder');
    if (opts.request) tags.push(`request64=${Buffer.from(opts.request.slice(0, 2000), 'utf8').toString('base64')}`);
    if (opts.v2job && /^[\w-]{3,64}$/.test(opts.v2job)) tags.push(`v2job=${opts.v2job}`);
    if (opts.v2try && /^[\w-]{3,64}$/.test(opts.v2try)) tags.push(`v2try=${opts.v2try}`);
    // Base64 the check command so an arbitrary shell string (spaces, commas, pipes, '=') survives
    // both tag serializations (JSON array or comma-split). No commas in base64 → comma-split is safe.
    if (opts.check) tags.push(`check64=${Buffer.from(opts.check, 'utf8').toString('base64')}`, 'checkmode=dry'); // BL-08: starts disabled
    // noMerge: two tasks whose first 56 characters match are still two tasks. Merging appended one
    // task's instruction to the other and dropped the tainted tag (BL-17 review).
    // An IDENTICAL recurring task (same instruction, recurrence, owner and taint) is the same task:
    // return it instead of scheduling it twice. Anything else is written separately (noMerge) — merging
    // by concept appended one task's instruction to another and dropped its taint (BL-17 review).
    if (opts.recur) {
      try {
        const same = await this.store.findActiveMatchByConcept(this.agentId, `scheduled: ${instruction.slice(0, 56)}`.slice(0, 80), ['topic=scheduled-task', 'status=pending']);
        const st: string[] = same ? this.parseTags(same.tags) : [];
        // Identity includes the contract: the same instruction with a new limit ("never send") or a new
        // completion condition is a CHANGED job, not a duplicate (BL-02 review).
        const tag = (p: string) => st.find((t) => t.startsWith(p)) ?? '';
        const b64 = (v?: string) => (v ? Buffer.from(v, 'utf8').toString('base64') : '');
        const sameContract = tag('until64=').slice(8) === b64(opts.until) && tag('limits64=').slice(9) === b64(opts.limits) && tag('allow64=').slice(8) === (opts.allow ? b64(JSON.stringify(opts.allow)) : '')
          && (tag('deliver=').slice(8) || 'always') === (opts.deliver ?? 'always') && tag('check64=').slice(8) === b64(opts.check)
          && st.includes('kind=reminder') === (opts.kind === 'reminder');
        if (same && sameContract && same.content === instruction && st.includes(`recur=${opts.recur}`)
          && st.includes(`person=${normalizePersonId(opts.person)}`) && st.includes('tainted=1') === Boolean(opts.tainted)) {
          const had = tag('goal=').slice(5) || undefined;
          if (had === (opts.goal || undefined)) return same.id;
          // The same job, now for a goal: give the existing job the goal instead of running two copies.
          // Only a person, in an attended clean chat (depth 0, untainted), may put an existing job under
          // a goal — marking that goal done later stops the job (BL-05 review).
          if (!had && opts.goal && !opts.depth && !opts.tainted) { await this.setScheduledTags(same.id, (t) => [...t, `goal=${opts.goal}`]); return same.id; }
        }
      } catch { /* fall through to a separate write */ }
    }
    const id = await this.write(`scheduled: ${instruction.slice(0, 56)}`, instruction, tags, {
      // Canonical is the SALIENCE floor, not trust: a scheduled task must never be staged or discarded.
      // Trust comes from provenance — a tainted task is stored untrusted (flagged if recalled).
      canonical: true, eventType: 'decision', global: true, noMerge: true,
      ...(opts.tainted ? { provenance: 'ingested' as const } : {}),
    });
    if (id && storeHooks.scheduled) hook(() => storeHooks.scheduled!(id, instruction, Math.round(dueMs), opts));
    return id;
  }

  /** All pending scheduled tasks (parsed). */
  async pendingScheduled(): Promise<ScheduledTask[]> {
    try { return await this.pendingScheduledStrict(); } catch (err) { console.error('[awm] pendingScheduled error:', (err as Error).message); return []; }
  }
  /** v2 (A3a review): the same, but a store that cannot be read THROWS — "no tasks" and "couldn't look" differ
   *  (a data migration must not record itself done after a failed read). */
  async pendingScheduledStrict(): Promise<ScheduledTask[]> {
    {
      await this.init();
      const engrams: any[] = (await this.store.getEngramsByAgent(this.agentId)) ?? [];
      const out: ScheduledTask[] = [];
      for (const e of engrams) {
        const tags = this.parseTags(e.tags);
        if (!tags.includes('topic=scheduled-task') || !tags.includes('status=pending')) continue;
        const get = (p: string) => (tags.find((t) => t.startsWith(p)) ?? '').slice(p.length);
        const check64 = get('check64=');
        out.push({ id: e.id, instruction: e.content, due: Number(get('due=')) || 0, recur: get('recur=') || undefined, notify: get('notify=') || undefined, dir: get('dir=') || undefined, origin: get('origin=') || undefined, tainted: tags.includes('tainted=1') || undefined, until: get('until64=') ? Buffer.from(get('until64='), 'base64').toString('utf8') : undefined, limits: get('limits64=') ? Buffer.from(get('limits64='), 'base64').toString('utf8') : undefined, deliver: (get('deliver=') || undefined) as ScheduledTask['deliver'], pendingComplete: tags.includes('pendingcomplete=1') || undefined, resumeAttempt: Number(get('resume=')) || undefined, check: check64 ? Buffer.from(check64, 'base64').toString('utf8') : undefined, lastSig: get('lastsig=') || undefined, person: get('person=') || undefined, depth: Number(get('depth=')) || undefined, parent: get('parent=') || undefined, goal: get('goal=') || undefined, byRun: get('byrun=') || undefined, resumeOf: get('resumeof=') || undefined, budgetNotified: tags.includes('budgetnotified=1') || undefined, urgent: tags.includes('urgent=1') || undefined, fails: Number(get('fails=')) || undefined,
          checkMode: (get('checkmode=') || undefined) as ScheduledTask['checkMode'], checkArm: get('checkarm=') || undefined, checkEv: get('checkev=') ? parseEvidence(get('checkev=')) : undefined, checkReady: tags.includes('checkready=1') || undefined, checkMissed: tags.includes('checkmissed=1') || undefined,
          task: get('task64=') ? Buffer.from(get('task64='), 'base64').toString('utf8') : undefined,
          ...(tags.includes('kind=reminder') ? { kind: 'reminder' as const } : {}),
          ...(tags.includes('paused=1') ? { paused: true } : {}),
          ...(get('request64=') ? { request: Buffer.from(get('request64='), 'base64').toString('utf8') } : {}),
          ...(get('v2job=') ? { v2job: get('v2job=') } : {}), ...(get('v2try=') ? { v2try: get('v2try=') } : {}),
          ...(get('allow64=') ? { allow: ((): import('./tools/registry.js').JobAllow | undefined => { try { return JSON.parse(Buffer.from(get('allow64='), 'base64').toString('utf8')); } catch { return undefined; } })() } : {}),
          ...(get('lastrun64=') ? { lastRun: parseLastRun(get('lastrun64=')) } : {}) });
      }
      return out.sort((a, b) => a.due - b.due);
    }
  }

  // ── Schedule controls (usability review 2026-10-24, F04: a job could not be stopped from the app) ──
  /** A scheduled job by id, whatever its status (pending, done, canceled) — for the controls' ownership checks. */
  async getScheduled(id: string): Promise<{ id: string; status: string; person?: string; instruction: string; recur?: string; due: number; canceledAt?: number; paused: boolean; goal?: string; notify?: string; dir?: string; kind?: 'reminder'; task?: string; request?: string; resumeOf?: string } | null> {
    try {
      await this.init();
      const e = await this.store.getEngram(id);
      if (!e) return null;
      const tags = this.parseTags(e.tags);
      if (!tags.includes('topic=scheduled-task')) return null;
      const get = (p: string) => (tags.find((t) => t.startsWith(p)) ?? '').slice(p.length);
      return { id: e.id, status: get('status=') || 'pending', person: get('person=') || undefined, instruction: e.content, recur: get('recur=') || undefined,
        due: Number(get('due=')) || 0, canceledAt: Number(get('canceledat=')) || undefined, paused: tags.includes('paused=1'),
        // v2 migration (A3a) maps a finished job's results to its Job: what it was for and where it reported.
        ...(get('goal=') ? { goal: get('goal=') } : {}), ...(get('notify=') ? { notify: get('notify=') } : {}), ...(get('dir=') ? { dir: get('dir=') } : {}),
        ...(tags.includes('kind=reminder') ? { kind: 'reminder' as const } : {}), ...(get('resumeof=') ? { resumeOf: get('resumeof=') } : {}),
        ...(get('task64=') ? { task: Buffer.from(get('task64='), 'base64').toString('utf8') } : {}),
        ...(get('request64=') ? { request: Buffer.from(get('request64='), 'base64').toString('utf8') } : {}) };
    } catch { return null; }
  }
  /** Pause a pending job: it keeps its place and settings, and the scheduler skips it until resumed. */
  async pauseScheduled(id: string): Promise<void> {
    await this.setScheduledTags(id, (tags) => [...tags.filter((t) => t !== 'paused=1'), 'paused=1']);
    if (storeHooks.scheduleChanged) hook(() => storeHooks.scheduleChanged!(id, 'paused'));
  }
  /** Resume a paused job at its next natural slot (a daily job at its time, an interval job one interval from now,
   *  a one-off at its own time, which is now if that has passed). */
  async resumeScheduled(id: string, nowMs = Date.now()): Promise<void> {
    const cur = await this.getScheduled(id);
    if (!cur) return;
    const due = cur.recur?.startsWith('daily:') ? nextDailyDue(cur.recur, nowMs)
      : cur.recur?.startsWith('every:') ? nowMs + (Number(cur.recur.slice(6)) || 60) * 60_000
        : Math.max(cur.due, nowMs);
    await this.setScheduledTags(id, (tags) => [...tags.filter((t) => t !== 'paused=1' && !t.startsWith('due=')), `due=${Math.round(due)}`]);
    if (storeHooks.scheduleChanged) hook(() => storeHooks.scheduleChanged!(id, 'resumed', Math.round(due)));
  }
  /** Undo a cancel made in the last `withinMs` (ten minutes): the job is pending again, as it was. */
  async uncancelScheduled(id: string, withinMs = 10 * 60_000, nowMs = Date.now()): Promise<boolean> {
    const cur = await this.getScheduled(id);
    if (!cur || cur.status !== 'canceled' || !cur.canceledAt || nowMs - cur.canceledAt > withinMs) return false;
    await this.setScheduledTags(id, (tags) => tags.filter((t) => !t.startsWith('canceledat=')).map((t) => (t.startsWith('status=') ? 'status=pending' : t)));
    if (storeHooks.scheduleChanged) hook(() => storeHooks.scheduleChanged!(id, 'uncanceled'));
    return true;
  }

  private async setScheduledTags(id: string, mutate: (tags: string[]) => string[]): Promise<void> {
    try { await this.init(); const e = await this.store.getEngram(id); if (e) await this.store.updateTags(id, mutate(this.parseTags(e.tags))); } catch { /* */ }
  }
  /** Mark a scheduled task complete (status=done). */
  async completeScheduled(id: string): Promise<void> {
    await this.setScheduledTags(id, (tags) => tags.map((t) => (t.startsWith('status=') ? 'status=done' : t)));
  }
  /** BL-05: the person has been told this job's follow-up was refused by the fan-out budget. */
  async setBudgetNotified(id: string): Promise<void> {
    await this.setScheduledTags(id, (tags) => [...tags.filter((t) => t !== 'budgetnotified=1'), 'budgetnotified=1']);
  }
  /** Two-phase completion (BL-02): mark or clear "a fire said this job is complete". */
  async setPendingComplete(id: string, on: boolean): Promise<void> {
    await this.setScheduledTags(id, (tags) => [...tags.filter((t) => t !== 'pendingcomplete=1'), ...(on ? ['pendingcomplete=1'] : [])]);
  }
  /** Recurring task: set the next due (epoch ms), keep pending. */
  async rescheduleTask(id: string, nextDueMs: number): Promise<void> {
    await this.setScheduledTags(id, (tags) => [...tags.filter((t) => !t.startsWith('due=')), `due=${Math.round(nextDueMs)}`]);
    if (storeHooks.scheduleChanged) hook(() => storeHooks.scheduleChanged!(id, 'moved', Math.round(nextDueMs)));
  }
  /** BL-08: record a dry run's evidence, and (once) that the person was told it is ready to arm. */
  async setCheckEvidence(id: string, ev: DetectorEvidence, ready?: boolean): Promise<void> {
    await this.setScheduledTags(id, (tags) => [...tags.filter((t) => !t.startsWith('checkev=') && (ready === undefined || t !== 'checkready=1')), `checkev=${formatEvidence(ev)}`, ...(ready ? ['checkready=1'] : [])]);
  }
  /**
   * BL-08: record one dry-run fire — its score (null: a bootstrap or an inconclusive run) and the
   * signature it saw, which becomes the next baseline — in ONE update against the task as it is NOW.
   * A run can last minutes and a person may arm or disarm meanwhile; both clear the baseline, so a
   * baseline that no longer matches the one this fire predicted from means the record changed under
   * it, and nothing is written (BL-08 review). Returns what changed, for the person's notice.
   */
  async recordDryRun(id: string, o: { score: DryScore | null; sig: string; prevSig?: string }): Promise<{ ev: DetectorEvidence; nowReady: boolean; missedNews: boolean } | null> {
    let out: { ev: DetectorEvidence; nowReady: boolean; missedNews: boolean } | null = null;
    await this.setScheduledTags(id, (tags) => {
      if (!tags.includes('checkmode=dry')) return tags; // armed while the run was going
      const get = (p: string) => tags.find((t) => t.startsWith(p))?.slice(p.length);
      if (get('lastsig=') !== o.prevSig) return tags;   // disarmed (or re-baselined) meanwhile
      const withSig = [...tags.filter((t) => !t.startsWith('lastsig=')), `lastsig=${o.sig}`];
      const score = o.score;
      if (!score || score === 'inconclusive') return withSig;
      const before = parseEvidence(get('checkev='));
      const ev = evidenceAfter(before, score);
      const wasReady = tags.includes('checkready=1');
      const nowReady = score !== 'missed' && readyToArm(ev) && !wasReady;
      // A miss is news once per record: repeated misses on an empty record stay quiet (BL-08 review).
      const missedNews = score === 'missed' && !tags.includes('checkmissed=1');
      out = { ev, nowReady, missedNews };
      return [
        ...withSig.filter((t) => !t.startsWith('checkev=') && t !== 'checkready=1' && t !== 'checkmissed=1'),
        `checkev=${formatEvidence(ev)}`,
        ...((wasReady && score !== 'missed') || nowReady ? ['checkready=1'] : []),
        ...(score === 'missed' ? ['checkmissed=1'] : []),
      ];
    });
    return out;
  }
  /** BL-08: arm a detector for exactly this command, or put it back into a fresh dry run. Either way the
   *  baseline is cleared: armed, the next fire runs and sets one (a change seen only by a failed dry
   *  fire is not lost); disarmed, the dry run starts over with a bootstrap. */
  async setCheckMode(id: string, mode: 'dry' | 'armed', arm?: string): Promise<void> {
    await this.setScheduledTags(id, (tags) => [
      ...tags.filter((t) => !t.startsWith('checkmode=') && !t.startsWith('checkarm=') && !t.startsWith('lastsig=')
        && !(mode === 'dry' && (t.startsWith('checkev=') || t === 'checkready=1' || t === 'checkmissed=1'))),
      `checkmode=${mode}`, ...(mode === 'armed' && arm ? [`checkarm=${arm}`] : []),
    ]);
  }
  /** BL-45: the person changed what a job does. Same job — id, schedule, record and history stay — with a
   *  new instruction, and optionally the person's words added to its request and a new daily time. */
  async updateScheduledJob(id: string, change: { instruction: string; request?: string; recur?: string; due?: number; tainted?: boolean }): Promise<void> {
    await this.init();
    await this.store.updateContent(id, change.instruction);
    await this.setScheduledTags(id, (tags) => [
      ...tags.filter((t) => !(change.request !== undefined && t.startsWith('request64=')) && !(change.recur !== undefined && t.startsWith('recur=')) && !(change.due !== undefined && t.startsWith('due=')) && !(change.tainted && t === 'tainted=1')),
      // Rewritten after outside content: the job is marked for good (never unmarked by a later clean change).
      ...(change.tainted ? ['tainted=1'] : []),
      ...(change.request !== undefined ? [`request64=${Buffer.from(change.request.slice(-2000), 'utf8').toString('base64')}`] : []),
      ...(change.recur !== undefined ? [`recur=${change.recur}`] : []),
      ...(change.due !== undefined ? [`due=${Math.round(change.due)}`] : []),
    ]);
    if (change.due !== undefined && storeHooks.scheduleChanged) hook(() => storeHooks.scheduleChanged!(id, 'moved', Math.round(change.due!)));
  }
  /** BL-44: what this job's last good run reported (replaces the previous record). */
  async setJobFails(id: string, n: number): Promise<void> {
    await this.setScheduledTags(id, (tags) => [...tags.filter((t) => !t.startsWith('fails=')), ...(n > 0 ? [`fails=${Math.floor(n)}`] : [])]);
  }
  async setJobLastRun(id: string, rec: JobLastRun): Promise<void> {
    await this.setScheduledTags(id, (tags) => [...tags.filter((t) => !t.startsWith('lastrun64=')), `lastrun64=${Buffer.from(JSON.stringify(rec), 'utf8').toString('base64')}`]);
  }
  /** Record the change-detection signature (sha1 hex) captured at the last actual fire, so the next
   *  tick can skip the (expensive) agent run when nothing has changed. */
  async setScheduledSignature(id: string, sig: string): Promise<void> {
    await this.setScheduledTags(id, (tags) => [...tags.filter((t) => !t.startsWith('lastsig=')), `lastsig=${sig}`]);
  }

  /** Cancel a pending scheduled task (status=canceled). Deliberately NOT completeScheduled: "the
   *  person called it off" and "it ran to completion" are different facts, and collapsing them
   *  destroys the only audit trail of an automation that was stopped. Both leave pendingScheduled. */
  async cancelScheduled(id: string, nowMs = Date.now()): Promise<void> {
    // `canceledat` lets the person undo a cancel for a few minutes (uncancelScheduled).
    await this.setScheduledTags(id, (tags) => [...tags.filter((t) => !t.startsWith('canceledat=')).map((t) => (t.startsWith('status=') ? 'status=canceled' : t)), `canceledat=${Math.round(nowMs)}`]);
    if (storeHooks.scheduleChanged) hook(() => storeHooks.scheduleChanged!(id, 'canceled'));
  }

  // ── Goals (BL-05) ────────────────────────────────────────────────────────────────────────────
  // Stored like scheduled tasks — tags are the source of truth, so every storage backend works — and
  // mirrored into AWM's native task fields where the store has them, so AWM's own task tools
  // (memory_task_list and friends) see the same goals.

  /** Create a goal; returns its id. */
  async addGoal(title: string, detail: string, priority: GoalPriority = 'medium', person?: string): Promise<string | null> {
    const p = GOAL_PRIORITIES.includes(priority) ? priority : 'medium';
    const id = await this.write(`goal: ${title}`.slice(0, 80), detail ? `${title}\n\n${detail}` : title,
      ['topic=goal', 'gstatus=open', `gprio=${p}`, `person=${normalizePersonId(person)}`, 'task'],
      { canonical: true, eventType: 'decision', global: true, noMerge: true });
    if (id) await this.mirrorGoal(id, 'open', p);
    return id;
  }

  private async mirrorGoal(id: string, status: GoalStatus, priority?: GoalPriority): Promise<void> {
    try {
      await this.init();
      if (typeof this.store.updateTaskStatus === 'function') await this.store.updateTaskStatus(id, status);
      if (priority && typeof this.store.updateTaskPriority === 'function') await this.store.updateTaskPriority(id, priority);
    } catch { /* the tags stay the source of truth */ }
  }

  private toGoal(e: any): Goal | null {
    const tags = this.parseTags(e.tags);
    // gstatus= too: AWM's own session summaries inherit the topic tag of what they summarize, and one came back as
    // a goal called "Session summary (topic=goal, 3 turns)" (hard test 2026-10-23). Every real goal carries a status.
    if (!tags.includes('topic=goal') || !tags.some((t) => t.startsWith('gstatus='))) return null;
    const get = (p: string) => (tags.find((t) => t.startsWith(p)) ?? '').slice(p.length);
    const [title, ...rest] = String(e.content ?? '').split('\n\n');
    const status = get('gstatus=') as GoalStatus;
    const priority = get('gprio=') as GoalPriority;
    return {
      id: e.id, title: title || String(e.concept ?? '').replace(/^goal: /, ''), detail: rest.join('\n\n'),
      status: GOAL_STATUSES.includes(status) ? status : 'open', priority: GOAL_PRIORITIES.includes(priority) ? priority : 'medium',
      person: get('person=') || undefined, createdAt: e.createdAt ? new Date(e.createdAt).getTime() : undefined,
    };
  }

  /** Goals, open ones first by priority. THROWS when the store can't be read — "no goals" and
   *  "couldn't look" must not look alike (BL-05 review: one failed read stopped every job an open
   *  goal owned). listGoals() is the forgiving wrapper for display. */
  async listGoalsStrict(): Promise<Goal[]> {
    await this.init();
    const all: any[] = (await this.store.getEngramsByAgent(this.agentId)) ?? [];
    const rank = (g: Goal) => (g.status === 'done' ? 10 : 0) + GOAL_PRIORITIES.indexOf(g.priority);
    return all.filter((e) => !e.retracted).map((e) => this.toGoal(e)).filter((g): g is Goal => g !== null).sort((a, b) => rank(a) - rank(b));
  }
  async listGoals(): Promise<Goal[]> {
    try { return await this.listGoalsStrict(); } catch { return []; }
  }

  /** A goal by full id or a unique prefix of at least 4 characters; null when there is no such goal.
   *  THROWS when the store can't be read. */
  async getGoal(idOrPrefix: string): Promise<Goal | null> {
    const want = String(idOrPrefix ?? '').trim().toLowerCase();
    if (want.length < 4) return null;
    const hits = (await this.listGoalsStrict()).filter((g) => g.id.toLowerCase().startsWith(want));
    return hits.length === 1 ? hits[0] : null;
  }

  /** Set a goal's status (tags + AWM's native task field). */
  async setGoalStatus(id: string, status: GoalStatus): Promise<void> {
    if (!GOAL_STATUSES.includes(status)) return;
    await this.setScheduledTags(id, (tags) => [...tags.filter((t) => !t.startsWith('gstatus=')), `gstatus=${status}`]);
    await this.mirrorGoal(id, status);
    if (storeHooks.goalStatus) hook(() => storeHooks.goalStatus!(id, status));
  }

  // ── Where a goal stands (BL-71a) ──────────────────────────────────────────────────────────────
  // Memory kept what a run DID ("agent run: …") but not where the work STANDS — so "what were you working
  // on?" got a recap with nothing to resume from (Robert, 2026-10-22: "if I say hey report back what you
  // were working on I should be able to jump right to it"). One record per goal, replaced on each update
  // (the old one superseded, so recall prefers the newest), written in the words a later question uses.

  /** Replace a goal's record. `untrusted`: written by a run that read outside content. */
  async setGoalRecord(goal: Goal, rec: { state: string; next?: string; open?: string[]; files?: string[]; conv?: string; by: GoalRecord['by']; untrusted?: boolean }): Promise<string | null> {
    const at = Date.now();
    const lines = [
      `Where we are on "${goal.title}" (goal ${goal.id.slice(0, 8)}, ${goal.status.replace('_', ' ')}): ${rec.state.replace(/\s+/g, ' ').trim().slice(0, 700)}`,
      rec.next ? `Next step: ${rec.next.replace(/\s+/g, ' ').trim().slice(0, 300)}` : '',
      rec.open?.length ? `Open items: ${rec.open.slice(0, 8).map((o) => o.replace(/\s+/g, ' ').trim().slice(0, 160)).join('; ')}` : '',
      rec.files?.length ? `Files: ${rec.files.slice(0, 12).map((f) => f.replace(/[\r\n,]+/g, ' ').trim().slice(0, 300)).join(', ')}` : '', // one line: a note can't forge a "Next step:" line
      rec.conv ? `From conversation ${rec.conv}.` : '',
      `Updated ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC by ${rec.by === 'run' ? 'a run' : rec.by === 'note' ? 'MWA' : 'the person'}.`,
    ].filter(Boolean).join('\n');
    const tags = ['topic=goal-record', `goalrec=${goal.id}`, `goal=${goal.id.slice(0, 8)}`, `person=${normalizePersonId(goal.person)}`, `grby=${rec.by}`, `grat=${at}`,
      ...(rec.conv ? [`conv=${rec.conv.slice(0, 60)}`] : [])];
    const opts: WriteOpts = { canonical: !rec.untrusted, eventType: 'observation', global: true, noMerge: true, ...(rec.untrusted ? { provenance: 'ingested' as const } : {}) };
    const prev = await this.getGoalRecord(goal.id);
    if (storeHooks.goalRecord) hook(() => storeHooks.goalRecord!(goal.id, { state: rec.state, next: rec.next, by: rec.by, untrusted: rec.untrusted }));
    return prev ? this.supersede(prev.id, `where we are: ${goal.title}`.slice(0, 80), lines, tags, opts) : this.write(`where we are: ${goal.title}`.slice(0, 80), lines, tags, opts);
  }

  /** A goal's newest record, or null. */
  async getGoalRecord(goalId: string): Promise<GoalRecord | null> {
    return (await this.listGoalRecords()).find((r) => r.goalId === goalId) ?? null;
  }

  /** Every goal's newest record, newest first. */
  async listGoalRecords(): Promise<GoalRecord[]> {
    try { return await this.listGoalRecordsStrict(); } catch { return []; }
  }
  /** v2 (A3a review): every goal's newest record; THROWS when the store cannot be read. */
  async listGoalRecordsStrict(): Promise<GoalRecord[]> {
    {
      await this.init();
      const all: any[] = (await this.store.getEngramsByAgent(this.agentId)) ?? [];
      const newest = new Map<string, GoalRecord>();
      for (const e of all) {
        if (e.retracted) continue;
        const tags = this.parseTags(e.tags);
        if (!tags.includes('topic=goal-record')) continue;
        const get = (p: string) => (tags.find((t) => t.startsWith(p)) ?? '').slice(p.length);
        const r: GoalRecord = { id: e.id, goalId: get('goalrec='), text: String(e.content ?? ''), at: Number(get('grat=')) || 0, by: (get('grby=') || 'run') as GoalRecord['by'],
          conv: get('conv=') || undefined, trust: this.trustOf(e) };
        const cur = newest.get(r.goalId);
        if (!cur || r.at > cur.at) newest.set(r.goalId, r);
      }
      return [...newest.values()].sort((a, b) => b.at - a.at);
    }
  }

  // ── Open items (BL-50) ───────────────────────────────────────────────────────────────────────
  // What needs the PERSON: a reply owed, a bill, a deadline, a renewal, a request from staff. BL-40: asked
  // "what still needs my attention this coming week?", MWA answered with its own job schedule; the lease
  // renewal, a new wedding inquiry and a day-off swap its briefs had seen went unmentioned. Kept like goals
  // (tags are the source of truth), but apart from them: an item is information — usually read from an
  // inbox — never an instruction and never an owner of jobs, so one written after outside content is stored
  // untrusted.

  /** Add an open item, or refresh the open one it repeats (same words) — a daily brief sees the same email. */
  async addOpenItem(item: { what: string; who?: string; due?: string; source?: string; person?: string; untrusted?: boolean }): Promise<{ id: string; updated: boolean } | null> {
    const what = item.what.replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!what) return null;
    const person = normalizePersonId(item.person);
    const key = openItemKey(what);
    const existing = (await this.listOpenItems(person)).find((o) => openItemKey(o.what) === key);
    const meta = [...(item.who ? [`who64=${b64(item.who.slice(0, 120))}`] : []), ...(item.due && /^\d{4}-\d{2}-\d{2}$/.test(item.due) ? [`odue=${item.due}`] : []), ...(item.source ? [`osrc64=${b64(item.source.slice(0, 200))}`] : [])];
    if (existing) {
      await this.setScheduledTags(existing.id, (tags) => [...tags.filter((t) => !(meta.some((m) => m.split('=')[0] === t.split('=')[0]))), ...meta]);
      return { id: existing.id, updated: true };
    }
    const id = await this.write(`open item: ${what}`.slice(0, 80), what, ['topic=open-item', 'ostatus=open', `person=${person}`, ...meta],
      { canonical: true, eventType: 'observation', global: true, noMerge: true, ...(item.untrusted ? { provenance: 'ingested' as const } : {}) });
    return id ? { id, updated: false } : null;
  }

  /** This person's open items (or closed ones too), soonest due first, undated after. */
  async listOpenItems(person?: string, includeClosed = false): Promise<OpenItem[]> {
    try {
      await this.init();
      const me = normalizePersonId(person);
      const all: any[] = (await this.store.getEngramsByAgent(this.agentId)) ?? [];
      const out: OpenItem[] = [];
      for (const e of all) {
        if (e.retracted) continue;
        const tags = this.parseTags(e.tags);
        if (!tags.includes('topic=open-item') || !tags.includes(`person=${me}`)) continue;
        const get = (p: string) => (tags.find((t) => t.startsWith(p)) ?? '').slice(p.length);
        const status = get('ostatus=') === 'closed' ? 'closed' : 'open';
        if (status === 'closed' && !includeClosed) continue;
        out.push({ id: e.id, what: String(e.content ?? ''), status, trust: this.trustOf(e),
          ...(get('who64=') ? { who: unb64(get('who64=')) } : {}), ...(get('odue=') ? { due: get('odue=') } : {}),
          ...(get('osrc64=') ? { source: unb64(get('osrc64=')) } : {}), ...(get('oclosed64=') ? { closedWhy: unb64(get('oclosed64=')) } : {}),
          ...(e.createdAt ? { createdAt: new Date(e.createdAt).getTime() } : {}) });
      }
      return out.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || (a.createdAt ?? 0) - (b.createdAt ?? 0));
    } catch { return []; }
  }

  /** Close an open item, with why. */
  async closeOpenItem(id: string, why?: string): Promise<void> {
    await this.setScheduledTags(id, (tags) => [...tags.filter((t) => !t.startsWith('ostatus=') && !t.startsWith('oclosed64=')), 'ostatus=closed', ...(why ? [`oclosed64=${b64(why.slice(0, 200))}`] : [])]);
  }

  /** Rough count of stored memories for this agent — powers the UI "memory meter". */
  async memoryCount(): Promise<number> {
    try { await this.init(); return ((await this.store.getEngramsByAgent(this.agentId)) ?? []).length; } catch { return 0; }
  }

  /** Recent memories (newest-first), for the UI "Memory" view — makes the substrate
   *  tangible. Filters out internal bookkeeping engrams (run outcomes, session/sleep
   *  summaries, scheduled tasks) so the user sees only genuine learned facts. */
  async recentMemories(limit = 40): Promise<{ id: string; concept: string; content: string; trust: TrustTier; provenance: string; origin?: string }[]> {
    try {
      await this.init();
      const all: any[] = (await this.store.getEngramsByAgent(this.agentId)) ?? [];
      // Exclude superseded engrams so a corrected fact doesn't show alongside its replacement.
      const facts = all.filter((e) => !e.supersededBy && !/^(agent run:|agent step:|session:|scheduled:|skill:|question:|lesson:|policy:|action:)/i.test(String(e.concept ?? '')));
      return facts.slice(-limit).reverse().map((e) => {
        const tags = this.parseTags(e.tags);
        const get = (p: string) => { const x = tags.find((t) => String(t).startsWith(p)); return x ? x.slice(p.length) : undefined; };
        // F1 Glass Box: surface where each fact came from + how much it's trusted. Legacy engrams
        // written before the spine have no src= tag → 'unknown' (honest), and trustOf fails them
        // closed to 'untrusted' — so the two labels agree instead of contradicting.
        return { id: e.id, concept: e.concept ?? '', content: String(e.content ?? '').slice(0, 240), trust: this.trustOf(e), provenance: get('src=') ?? 'unknown', origin: get('origin=') };
      });
    } catch { return []; }
  }

  /** F1 — export everything MWA knows as portable Markdown ("it's yours"): preferences, learned
   *  facts with provenance + trust, skills, and recent actions. Powers the Glass Box export button. */
  async exportMarkdown(): Promise<string> {
    const out: string[] = ['# What MWA knows about you', ''];
    const policies = await this.listPolicies();
    if (policies.length) { out.push(`## Preferences I always follow (${policies.length})`, ''); for (const p of policies) out.push(`- ${p}`); out.push(''); }
    const facts = await this.recentMemories(1000);
    out.push(`## Learned facts (${facts.length})`, '');
    for (const f of facts) {
      const src = f.provenance === 'ingested' ? `from ${f.origin ?? 'email/web'}` : f.provenance === 'user' ? 'you told me' : f.provenance === 'unknown' ? 'source not recorded' : 'my own inference';
      out.push(`- **${f.concept}** — ${String(f.content).replace(/\s*\n+\s*/g, ' ')}  _(${src}; trust: ${f.trust})_`);
    }
    out.push('');
    const skills = await this.listSkills();
    if (skills.length) { out.push(`## Skills I can repeat (${skills.length})`, ''); for (const s of skills) out.push(`- **${s.name}**: ${s.content}`); out.push(''); }
    const actions = await this.recentActions(100);
    if (actions.length) { out.push(`## Recent actions (${actions.length})`, ''); for (const a of actions) out.push(`- ${a.verb} — ${a.summary}${a.tool ? ` [${a.tool}]` : ''}`); out.push(''); }
    return out.join('\n');
  }

  /** SPINE — the trust tier stamped on an engram, fail-closed to 'untrusted' on missing/invalid.
   *  F2's injection gate reads this to decide whether a fact may drive a privileged action. */
  trustOf(engram: any): TrustTier {
    // Reads EVERY trust= tag, lowest wins. AWM consolidation's duplicate prune gives the survivor the
    // UNION of both memories' tags, so one memory can carry trust=medium AND trust=untrusted; reading
    // only the first tag called that trusted while a tag-filtered lookup called it untrusted (BL-17,
    // sixth review). Any untrusted, missing or unknown value makes the memory untrusted.
    try {
      const vals = this.parseTags(engram?.tags).filter((t) => String(t).toLowerCase().startsWith('trust=')).map((t) => String(t).slice(6).toLowerCase());
      if (!vals.length || vals.some((v) => v !== 'high' && v !== 'medium')) return 'untrusted';
      return vals.includes('medium') ? 'medium' : 'high';
    } catch { return 'untrusted'; }
  }

  /** SPINE — record an ACTION the agent took (especially side-effecting ones) as a first-class
   *  engram: the substrate for the Glass Box "what it did" history (F1) and one-click undo (F3).
   *  Actions are provenance=tool (untrusted) so a logged action can never elevate a future
   *  decision. `undo` carries a short machine hint for how to reverse it (e.g. a draft/message id). */
  async logAction(a: { verb: string; summary: string; effect: 'external' | 'local' | 'read'; tool?: string; namespace?: string; undo?: string }): Promise<string | null> {
    const tags = ['topic=action-log', `effect=${a.effect}`, 'intent=context'];
    if (a.tool) tags.push(`tool=${nsSlug(a.tool)}`);
    if (a.undo) tags.push(`undo=${String(a.undo).replace(/[\r\n]+/g, ' ').slice(0, 120)}`);
    return this.write(`action: ${a.verb}`.slice(0, 80), a.summary, tags, { eventType: 'observation', provenance: 'tool', namespace: a.namespace });
  }

  /** Recent actions (newest-first) for the "what it did" history + undo (F1/F3). */
  async recentActions(limit = 40): Promise<ActionRecord[]> {
    try {
      await this.init();
      const all: any[] = (await this.store.getEngramsByAgent(this.agentId)) ?? [];
      return all.filter((e) => this.parseTags(e.tags).includes('topic=action-log')).slice(-limit).reverse().map((e) => {
        const t = this.parseTags(e.tags);
        const get = (p: string) => { const x = t.find((y) => String(y).startsWith(p)); return x ? x.slice(p.length) : undefined; };
        const eff = get('effect=');
        return {
          id: e.id,
          verb: String(e.concept ?? '').replace(/^action:\s*/i, ''),
          summary: String(e.content ?? '').slice(0, 300),
          effect: (eff === 'external' || eff === 'read' ? eff : 'local') as 'external' | 'local' | 'read',
          tool: get('tool='),
          undo: get('undo='),
        };
      });
    } catch { return []; }
  }

  /** PRIVACY (F1 "forget") — hard-delete a memory by id. Irreversible; used by the Glass Box
   *  delete control and by undo when reverting a memory the agent just learned. */
  async forget(id: string): Promise<boolean> {
    try { await this.init(); await this.store.deleteEngram(id); return true; } catch (err) { console.error('[awm] forget error:', (err as Error).message); return false; }
  }

  /** Persist a reusable procedure ("skill") as a canonical memory. Tagged topic=skill so
   *  auto-prime recalls it on similar future tasks — the agent learns HOW, not just WHAT. */
  async saveSkill(name: string, steps: string, opts: LearnOpts = {}): Promise<string | null> {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    return this.write(`skill: ${name}`.slice(0, 80), steps, ['topic=skill', `skill=${slug}`, 'intent=procedural', 'confidence_level=observed'], { reservedConcept: true, canonical: opts.canonical ?? true, eventType: 'observation', global: true, ...(opts.untrusted ? { provenance: 'ingested' as const } : {}) });
  }

  /** REFLEXION: record a verbal failure reflection as a canonical memory tagged topic=friction
   *  + eventType=friction, so auto-prime recalls it before similar future tasks. The failure
   *  counterpart of saveSkill — the agent learns from what went wrong, not just what worked. */
  async saveFriction(topic: string, lesson: string, opts: LearnOpts = {}): Promise<string | null> {
    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    return this.write(`lesson: ${topic}`.slice(0, 80), lesson, ['topic=friction', `about=${slug}`, ...(opts.area ? [`area=${opts.area}`] : []), 'intent=finding', 'confidence_level=observed'], { reservedConcept: true, canonical: opts.canonical ?? true, eventType: 'friction', global: true, ...(opts.untrusted ? { provenance: 'ingested' as const } : {}) });
  }

  /** Failure lessons the agent has recorded, for the UI "Lessons" view. */
  async listFriction(): Promise<{ topic: string; content: string; unconfirmed?: boolean }[]> {
    try {
      await this.init();
      const all: any[] = (await this.store.getEngramsByAgent(this.agentId)) ?? [];
      return all.filter((e) => this.parseTags(e.tags).includes('topic=friction')).reverse()
        .map((e) => {
          // Kept but never used in runs (BL-35: written after a refusal, or not cleared by the lesson judge).
          const tags = this.parseTags(e.tags);
          const unconfirmed = tags.includes('trust=untrusted') || tags.includes('src=ingested');
          return { topic: String(e.concept ?? '').replace(/^lesson:\s*/i, ''), content: String(e.content ?? '').slice(0, 300), ...(unconfirmed ? { unconfirmed } : {}) };
        });
    } catch { return []; }
  }

  /** STANDING PREFERENCE/POLICY — a user rule that must apply to EVERY future task (tone,
   *  format, approval requirements). Stored canonical + tagged topic=policy so listPolicies()
   *  can always-prime them into the prompt, unlike relevance-pruned recall. Dedup-reinforces. */
  async savePolicy(rule: string): Promise<string | null> {
    const r = rule.trim();
    return this.write(`policy: ${r}`.slice(0, 80), r, ['topic=policy', 'intent=decision', 'confidence_level=verified'], { canonical: true, eventType: 'decision', global: true });
  }

  /** All standing preferences/policies (content), newest-first, deduped — always-primed. */
  /**
   * BL-56: what recurring jobs' sources announced had changed (tagged kind=change and for=<person> when learned),
   * newest first, written since `sinceMs`, one per change (the same change re-learned keeps its newest copy). Listed,
   * not recalled: a morning plan's recall runs on "create a daily plan…" and never met "Max's dentist moved".
   */
  async listChanges(opts: { sinceMs: number; person: string; limit?: number }): Promise<{ content: string; at: number }[]> {
    try {
      await this.init();
      const all: any[] = (await this.store.getEngramsByAgent(this.agentId)) ?? [];
      const out: { content: string; at: number }[] = [];
      const seen = new Set<string>();
      const rows = all
        .filter((e) => !e.retracted && !e.supersededBy)
        .filter((e) => { const t = this.parseTags(e.tags); return t.includes('kind=change') && t.includes(`for=${opts.person}`); })
        .map((e) => ({ content: String(e.content ?? '').trim(), at: e.createdAt ? new Date(e.createdAt).getTime() : 0 }))
        .filter((c) => c.content && c.at >= opts.sinceMs)
        .sort((a, b) => b.at - a.at);
      for (const c of rows) {
        const key = c.content.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key); out.push(c);
        if (out.length >= (opts.limit ?? 8)) break;
      }
      return out;
    } catch { return []; }
  }

  async listPolicies(): Promise<string[]> {
    try {
      await this.init();
      const all: any[] = (await this.store.getEngramsByAgent(this.agentId)) ?? [];
      const seen = new Set<string>();
      const out: string[] = [];
      for (const e of all.filter((x) => this.parseTags(x.tags).includes('topic=policy')).reverse()) {
        const c = String(e.content ?? '').trim();
        const key = c.toLowerCase();
        if (c && !seen.has(key)) { seen.add(key); out.push(c); }
      }
      return out;
    } catch { return []; }
  }

  /**
   * Retract a standing preference. EXACT (case- and whitespace-insensitive) content match only —
   * never a substring — because this hard-deletes, and a loose match on always-primed rules is the
   * kind of mistake nobody notices until a safety preference is quietly gone.
   *
   * It deletes EVERY engram carrying that rule, not the first: listPolicies() dedups by lowercased
   * content, so one visible preference can be several engrams (savePolicy reinforces a duplicate but
   * a near-duplicate writes anew). Removing one of three leaves the rule still in force and still
   * primed, which reads as "the tool silently did nothing". Returns how many were removed.
   */
  async removePolicy(rule: string): Promise<number> {
    const want = String(rule ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!want) return 0;
    try {
      await this.init();
      const all: any[] = (await this.store.getEngramsByAgent(this.agentId)) ?? [];
      const hits = all.filter((e) => this.parseTags(e.tags).includes('topic=policy')
        && String(e.content ?? '').replace(/\s+/g, ' ').trim().toLowerCase() === want);
      let removed = 0;
      for (const e of hits) if (await this.forget(e.id)) removed++;
      return removed;
    } catch (err) { console.error('[awm] removePolicy error:', (err as Error).message); return 0; }
  }

  /** F6 — versions already saved for a routine slug (for the next-version bump). */
  private async routineVersions(slug: string): Promise<string[]> {
    try {
      await this.init();
      const all: any[] = (await this.store.getEngramsByAgent(this.agentId)) ?? [];
      return all
        .filter((e) => this.parseTags(e.tags).includes(`routine=${slug}`))
        .map((e) => { const v = this.parseTags(e.tags).find((t) => String(t).startsWith('version=')); return v ? v.slice(8) : ''; })
        .filter(Boolean);
    } catch { return []; }
  }

  /**
   * F6 EARNED DETERMINISM — crystallize a repeated successful approach into a replayable routine.
   * SAFETY: injection-scans the steps (rejects laundered/unsafe content so a routine can't become a
   * persistent backdoor), NEVER overwrites (each save is a new version kept for rollback), and stores
   * status=proposed (propose-vs-commit — a proposed routine is not silently made the active one).
   */
  async saveRoutine(name: string, steps: string, opts: { tainted?: boolean } = {}): Promise<{ id: string | null; version?: string; rejected?: string }> {
    // Scan BOTH the name and the steps — the name (a task instruction) is surfaced + could carry an
    // injection just as the body can.
    const scan = scanRoutine(`${name}\n${steps}`);
    if (!scan.safe) return { id: null, rejected: scan.reason };
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const version = nextVersion(await this.routineVersions(slug));
    // NOT topic=skill: a PROPOSED routine must not be auto-recalled into future prompts (auto-prime
    // recalls topic=skill) until a human promotes it — otherwise a routine that slipped past the scan
    // becomes a recalled instruction. It lives as topic=routine/status=proposed for review only.
    // Version in the concept keeps each version a DISTINCT engram (no reinforce-merge of similar steps).
    const id = await this.write(
      `routine: ${name} ${version}`.slice(0, 80), steps,
      // tainted=1: proposed by a run that had read outside content — the person sees it before promoting (BL-12 review).
      ['topic=routine', `routine=${slug}`, `version=${version}`, 'status=proposed', 'intent=procedural', 'confidence_level=observed', ...(opts.tainted ? ['tainted=1'] : [])],
      { canonical: true, eventType: 'observation', global: true },
    );
    return { id, version };
  }

  /** F6 — saved routines (all versions, newest-first), for the UI + replay. */
  async listRoutines(): Promise<{ id: string; slug: string; name: string; version: string; status: string; content: string; tainted: boolean }[]> {
    try {
      await this.init();
      const all: any[] = (await this.store.getEngramsByAgent(this.agentId)) ?? [];
      // A routine is a `routine:` engram — a consolidation summary that inherited the tags is not one (BL-12 review).
      return all.filter((e) => this.parseTags(e.tags).includes('topic=routine') && /^routine:/i.test(String(e.concept ?? ''))).reverse().map((e) => {
        const t = this.parseTags(e.tags);
        const get = (p: string) => { const x = t.find((y) => String(y).startsWith(p)); return x ? x.slice(p.length) : ''; };
        // The FULL text: a person must see every word of what they may promote (BL-12 review).
        return { id: String(e.id), slug: get('routine='), name: String(e.concept ?? '').replace(/^routine:\s*/i, '').replace(/\s+v\d+$/i, ''), version: get('version='), status: get('status='), content: String(e.content ?? ''), tainted: t.includes('tainted=1') };
      });
    } catch { return []; }
  }

  /**
   * BL-12 (H-9) — a PERSON promotes a routine: its steps become a trusted skill, the one thing that is
   * primed into future runs; any other active version of the same routine is retired first, so one
   * version is in force. The steps are scanned again (a scan rule added since it was saved still
   * applies). Never a model tool: only the app's routines panel calls this.
   */
  async promoteRoutine(id: string): Promise<{ ok: boolean; error?: string; name?: string; version?: string }> {
    try {
      await this.init();
      const e: any = await this.store.getEngram(id);
      const t = e ? this.parseTags(e.tags) : [];
      if (!e || !t.includes('topic=routine')) return { ok: false, error: 'no such routine' };
      const get = (p: string) => { const x = t.find((y) => String(y).startsWith(p)); return x ? x.slice(p.length) : ''; };
      // Active and its skill still there: nothing to do. Active but the skill is gone: promote it again.
      const existing = get('skillid=');
      if (get('status=') === 'active' && existing && (await this.store.getEngram(existing))) return { ok: true, name: String(e.concept), version: get('version=') };
      const name = String(e.concept ?? '').replace(/^routine:\s*/i, '').replace(/\s+v\d+$/i, '');
      const scan = scanRoutine(`${name}\n${e.content}`);
      if (!scan.safe) return { ok: false, error: `it no longer passes the safety scan: ${scan.reason}` };
      for (const other of await this.listRoutines()) {
        if (other.slug === get('routine=') && other.status === 'active' && other.id !== id) await this.retireRoutine(other.id);
      }
      // Its OWN engram (BL-12 review): a concept no other write shares, and noMerge, so the person's approved
      // steps never merge into a skill the model wrote, nor a later one into them; tagged to its routine so
      // retiring removes exactly this copy. The person read the steps and chose them: their provenance.
      const version = get('version=');
      const skillId = await this.write(`skill: ${name} (promoted ${version})`.slice(0, 80), String(e.content ?? ''),
        ['topic=skill', `skill=${get('routine=')}`, 'intent=procedural', 'confidence_level=verified'],
        { canonical: true, eventType: 'decision', global: true, noMerge: true, provenance: 'user', promotedOf: id, reservedConcept: true });
      if (!skillId) return { ok: false, error: 'the memory filter declined to save it' };
      await this.setScheduledTags(id, (tags) => [...tags.filter((x) => !x.startsWith('status=') && !x.startsWith('skillid=')), 'status=active', `skillid=${skillId}`]);
      return { ok: true, name, version: get('version=') };
    } catch (err) { return { ok: false, error: (err as Error).message.slice(0, 120) }; }
  }

  /** BL-12 — retire an active routine: its skill copy is forgotten, so it is primed no more. */
  async retireRoutine(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.init();
      const e: any = await this.store.getEngram(id);
      const t = e ? this.parseTags(e.tags) : [];
      if (!e || !t.includes('topic=routine')) return { ok: false, error: 'no such routine' };
      const skillId = t.find((x) => String(x).startsWith('skillid='))?.slice(8);
      if (skillId) {
        // Only the copy THIS routine made (tagged promoted=<routine>) — never a skill that merely shares a name.
        const sk: any = await this.store.getEngram(skillId);
        if (sk && this.parseTags(sk.tags).includes(`promoted=${id}`) && !(await this.forget(skillId))) return { ok: false, error: 'could not remove its skill' };
      }
      await this.setScheduledTags(id, (tags) => [...tags.filter((x) => !x.startsWith('status=') && !x.startsWith('skillid=')), 'status=retired']);
      return { ok: true };
    } catch (err) { return { ok: false, error: (err as Error).message.slice(0, 120) }; }
  }

  /** Reusable procedures the agent has learned, for the UI "Skills" view. */
  async listSkills(): Promise<{ name: string; content: string }[]> {
    try {
      await this.init();
      const all: any[] = (await this.store.getEngramsByAgent(this.agentId)) ?? [];
      return all.filter((e) => this.parseTags(e.tags).includes('topic=skill')).reverse()
        .map((e) => ({ name: String(e.concept ?? '').replace(/^skill:\s*/i, ''), content: String(e.content ?? '').slice(0, 300) }));
    } catch { return []; }
  }

  /** SELF-LEARNING: an open question the agent flagged to answer later (intent=question). */
  async saveQuestion(question: string): Promise<string | null> {
    return this.write(`question: ${question}`.slice(0, 80), question, ['topic=open-question', 'status=open', 'intent=question', 'confidence_level=assumed'], { canonical: true, eventType: 'observation', global: true });
  }

  /** Open (unresolved) questions, for the UI + the resolve pass. */
  async listOpenQuestions(): Promise<{ id: string; question: string }[]> {
    try {
      await this.init();
      const all: any[] = (await this.store.getEngramsByAgent(this.agentId)) ?? [];
      return all.filter((e) => { const t = this.parseTags(e.tags); return t.includes('topic=open-question') && t.includes('status=open'); })
        .reverse().map((e) => ({ id: e.id, question: String(e.content ?? '') }));
    } catch { return []; }
  }

  /** Mark an open question resolved (the answer is written separately as a normal fact). */
  async resolveQuestion(id: string): Promise<void> {
    try { await this.init(); const e = await this.store.getEngram(id); if (e) await this.store.updateTags(id, this.parseTags(e.tags).map((t: string) => (t.startsWith('status=') ? 'status=resolved' : t))); } catch { /* */ }
  }

  // ── Per-person Profile (S1) ─────────────────────────────────────────────────────────────────
  // "Who am I talking to, and what do I need to consider for THEM." A person's notes are tagged
  // person=<id> so recall is HARD-isolated to that person (privacy invariant): one person's profile
  // never surfaces for another. `kind=strategy` carries the adaptive-interaction dimension — how to
  // engage this person to get the most useful exchange. Style/format only; never facts or safety gates.
  // See docs/true-agent-and-person-profile.md.

  /** Remember something about a specific person (preference / style / need / strategy / fact). An
   *  optional `field` tags the note as the answer to a canonical intake field (name/contact/role/…),
   *  so intakeStatus() can tell which high-value fields are known vs still missing. */
  async rememberAboutPerson(personId: string, content: string, kind: PersonNoteKind = 'fact', field?: string): Promise<string | null> {
    const pid = normalizePersonId(personId);
    const body = String(content ?? '').trim();
    if (!body) return null;
    const tags = ['topic=person-profile', `person=${pid}`, `pkind=${kind}`, 'intent=context'];
    if (field) tags.push(`pfield=${String(field).replace(/[^a-z0-9_-]+/gi, '').slice(0, 24)}`);
    return this.write(`person ${pid}: ${body.slice(0, 48)}`, body, tags,
      { canonical: true, eventType: 'decision', global: true });
  }

  /** This person's profile notes, newest first — HARD-filtered to person=<id> (never cross-person). */
  async recallPersonProfile(personId: string, limit = 20): Promise<PersonNote[]> {
    try {
      await this.init();
      const pid = normalizePersonId(personId);
      const all: any[] = (await this.store.getEngramsByAgent(this.agentId)) ?? [];
      const out: PersonNote[] = [];
      for (const e of all) {
        const tags = this.parseTags(e.tags);
        if (!tags.includes('topic=person-profile') || !tags.includes(`person=${pid}`)) continue;
        const kindTag = tags.find((t) => t.startsWith('pkind='));
        const kind = (kindTag ? kindTag.slice(6) : 'fact') as PersonNoteKind;
        const fieldTag = tags.find((t) => t.startsWith('pfield='));
        out.push({ id: e.id, personId: pid, kind, content: String(e.content ?? ''), field: fieldTag ? fieldTag.slice(7) : undefined });
      }
      // ALWAYS retain identity/intake ANCHORS (field-tagged: name/contact/role/style/verified-contact)
      // and the dossier — they're the OLDEST notes, so a plain newest-N window would evict exactly the
      // records that assessIdentity + hasVerifiedFactor depend on, breaking impersonation detection and
      // step-up for the people you know best. Anchors are always kept; the newest atomic notes fill the rest.
      const anchors = out.filter((n) => n.field || n.kind === 'dossier');
      const atomic = out.filter((n) => !n.field && n.kind !== 'dossier');
      const kept = [...anchors, ...atomic.slice(-Math.max(0, limit - anchors.length))];
      return kept.reverse();
    } catch (err) { console.error('[awm] recallPersonProfile error:', (err as Error).message); return []; }
  }

  /** People the agent has a profile for — one row each with note count, filled intake fields, and the
   *  current dossier (if any). Powers the Glass-Box "People I know" view (S4). */
  async listPeople(): Promise<{ personId: string; notes: number; fields: string[]; dossier: string | null }[]> {
    try {
      await this.init();
      const all: any[] = (await this.store.getEngramsByAgent(this.agentId)) ?? [];
      const map = new Map<string, { notes: number; fields: Set<string>; dossier: string | null }>();
      for (const e of all) {
        const tags = this.parseTags(e.tags);
        if (!tags.includes('topic=person-profile')) continue;
        const pid = (tags.find((t) => t.startsWith('person=')) ?? '').slice(7);
        if (!pid) continue;
        const rec = map.get(pid) ?? { notes: 0, fields: new Set<string>(), dossier: null };
        rec.notes++;
        if (tags.includes('pkind=dossier')) rec.dossier = String(e.content ?? '');
        const fieldTag = tags.find((t) => t.startsWith('pfield='));
        if (fieldTag) rec.fields.add(fieldTag.slice(7));
        map.set(pid, rec);
      }
      return [...map.entries()].map(([personId, r]) => ({ personId, notes: r.notes, fields: [...r.fields], dossier: r.dossier })).sort((a, b) => b.notes - a.notes);
    } catch (err) { console.error('[awm] listPeople error:', (err as Error).message); return []; }
  }

  /** AWM 0.20 implicit feedback (ActivationEngine.noteImplicitUse); a no-op on an older engine. */
  async noteUse(text: string, source: string): Promise<number> {
    try {
      const a = this.activation as { noteImplicitUse?: (t: string, s: string) => Promise<number> } | undefined;
      return a?.noteImplicitUse ? await a.noteImplicitUse(text, source) : 0;
    } catch { return 0; }
  }

  close(): void {
    try {
      this.store?.stopWalCheckpointTimer?.();
      this.store?.close?.();
    } catch {
      /* ignore */
    }
    // A closed handle reopens on next use. An action staged for a person's approval keeps a reference
    // to the memory of the turn that staged it, and serve closes that memory when the turn ends — so
    // the approval, which now always comes after the turn (BL-03), wrote through a dead handle and
    // reported "not saved". Reopening lazily is the same path the first use takes.
    this.initPromise = undefined;
  }
}

/** AWM-OFF arm: the brain runs with no substrate. */
export class NullMemory implements Memory {
  readonly enabled = false;
  async recall(): Promise<RecalledMemory[]> {
    return [];
  }
  async sourcesOf(): Promise<RecalledMemory[]> {
    return [];
  }
  async write(): Promise<string | null> {
    return null;
  }
  async supersede(): Promise<string | null> {
    return null;
  }
  async logAction(): Promise<string | null> {
    return null;
  }
  async forget(): Promise<boolean> {
    return false;
  }
  trustOf(): TrustTier {
    return 'untrusted';
  }
  setSessionId(): void {
    /* no-op */
  }
  setNamespace(): void {
    /* no-op */
  }
  async consolidate(): Promise<Record<string, number>> {
    return {};
  }
  async addScheduledTask(): Promise<string | null> {
    return null;
  }
  async saveSkill(): Promise<string | null> {
    return null;
  }
  async saveFriction(): Promise<string | null> {
    return null;
  }
  async savePolicy(): Promise<string | null> {
    return null;
  }
  async listPolicies(): Promise<string[]> {
    return [];
  }
  async saveQuestion(): Promise<string | null> {
    return null;
  }
  async feedback(): Promise<void> {
    /* no-op */
  }
  close(): void {
    /* no-op */
  }
}

/** BL-44: a job's last-run record from its tag; a damaged tag reads as no record rather than failing the job. */
function parseLastRun(b64: string): JobLastRun | undefined {
  try {
    const o = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    if (!o || typeof o.at !== 'number' || typeof o.summary !== 'string') return undefined;
    return {
      at: o.at, summary: o.summary,
      ...(typeof o.value === 'string' ? { value: o.value } : {}),
      ...(typeof o.valueAt === 'number' ? { valueAt: o.valueAt } : {}),
      ...(Array.isArray(o.history) ? { history: o.history.filter((h: { at?: unknown; value?: unknown }) => typeof h?.at === 'number' && typeof h?.value === 'string').slice(-20) } : {}),
      ...(typeof o.obs === 'string' ? { obs: o.obs } : {}),
      ...(typeof o.sumHash === 'string' ? { sumHash: o.sumHash } : {}),
    };
  } catch { return undefined; }
}

/** BL-50: an item that needs the person — see MwaMemory.addOpenItem. */
export interface OpenItem { id: string; what: string; status: 'open' | 'closed'; trust: TrustTier; who?: string; due?: string; source?: string; closedWhy?: string; createdAt?: number }
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: string) => { try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return ''; } };
/** Two items are the same item when their words match, ignoring case, punctuation and spacing. */
function openItemKey(what: string): string { return what.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
