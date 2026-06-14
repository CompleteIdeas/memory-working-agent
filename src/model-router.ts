/**
 * Model router — the load-bearing piece of the actual thesis: AWM is the constant
 * substrate; the model TIER is a dial. Start cheap ("fetch"), escalate to strong
 * ("reason") when the task proves too hard. The stronger model inherits all the
 * AWM context, so escalation is cheap — no re-derivation across the switch.
 *
 * Mirrors USEA's harness/adapters/model-router.ts: deterministic intent
 * classification for the starting tier + failure-triggered escalation. Implemented
 * as a Provider so it drops into runBrain wherever a single provider was passed.
 */
import type { Provider, ChatInput, ChatResult } from './provider.js';

export type Tier = 'fetch' | 'reason';

// Hard-signal patterns → start on the strong tier; mechanical patterns → start cheap.
const REASON_PATTERNS = [
  /\b(analy[sz]e|investigate|diagnose|debug|explain|why|compare)\b/,
  /\b(refactor|migrate|optimi[sz]e|redesign|architect|reconcile)\b/,
  /\b(constraint|must not|without using|do not use|invariant|edge case)\b/,
];
const FETCH_PATTERNS = [
  /\b(add|create|write|implement|return|print|build|list|show|get|count|sum)\b/,
];

/** Deterministic starting-tier choice — no LLM call. Default fetch: try cheap first, let escalation earn the upgrade. */
export function classifyIntent(task: string): Tier {
  const t = task.toLowerCase();
  for (const p of REASON_PATTERNS) if (p.test(t)) return 'reason';
  for (const p of FETCH_PATTERNS) if (p.test(t)) return 'fetch';
  return 'fetch';
}

export class RoutedProvider implements Provider {
  private tier: Tier;
  escalations = 0;
  readonly perTier = { fetch: { in: 0, out: 0, calls: 0 }, reason: { in: 0, out: 0, calls: 0 } };

  constructor(
    private readonly fetchP: Provider,
    private readonly reasonP: Provider,
    startTier: Tier = 'fetch',
  ) {
    this.tier = startTier;
  }

  get id(): string { return `routed(${this.fetchP.id} → ${this.reasonP.id})`; }
  get model(): string { return this.active().model; }
  get price(): [number, number] { return this.active().price; }
  private active(): Provider { return this.tier === 'fetch' ? this.fetchP : this.reasonP; }

  getTier(): Tier { return this.tier; }
  /** Escalate one step (fetch → reason). Returns true if it actually changed tier. */
  escalate(): boolean {
    if (this.tier === 'fetch') { this.tier = 'reason'; this.escalations++; return true; }
    return false;
  }
  /** Reset tier + per-run counters (call at the start of each run). */
  reset(startTier: Tier = 'fetch'): void {
    this.tier = startTier;
    this.escalations = 0;
    this.perTier.fetch = { in: 0, out: 0, calls: 0 };
    this.perTier.reason = { in: 0, out: 0, calls: 0 };
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    const tier = this.tier;
    const r = await this.active().chat(input);
    const s = this.perTier[tier];
    s.in += r.usage.input;
    s.out += r.usage.output;
    s.calls++;
    return r;
  }

  /** Tier-aware cost for this run (each tier billed at its own price). */
  spentUsd(): number {
    return (
      (this.perTier.fetch.in / 1e6) * this.fetchP.price[0] +
      (this.perTier.fetch.out / 1e6) * this.fetchP.price[1] +
      (this.perTier.reason.in / 1e6) * this.reasonP.price[0] +
      (this.perTier.reason.out / 1e6) * this.reasonP.price[1]
    );
  }
}
