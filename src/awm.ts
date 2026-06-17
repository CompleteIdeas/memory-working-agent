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
import { EngramStore } from 'agent-working-memory/dist/storage/sqlite.js';
import { ActivationEngine } from 'agent-working-memory/dist/engine/activation.js';
import { ConnectionEngine } from 'agent-working-memory/dist/engine/connections.js';
import { ConsolidationEngine } from 'agent-working-memory/dist/engine/consolidation.js';
import { performWrite } from 'agent-working-memory/dist/core/write-pipeline.js';
import { initCoordinationTables } from 'agent-working-memory/dist/coordination/schema.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RecalledMemory {
  id: string;
  concept: string;
  content: string;
  score: number;
}

export interface WriteOpts {
  canonical?: boolean;
  eventType?: 'observation' | 'decision' | 'friction' | 'surprise' | 'causal';
  surprise?: number;
}

export interface Memory {
  readonly enabled: boolean;
  recall(query: string, opts?: { limit?: number; workspace?: string; full?: boolean; fast?: boolean; rerank?: boolean; expand?: boolean }): Promise<RecalledMemory[]>;
  write(concept: string, content: string, tags?: string[], opts?: WriteOpts): Promise<string | null>;
  supersede(oldId: string, concept: string, content: string, tags?: string[], opts?: WriteOpts): Promise<string | null>;
  feedback(id: string, useful: boolean): Promise<void>;
  /** Lightly links all subsequent writes from this session via a `session=` tag (entity-bridge boost). */
  setSessionId(id: string): void;
  /** Sleep consolidation (cluster/strengthen/decay); no-op when AWM is off. Returns cycle stats. */
  consolidate(): Promise<Record<string, number>>;
  /** Persist a scheduled task (due = epoch ms) in the AWM task store. */
  addScheduledTask(instruction: string, dueMs: number, opts?: { recur?: string; notify?: string; dir?: string; resumeAttempt?: number }): Promise<string | null>;
  /** Persist a reusable procedure ("skill") recalled on similar future tasks. */
  saveSkill(name: string, steps: string): Promise<string | null>;
  /** Persist a verbal failure reflection ("X failed because Y; next time Z") recalled
   *  before similar future tasks — the Reflexion learn-from-failure counterpart to saveSkill. */
  saveFriction(topic: string, lesson: string): Promise<string | null>;
  /** Persist a STANDING user preference/policy ("never send without review", "keep summaries
   *  to 5 bullets") that should be honored on EVERY future task — not just relevant ones. */
  savePolicy(rule: string): Promise<string | null>;
  /** All standing preferences/policies (content), surfaced to the prompt every run. */
  listPolicies(): string[];
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
}

export class MwaMemory implements Memory {
  readonly enabled = true;
  private store: any;
  private activation: any;
  private connections: any;
  private consolidationEngine: any;
  private sessionId?: string;

  /** Workspace for cross-agent/hive recall (OPT-IN: isolated by default). When set, this agent
   *  registers into the workspace and recall spans every agent in it — so insights/decisions
   *  written by one agent/LLM/CLI are recallable by another sharing the workspace. */
  private readonly workspace?: string;

