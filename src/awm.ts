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
import { ActivationEngine } from 'agent-working-memory/dist/engine/activation.js';
import { ConnectionEngine } from 'agent-working-memory/dist/engine/connections.js';
import { ConsolidationEngine } from 'agent-working-memory/dist/engine/consolidation.js';
import { performWrite } from 'agent-working-memory/dist/core/write-pipeline.js';
import { initCoordinationTables } from 'agent-working-memory/dist/coordination/schema.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { scanRoutine, nextVersion } from './tools/routines.js';
import { normalizePersonId, type PersonNote, type PersonNoteKind } from './person.js';
import { parseEvidence, formatEvidence, evidenceAfter, readyToArm, type DetectorEvidence, type DryScore } from './detector.js';

export interface RecalledMemory {
  id: string;
  concept: string;
  content: string;
  score: number;
  /** SPINE trust tier of the source engram. F2 reads this to isolate untrusted (inbox/web-mined)
   *  facts in the prompt so they can't be obeyed as instructions. Absent on non-AWM arms. */
  trust?: TrustTier;
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
const RESERVED_TAG_PREFIXES = ['trust=', 'src=', 'ns=', 'origin=', 'proj=', 'session='];

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
}

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
  recall(query: string, opts?: { limit?: number; workspace?: string; full?: boolean; fast?: boolean; rerank?: boolean; expand?: boolean; namespace?: string }): Promise<RecalledMemory[]>;
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
  /** A goal by id or short id (BL-05). Absent when AWM is off. */
  getGoal?(idOrPrefix: string): Promise<Goal | null>;
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
  close(): void;
}

/** How a run-end lesson or skill is stored. A run that read external content still teaches, but
 *  its lesson is untrusted (provenance `ingested`, flagged when recalled, never auto-primed) and not
 *  canonical; a run that read local files teaches at normal trust but not canonical. (BL-17) */
export interface LearnOpts { canonical?: boolean; untrusted?: boolean }

/** Options for a scheduled task — the job contract (BL-02) plus delivery and lineage. */
export interface ScheduleOpts {
  recur?: string; notify?: string; dir?: string; origin?: string; resumeAttempt?: number; check?: string; person?: string; tainted?: boolean;
  /** completion condition in plain words; a confirmed `complete` outcome stops a recurring job. */
  until?: string;
  /** hard limits shown to every fire. */
  limits?: string;
  /** when to message the person: always (default) | changed | never. Failures always deliver. */
  deliver?: 'always' | 'changed' | 'never';
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
}

/** A goal (BL-05): an AWM task that owns scheduled jobs. Its status is the source of truth for
 *  whether those jobs run: done stops them, blocked pauses them. */
export type GoalStatus = 'open' | 'in_progress' | 'blocked' | 'done';
export type GoalPriority = 'urgent' | 'high' | 'medium' | 'low';
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
  until?: string;
  limits?: string;
  deliver?: 'always' | 'changed' | 'never';
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
}

