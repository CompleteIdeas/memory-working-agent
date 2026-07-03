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
  addScheduledTask(instruction: string, dueMs: number, opts?: { recur?: string; notify?: string; dir?: string; resumeAttempt?: number; check?: string }): Promise<string | null>;
  /** Persist a reusable procedure ("skill") recalled on similar future tasks. */
  saveSkill(name: string, steps: string): Promise<string | null>;
  /** Persist a verbal failure reflection ("X failed because Y; next time Z") recalled
   *  before similar future tasks — the Reflexion learn-from-failure counterpart to saveSkill. */
  saveFriction(topic: string, lesson: string): Promise<string | null>;
  /** Persist a STANDING user preference/policy ("never send without review", "keep summaries
   *  to 5 bullets") that should be honored on EVERY future task — not just relevant ones. */
  savePolicy(rule: string): Promise<string | null>;
  /** All standing preferences/policies (content), surfaced to the prompt every run. */
  listPolicies(): Promise<string[]>;
  /** Persist an open question the agent wants answered later (self-learning loop). */
  saveQuestion(question: string): Promise<string | null>;
  close(): void;
}

/** A pending scheduled task read back from the store. */
export interface ScheduledTask {
  id: string;
  instruction: string;
  due: number; // epoch ms
  recur?: string; // e.g. "every:60" (minutes) or "daily:09:00"
  notify?: string; // where to send the result (e.g. a session id)
  dir?: string; // working dir to REUSE (resume tasks reuse the original run's folder + files)
  resumeAttempt?: number; // 1-based resume count (auto-resume of an unfinished long run); absent = not a resume
  check?: string; // cheap change-detection command: if its output signature is unchanged, the fire is skipped (no model call)
  lastSig?: string; // signature (sha1 hex) of the check output at the last actual fire
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
      const result = await performWrite(
        { store: this.store, connectionEngine: this.connections },
        {
          agentId: this.agentId,
          concept: concept.slice(0, 80),
          content,
          tags: stamped,
          memoryClass: opts.canonical ? 'canonical' : 'working',
          memoryType: 'semantic',
          eventType: opts.eventType ?? 'observation',
          surprise: opts.surprise ?? 0.3,
          decisionMade: opts.eventType === 'decision',
          causalDepth: 0.4,
          resolutionEffort: 0.3,
        },
      );
      return result?.engram?.id ?? null;
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
    const newId = await this.write(concept, content, tags, { ...opts, canonical: true });
    if (newId && oldId) {
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

  async addScheduledTask(instruction: string, dueMs: number, opts: { recur?: string; notify?: string; dir?: string; resumeAttempt?: number; check?: string } = {}): Promise<string | null> {
    const tags = ['topic=scheduled-task', 'status=pending', `due=${Math.round(dueMs)}`];
    if (opts.recur) tags.push(`recur=${opts.recur}`);
    if (opts.notify) tags.push(`notify=${opts.notify}`);
    if (opts.dir) tags.push(`dir=${opts.dir}`);
    if (opts.resumeAttempt) tags.push(`resume=${opts.resumeAttempt}`);
    // Base64 the check command so an arbitrary shell string (spaces, commas, pipes, '=') survives
    // both tag serializations (JSON array or comma-split). No commas in base64 → comma-split is safe.
    if (opts.check) tags.push(`check64=${Buffer.from(opts.check, 'utf8').toString('base64')}`);
    return this.write(`scheduled: ${instruction.slice(0, 56)}`, instruction, tags, { canonical: true, eventType: 'decision', global: true });
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
        out.push({ id: e.id, instruction: e.content, due: Number(get('due=')) || 0, recur: get('recur=') || undefined, notify: get('notify=') || undefined, dir: get('dir=') || undefined, resumeAttempt: Number(get('resume=')) || undefined, check: check64 ? Buffer.from(check64, 'base64').toString('utf8') : undefined, lastSig: get('lastsig=') || undefined });
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
  /** Recurring task: set the next due (epoch ms), keep pending. */
  async rescheduleTask(id: string, nextDueMs: number): Promise<void> {
    await this.setScheduledTags(id, (tags) => [...tags.filter((t) => !t.startsWith('due=')), `due=${Math.round(nextDueMs)}`]);
  }
  /** Record the change-detection signature (sha1 hex) captured at the last actual fire, so the next
   *  tick can skip the (expensive) agent run when nothing has changed. */
  async setScheduledSignature(id: string, sig: string): Promise<void> {
    await this.setScheduledTags(id, (tags) => [...tags.filter((t) => !t.startsWith('lastsig=')), `lastsig=${sig}`]);
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
    try {
      const tag = this.parseTags(engram?.tags).find((t) => String(t).toLowerCase().startsWith('trust='));
      const v = tag ? tag.slice(6).toLowerCase() : '';
      return v === 'high' || v === 'medium' || v === 'untrusted' ? (v as TrustTier) : 'untrusted';
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
  async saveSkill(name: string, steps: string): Promise<string | null> {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    return this.write(`skill: ${name}`.slice(0, 80), steps, ['topic=skill', `skill=${slug}`, 'intent=procedural', 'confidence_level=observed'], { canonical: true, eventType: 'observation', global: true });
  }

  /** REFLEXION: record a verbal failure reflection as a canonical memory tagged topic=friction
   *  + eventType=friction, so auto-prime recalls it before similar future tasks. The failure
   *  counterpart of saveSkill — the agent learns from what went wrong, not just what worked. */
  async saveFriction(topic: string, lesson: string): Promise<string | null> {
    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    return this.write(`lesson: ${topic}`.slice(0, 80), lesson, ['topic=friction', `about=${slug}`, 'intent=finding', 'confidence_level=observed'], { canonical: true, eventType: 'friction', global: true });
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