  constructor(
    private readonly agentId: string,
    dbPath: string,
    workspace?: string,
  ) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.store = new EngramStore(dbPath);
    this.activation = new ActivationEngine(this.store);
    this.connections = new ConnectionEngine(this.store, this.activation);
    this.workspace = workspace || process.env.MWA_WORKSPACE_SHARE || undefined;
    if (this.workspace) this.joinWorkspace(this.workspace);
  }

  /** Register this agent into a shared workspace (coord_agents) so workspace-scoped recall
   *  resolves it via getWorkspaceAgentIds. Idempotent; best-effort (never breaks construction). */
  private joinWorkspace(workspace: string): void {
    try {
      const db = (this.store as unknown as { db: any }).db;
      initCoordinationTables(db);
      db.prepare(
        `INSERT OR REPLACE INTO coord_agents (id, name, workspace, status, role, last_seen)
         VALUES (?, ?, ?, 'idle', 'worker', datetime('now'))`,
      ).run(`${workspace}:${this.agentId}`, this.agentId, workspace);
    } catch (err) {
      console.error('[awm] joinWorkspace error:', (err as Error).message);
    }
  }

  async recall(query: string, opts: { limit?: number; workspace?: string; full?: boolean; fast?: boolean; rerank?: boolean; expand?: boolean } = {}): Promise<RecalledMemory[]> {
    try {
      const results = await this.activation.activate({
        agentId: this.agentId,
        context: query,
        limit: opts.limit ?? 5,
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
      return results.map((r: any) => ({
        id: r.engram.id,
        concept: r.engram.concept,
        content: opts.full ? r.engram.content : (r.summary ?? r.engram.content),
        score: r.score,
      }));
    } catch (err) {
      console.error('[awm] recall error:', (err as Error).message);
      return [];
    }
  }

  async write(concept: string, content: string, tags: string[] = [], opts: WriteOpts = {}): Promise<string | null> {
    try {
      const result = await performWrite(
        { store: this.store, connectionEngine: this.connections },
        {
          agentId: this.agentId,
          concept: concept.slice(0, 80),
          content,
          tags: [...tags, 'proj=MWA', ...(this.sessionId ? [`session=${this.sessionId}`] : [])],
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

  async feedback(id: string, useful: boolean): Promise<void> {
    try {
      const engram = this.store.getEngram(id);
      if (!engram) return;
      const delta = useful ? 0.05 : -0.1;
      this.store.updateConfidence(id, Math.max(0.01, Math.min(0.95, engram.confidence + delta)));
      this.activation.validationGate?.resolveFeedback?.(id, useful);
      if (useful) this.store.touchEngram(id);
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
   * Sleep consolidation — the mechanism that makes recall mature over time:
   * cluster overlapping engrams, strengthen intra-cluster edges, bridge related
   * topics, decay/forget noise, sweep staging. Run between sessions ("sleep").
   * Returns the cycle stats (clustersFound, edgesStrengthened, bridgesCreated, …).
   */
  async consolidate(): Promise<Record<string, number>> {
    try {
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

  async addScheduledTask(instruction: string, dueMs: number, opts: { recur?: string; notify?: string; dir?: string; resumeAttempt?: number } = {}): Promise<string | null> {
    const tags = ['topic=scheduled-task', 'status=pending', `due=${Math.round(dueMs)}`];
    if (opts.recur) tags.push(`recur=${opts.recur}`);
    if (opts.notify) tags.push(`notify=${opts.notify}`);
    if (opts.dir) tags.push(`dir=${opts.dir}`);
    if (opts.resumeAttempt) tags.push(`resume=${opts.resumeAttempt}`);
    return this.write(`scheduled: ${instruction.slice(0, 56)}`, instruction, tags, { canonical: true, eventType: 'decision' });
  }

  /** All pending scheduled tasks (parsed). */
  pendingScheduled(): ScheduledTask[] {
    try {
      const engrams: any[] = this.store.getEngramsByAgent(this.agentId) ?? [];
      const out: ScheduledTask[] = [];
      for (const e of engrams) {
        const tags = this.parseTags(e.tags);
        if (!tags.includes('topic=scheduled-task') || !tags.includes('status=pending')) continue;
        const get = (p: string) => (tags.find((t) => t.startsWith(p)) ?? '').slice(p.length);
        out.push({ id: e.id, instruction: e.content, due: Number(get('due=')) || 0, recur: get('recur=') || undefined, notify: get('notify=') || undefined, dir: get('dir=') || undefined, resumeAttempt: Number(get('resume=')) || undefined });
      }
      return out.sort((a, b) => a.due - b.due);
    } catch (err) { console.error('[awm] pendingScheduled error:', (err as Error).message); return []; }
  }

  private setScheduledTags(id: string, mutate: (tags: string[]) => string[]): void {
    try { const e = this.store.getEngram(id); if (e) this.store.updateTags(id, mutate(this.parseTags(e.tags))); } catch { /* */ }
  }
  /** Mark a scheduled task complete (status=done). */
  completeScheduled(id: string): void {
    this.setScheduledTags(id, (tags) => tags.map((t) => (t.startsWith('status=') ? 'status=done' : t)));
  }
  /** Recurring task: set the next due (epoch ms), keep pending. */
  rescheduleTask(id: string, nextDueMs: number): void {
    this.setScheduledTags(id, (tags) => [...tags.filter((t) => !t.startsWith('due=')), `due=${Math.round(nextDueMs)}`]);
  }

  /** Rough count of stored memories for this agent — powers the UI "memory meter". */
  memoryCount(): number {
    try { return (this.store.getEngramsByAgent(this.agentId) ?? []).length; } catch { return 0; }
  }

  /** Recent memories (newest-first), for the UI "Memory" view — makes the substrate
   *  tangible. Filters out internal bookkeeping engrams (run outcomes, session/sleep
   *  summaries, scheduled tasks) so the user sees only genuine learned facts. */
  recentMemories(limit = 40): { id: string; concept: string; content: string }[] {
    try {
      const all: any[] = this.store.getEngramsByAgent(this.agentId) ?? [];
      const facts = all.filter((e) => !/^(agent run:|agent step:|session:|scheduled:|skill:|question:|lesson:|policy:)/i.test(String(e.concept ?? '')));
      return facts.slice(-limit).reverse().map((e) => ({ id: e.id, concept: e.concept ?? '', content: String(e.content ?? '').slice(0, 240) }));
    } catch { return []; }
  }

  /** Persist a reusable procedure ("skill") as a canonical memory. Tagged topic=skill so
   *  auto-prime recalls it on similar future tasks — the agent learns HOW, not just WHAT. */
  async saveSkill(name: string, steps: string): Promise<string | null> {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    return this.write(`skill: ${name}`.slice(0, 80), steps, ['topic=skill', `skill=${slug}`, 'intent=procedural', 'confidence_level=observed'], { canonical: true, eventType: 'observation' });
  }

  /** REFLEXION: record a verbal failure reflection as a canonical memory tagged topic=friction
   *  + eventType=friction, so auto-prime recalls it before similar future tasks. The failure
   *  counterpart of saveSkill — the agent learns from what went wrong, not just what worked. */
  async saveFriction(topic: string, lesson: string): Promise<string | null> {
    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    return this.write(`lesson: ${topic}`.slice(0, 80), lesson, ['topic=friction', `about=${slug}`, 'intent=finding', 'confidence_level=observed'], { canonical: true, eventType: 'friction' });
  }

  /** Failure lessons the agent has recorded, for the UI "Lessons" view. */
  listFriction(): { topic: string; content: string }[] {
    try {
      const all: any[] = this.store.getEngramsByAgent(this.agentId) ?? [];
      return all.filter((e) => this.parseTags(e.tags).includes('topic=friction')).reverse()
        .map((e) => ({ topic: String(e.concept ?? '').replace(/^lesson:\s*/i, ''), content: String(e.content ?? '').slice(0, 300) }));
    } catch { return []; }
  }

  /** STANDING PREFERENCE/POLICY — a user rule that must apply to EVERY future task (tone,
   *  format, approval requirements). Stored canonical + tagged topic=policy so listPolicies()
   *  can always-prime them into the prompt, unlike relevance-pruned recall. Dedup-reinforces. */
  async savePolicy(rule: string): Promise<string | null> {
    const r = rule.trim();
    return this.write(`policy: ${r}`.slice(0, 80), r, ['topic=policy', 'intent=decision', 'confidence_level=verified'], { canonical: true, eventType: 'decision' });
  }

  /** All standing preferences/policies (content), newest-first, deduped — always-primed. */
  listPolicies(): string[] {
    try {
      const all: any[] = this.store.getEngramsByAgent(this.agentId) ?? [];
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

  /** Reusable procedures the agent has learned, for the UI "Skills" view. */
  listSkills(): { name: string; content: string }[] {
    try {
      const all: any[] = this.store.getEngramsByAgent(this.agentId) ?? [];
      return all.filter((e) => this.parseTags(e.tags).includes('topic=skill')).reverse()
        .map((e) => ({ name: String(e.concept ?? '').replace(/^skill:\s*/i, ''), content: String(e.content ?? '').slice(0, 300) }));
    } catch { return []; }
  }

  /** SELF-LEARNING: an open question the agent flagged to answer later (intent=question). */
  async saveQuestion(question: string): Promise<string | null> {
    return this.write(`question: ${question}`.slice(0, 80), question, ['topic=open-question', 'status=open', 'intent=question', 'confidence_level=assumed'], { canonical: true, eventType: 'observation' });
  }

  /** Open (unresolved) questions, for the UI + the resolve pass. */
  listOpenQuestions(): { id: string; question: string }[] {
    try {
      const all: any[] = this.store.getEngramsByAgent(this.agentId) ?? [];
      return all.filter((e) => { const t = this.parseTags(e.tags); return t.includes('topic=open-question') && t.includes('status=open'); })
        .reverse().map((e) => ({ id: e.id, question: String(e.content ?? '') }));
    } catch { return []; }
  }

  /** Mark an open question resolved (the answer is written separately as a normal fact). */
  resolveQuestion(id: string): void {
    try { const e = this.store.getEngram(id); if (e) this.store.updateTags(id, this.parseTags(e.tags).map((t: string) => (t.startsWith('status=') ? 'status=resolved' : t))); } catch { /* */ }
  }

  close(): void {
    try {
      this.store.stopWalCheckpointTimer?.();
      this.store.close?.();
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
  setSessionId(): void {
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
  listPolicies(): string[] {
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