export class MwaMemory implements Memory {
  readonly enabled = true;
  private store: any;
  private activation: any;
  private connections: any;
  private consolidationEngine: any;
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
      const backend = (process.env.AWM_STORE_BACKEND || '').toLowerCase();
      if (backend === 'pglite') {
        mkdirSync(this.dbPath, { recursive: true }); // PGlite path is a DIRECTORY
        const { PGliteEngramStore } = await import('agent-working-memory/dist/storage/pglite.js');
        const s: any = new PGliteEngramStore(this.dbPath);
        await s.ready();
        this.store = s;
      } else if (backend === 'postgres') {
        // Computed specifier: the postgres server adapter (pg + pgvector) ships in AWM; resolving it
        // at runtime (not compile time) keeps MWA buildable on AWM builds that predate the adapter.
        const mod = 'agent-working-memory/dist/storage/postgres.js';
        const { PostgresEngramStore } = await import(/* @vite-ignore */ mod);
        const s: any = new PostgresEngramStore(process.env.AWM_DATABASE_URL ?? this.dbPath);
        if (typeof s.ready === 'function') await s.ready();
        this.store = s;
      } else {
        mkdirSync(dirname(this.dbPath), { recursive: true }); // SQLite path is a FILE
        const { EngramStore } = await import('agent-working-memory/dist/storage/sqlite.js');
        this.store = new EngramStore(this.dbPath);
      }
      this.activation = new ActivationEngine(this.store);
      this.connections = new ConnectionEngine(this.store, this.activation);
      if (this.workspace) this.joinWorkspace(this.workspace);
    })();
    return this.initPromise;
  }

  /** Register this agent into a shared workspace (coord_agents) so workspace-scoped recall
   *  resolves it via getWorkspaceAgentIds. SQLite-only (reaches the raw better-sqlite3 db); a
   *  non-SQLite backend has no `.db`, so workspace coordination is skipped there. Best-effort. */
  private joinWorkspace(workspace: string): void {
    try {
      const db = (this.store as unknown as { db: any }).db;
      if (!db || typeof db.prepare !== 'function') return; // not SQLite → no coordination tables
      initCoordinationTables(db);
      db.prepare(
        `INSERT OR REPLACE INTO coord_agents (id, name, workspace, status, role, last_seen)
         VALUES (?, ?, ?, 'idle', 'worker', datetime('now'))`,
      ).run(`${workspace}:${this.agentId}`, this.agentId, workspace);
    } catch (err) {
      console.error('[awm] joinWorkspace error:', (err as Error).message);
    }
  }

  async recall(query: string, opts: { limit?: number; workspace?: string; full?: boolean; fast?: boolean; rerank?: boolean; expand?: boolean; namespace?: string } = {}): Promise<RecalledMemory[]> {
    try {
      await this.init();
      const want = opts.limit ?? 5;
      const ns0 = opts.namespace ?? this.currentNamespace;
      const ns = ns0 ? nsSlug(ns0) : undefined;
      const results = await this.activation.activate({
        agentId: this.agentId,
        context: query,
        // F5: when scoping to a topic, over-fetch generously then post-filter so we still return
        // `want` in-scope. This is best-effort, not a hard guarantee — on a heavily-interleaved
        // corpus an in-scope fact ranked beyond the over-fetch window can be missed (a false negative,
        // never a cross-topic bleed). Scoped recall is opt-in; the proper fix (push ns= into the
        // activation query) is the follow-on.
        limit: ns ? want * 8 + 24 : want,
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
        internal: true,
      });
      // F5 namespace scope: keep facts in THIS topic OR global (no ns=), drop OTHER topics — the
      // no-bleed guarantee. Global facts (user prefs, etc.) stay relevant across every topic.
      const rows: any[] = ns
        ? results.filter((r: any) => { const t = this.parseTags(r.engram.tags).find((x: string) => String(x).startsWith('ns=')); return !t || t.slice(3) === ns; }).slice(0, want)
        : results;
      return rows.map((r: any) => ({
        id: r.engram.id,
        concept: r.engram.concept,
        content: opts.full ? r.engram.content : (r.summary ?? r.engram.content),
        score: r.score,
        trust: this.trustOf(r.engram),
      }));
    } catch (err) {
      console.error('[awm] recall error:', (err as Error).message);
      return [];
    }
  }

  async write(concept: string, content: string, tags: string[] = [], opts: WriteOpts = {}): Promise<string | null> {
    try {
      await this.init();
      // SPINE: stamp provenance + trust OUT OF BAND. Strip any reserved tags a caller (or the
      // model, via a caller that forwards model-chosen tags) tried to supply, then re-derive
      // them from the typed opts — so untrusted content can never set its own trust. Fail to
      // 'inferred'/medium for legacy callers; only explicit provenance:'user' earns high trust.
      const provenance: Provenance = opts.provenance ?? 'inferred';
      const trust = TRUST_BY_PROVENANCE[provenance];
      const safeTags = tags.filter((t) => !RESERVED_TAG_PREFIXES.some((p) => String(t).toLowerCase().startsWith(p)));
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
        } catch { mayMerge = false; } // can't tell the classes apart → write it on its own
      }
      const result = await performWrite(
        { store: this.store, connectionEngine: this.connections },
        {
          agentId: this.agentId,
          concept: concept.slice(0, 80),
          content,
          tags: stamped,
          memoryClass: opts.canonical ? 'canonical' : 'working',
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
    // The caller's canonical/provenance win: a tainted run must not be able to replace a trusted fact
    // with a canonical one (BL-17 review). Canonical stays the default for ordinary corrections.
    const newId = await this.write(concept, content, tags, { ...opts, canonical: opts.canonical ?? true });
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
    const newId = await this.write(concept.slice(0, 80) || 'correction', content, ['topic=world', 'intent=decision', 'confidence_level=verified'], { provenance: 'user', canonical: true });
    if (!newId) {
      // Write failed — ROLL BACK: restore the original (content + its original trust tier) so the
      // user's data is never lost on the very operation meant to fix it.
      const t = this.trustOf(old);
      const prov: Provenance = t === 'high' ? 'user' : t === 'untrusted' ? 'ingested' : 'inferred';
      try { await this.write(String(old.concept ?? concept), String(old.content ?? ''), ['topic=world', 'intent=finding', 'confidence_level=observed'], { provenance: prov, canonical: true }); } catch { /* best-effort restore */ }
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
      if (!this.consolidationEngine) this.consolidationEngine = new ConsolidationEngine(this.store, this.connections);
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
    if (opts.limits) tags.push(`limits64=${Buffer.from(opts.limits, 'utf8').toString('base64')}`);
    if (opts.deliver && opts.deliver !== 'always') tags.push(`deliver=${opts.deliver}`);
    if (opts.resumeAttempt) tags.push(`resume=${opts.resumeAttempt}`);
    // Lineage and ownership (BL-05): what the fan-out budget counts, and what a goal owns.
    if (opts.depth) tags.push(`depth=${Math.max(0, Math.floor(opts.depth))}`);
    if (opts.parent) tags.push(`parent=${opts.parent.slice(0, 8)}`);
    if (opts.goal) tags.push(`goal=${opts.goal}`);
    if (opts.byRun) tags.push(`byrun=${opts.byRun.slice(0, 8)}`);
    if (opts.resumeOf) tags.push(`resumeof=${opts.resumeOf.slice(0, 8)}`);
    if (opts.urgent) tags.push('urgent=1');
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
        const sameContract = tag('until64=').slice(8) === b64(opts.until) && tag('limits64=').slice(9) === b64(opts.limits)
          && (tag('deliver=').slice(8) || 'always') === (opts.deliver ?? 'always') && tag('check64=').slice(8) === b64(opts.check);
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
    return this.write(`scheduled: ${instruction.slice(0, 56)}`, instruction, tags, {
      // Canonical is the SALIENCE floor, not trust: a scheduled task must never be staged or discarded.
      // Trust comes from provenance — a tainted task is stored untrusted (flagged if recalled).
      canonical: true, eventType: 'decision', global: true, noMerge: true,
      ...(opts.tainted ? { provenance: 'ingested' as const } : {}),
    });
  }

  /** All pending scheduled tasks (parsed). */
  async pendingScheduled(): Promise<ScheduledTask[]> {
    try {
      await this.init();
      const engrams: any[] = (await this.store.getEngramsByAgent(this.agentId)) ?? [];
      const out: ScheduledTask[] = [];
      for (const e of engrams) {
        const tags = this.parseTags(e.tags);
        if (!tags.includes('topic=scheduled-task') || !tags.includes('status=pending')) continue;
        const get = (p: string) => (tags.find((t) => t.startsWith(p)) ?? '').slice(p.length);
        const check64 = get('check64=');
        out.push({ id: e.id, instruction: e.content, due: Number(get('due=')) || 0, recur: get('recur=') || undefined, notify: get('notify=') || undefined, dir: get('dir=') || undefined, origin: get('origin=') || undefined, tainted: tags.includes('tainted=1') || undefined, until: get('until64=') ? Buffer.from(get('until64='), 'base64').toString('utf8') : undefined, limits: get('limits64=') ? Buffer.from(get('limits64='), 'base64').toString('utf8') : undefined, deliver: (get('deliver=') || undefined) as ScheduledTask['deliver'], pendingComplete: tags.includes('pendingcomplete=1') || undefined, resumeAttempt: Number(get('resume=')) || undefined, check: check64 ? Buffer.from(check64, 'base64').toString('utf8') : undefined, lastSig: get('lastsig=') || undefined, person: get('person=') || undefined, depth: Number(get('depth=')) || undefined, parent: get('parent=') || undefined, goal: get('goal=') || undefined, byRun: get('byrun=') || undefined, resumeOf: get('resumeof=') || undefined, budgetNotified: tags.includes('budgetnotified=1') || undefined, urgent: tags.includes('urgent=1') || undefined,
          checkMode: (get('checkmode=') || undefined) as ScheduledTask['checkMode'], checkArm: get('checkarm=') || undefined, checkEv: get('checkev=') ? parseEvidence(get('checkev=')) : undefined, checkReady: tags.includes('checkready=1') || undefined, checkMissed: tags.includes('checkmissed=1') || undefined });
      }
      return out.sort((a, b) => a.due - b.due);
    } catch (err) { console.error('[awm] pendingScheduled error:', (err as Error).message); return []; }
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
  /** Record the change-detection signature (sha1 hex) captured at the last actual fire, so the next
   *  tick can skip the (expensive) agent run when nothing has changed. */
  async setScheduledSignature(id: string, sig: string): Promise<void> {
    await this.setScheduledTags(id, (tags) => [...tags.filter((t) => !t.startsWith('lastsig=')), `lastsig=${sig}`]);
  }

  /** Cancel a pending scheduled task (status=canceled). Deliberately NOT completeScheduled: "the
   *  person called it off" and "it ran to completion" are different facts, and collapsing them
   *  destroys the only audit trail of an automation that was stopped. Both leave pendingScheduled. */
  async cancelScheduled(id: string): Promise<void> {
    await this.setScheduledTags(id, (tags) => tags.map((t) => (t.startsWith('status=') ? 'status=canceled' : t)));
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
    if (!tags.includes('topic=goal')) return null;
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
    return this.write(`skill: ${name}`.slice(0, 80), steps, ['topic=skill', `skill=${slug}`, 'intent=procedural', 'confidence_level=observed'], { canonical: opts.canonical ?? true, eventType: 'observation', global: true, ...(opts.untrusted ? { provenance: 'ingested' as const } : {}) });
  }

  /** REFLEXION: record a verbal failure reflection as a canonical memory tagged topic=friction
   *  + eventType=friction, so auto-prime recalls it before similar future tasks. The failure
   *  counterpart of saveSkill — the agent learns from what went wrong, not just what worked. */
  async saveFriction(topic: string, lesson: string, opts: LearnOpts = {}): Promise<string | null> {
    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    return this.write(`lesson: ${topic}`.slice(0, 80), lesson, ['topic=friction', `about=${slug}`, 'intent=finding', 'confidence_level=observed'], { canonical: opts.canonical ?? true, eventType: 'friction', global: true, ...(opts.untrusted ? { provenance: 'ingested' as const } : {}) });
  }

  /** Failure lessons the agent has recorded, for the UI "Lessons" view. */
  async listFriction(): Promise<{ topic: string; content: string }[]> {
    try {
      await this.init();
      const all: any[] = (await this.store.getEngramsByAgent(this.agentId)) ?? [];
      return all.filter((e) => this.parseTags(e.tags).includes('topic=friction')).reverse()
        .map((e) => ({ topic: String(e.concept ?? '').replace(/^lesson:\s*/i, ''), content: String(e.content ?? '').slice(0, 300) }));
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
  async saveRoutine(name: string, steps: string): Promise<{ id: string | null; version?: string; rejected?: string }> {
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
      ['topic=routine', `routine=${slug}`, `version=${version}`, 'status=proposed', 'intent=procedural', 'confidence_level=observed'],
      { canonical: true, eventType: 'observation', global: true },
    );
    return { id, version };
  }

  /** F6 — saved routines (all versions, newest-first), for the UI + replay. */
  async listRoutines(): Promise<{ name: string; version: string; status: string; content: string }[]> {
    try {
      await this.init();
      const all: any[] = (await this.store.getEngramsByAgent(this.agentId)) ?? [];
      return all.filter((e) => this.parseTags(e.tags).includes('topic=routine')).reverse().map((e) => {
        const t = this.parseTags(e.tags);
        const get = (p: string) => { const x = t.find((y) => String(y).startsWith(p)); return x ? x.slice(p.length) : ''; };
        return { name: String(e.concept ?? '').replace(/^routine:\s*/i, '').replace(/\s+v\d+$/i, ''), version: get('version='), status: get('status='), content: String(e.content ?? '').slice(0, 300) };
      });
    } catch { return []; }
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
