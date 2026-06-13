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
import { performWrite } from 'agent-working-memory/dist/core/write-pipeline.js';
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
  recall(query: string, opts?: { limit?: number; workspace?: string }): Promise<RecalledMemory[]>;
  write(concept: string, content: string, tags?: string[], opts?: WriteOpts): Promise<string | null>;
  feedback(id: string, useful: boolean): Promise<void>;
  close(): void;
}

export class MwaMemory implements Memory {
  readonly enabled = true;
  private store: any;
  private activation: any;
  private connections: any;

  constructor(
    private readonly agentId: string,
    dbPath: string,
  ) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.store = new EngramStore(dbPath);
    this.activation = new ActivationEngine(this.store);
    this.connections = new ConnectionEngine(this.store, this.activation);
  }

  async recall(query: string, opts: { limit?: number; workspace?: string } = {}): Promise<RecalledMemory[]> {
    try {
      const results = await this.activation.activate({
        agentId: this.agentId,
        context: query,
        limit: opts.limit ?? 5,
        minScore: 0.05,
        useReranker: true,
        useExpansion: true,
        granularity: 'compact',
        workspace: opts.workspace,
        internal: true,
      });
      return results.map((r: any) => ({
        id: r.engram.id,
        concept: r.engram.concept,
        content: r.summary ?? r.engram.content,
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
          tags: [...tags, 'proj=MWA'],
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
  async feedback(): Promise<void> {
    /* no-op */
  }
  close(): void {
    /* no-op */
  }
}
