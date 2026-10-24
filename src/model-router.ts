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

// Long-horizon / multi-deliverable work where the cheap tier tends to quit early or
// under-deliver: a long instruction, or an explicit multi-step task that BOTH researches
// and produces an artifact. These start the conductor strong instead of hoping it copes.
const RESEARCH = /\b(find|search|research|look up|gather|compare|investigate|review|summari[sz]e|catch me up)\b/;
const PRODUCE = /\b(write|create|save|build|generate|draft|produce|compile|table|report|spreadsheet|document)\b/;
export function isComplexTask(task: string): boolean {
  const t = task.toLowerCase();
  if (t.length > 220) return true; // a long instruction is almost always multi-part
  const multiStep = /\bthen\b|\band then\b|\bafter that\b|\b\d\.\s/.test(t);
  return multiStep && RESEARCH.test(t) && PRODUCE.test(t);
}

/** Starting tier for the conductor: strong when the task reads complex/long, else cheap.
 *  Cheap-first stays the default for ordinary work; escalation still earns upgrades below. */
export function startTier(task: string): Tier {
  return classifyIntent(task) === 'reason' || isComplexTask(task) ? 'reason' : 'fetch';
}

export class RoutedProvider implements Provider {
  private tier: Tier;
  escalations = 0;
  readonly perTier = { fetch: { in: 0, out: 0, calls: 0, usd: 0 }, reason: { in: 0, out: 0, calls: 0, usd: 0 } };

  constructor(
    private readonly fetchP: Provider,
    private readonly reasonP: Provider,
    startTier: Tier = 'fetch',
    // Reasoning effort per tier: the cheap tier stays fast/concise (minimal); the strong
    // tier actually reasons (high). Providers apply it only to reasoning-capable models.
    private readonly effort: { fetch: ChatInput['reasoningEffort']; reason: ChatInput['reasoningEffort'] } = { fetch: 'minimal', reason: 'high' },
  ) {
    this.tier = startTier;
  }

  get id(): string { return `routed(${this.fetchP.id} → ${this.reasonP.id})`; }
  get model(): string { return this.active().model; }
  get price(): [number, number] { return this.active().price; }
  private active(): Provider { return this.tier === 'fetch' ? this.fetchP : this.reasonP; }

  getTier(): Tier { return this.tier; }
  /** A stronger model is still above this one: not yet escalated, and the strong tier is a different model (with
   *  MWA_MODEL set, both tiers are the same model, and "escalating" would only change the reasoning effort). */
  strongerAvailable(): boolean { return this.tier === 'fetch' && this.reasonP.model !== this.fetchP.model; }
  /** Escalate one step (fetch → reason). Returns true if it actually changed tier. */
  escalate(): boolean {
    if (this.tier === 'fetch') { this.tier = 'reason'; this.escalations++; return true; }
    return false;
  }
  /** Reset tier + per-run counters (call at the start of each run). */
  reset(startTier: Tier = 'fetch'): void {
    this.tier = startTier;
    this.escalations = 0;
    this.perTier.fetch = { in: 0, out: 0, calls: 0, usd: 0 };
    this.perTier.reason = { in: 0, out: 0, calls: 0, usd: 0 };
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    const tier = this.tier;
    // Engage reasoning per tier (caller can override). Cheap tier = minimal, strong = high.
    const reasoningEffort = input.reasoningEffort ?? (tier === 'fetch' ? this.effort.fetch : this.effort.reason);
    const r = await this.active().chat({ ...input, reasoningEffort });
    const s = this.perTier[tier];
    s.in += r.usage.input;
    s.out += r.usage.output;
    s.calls++;
    // BL-58: the provider's own bill for the call when it reports one (OpenRouter), else tokens at the list price.
    const p = (tier === 'fetch' ? this.fetchP : this.reasonP).price;
    s.usd += typeof r.usage.cost === 'number' ? r.usage.cost : (r.usage.input / 1e6) * p[0] + (r.usage.output / 1e6) * p[1];
    return r;
  }

  /** Tier-aware cost for this run (each tier billed at its own price). */
  spentUsd(): number {
    // Each call was priced as it returned: the provider's own bill when reported (BL-58), else tokens × list price.
    return this.perTier.fetch.usd + this.perTier.reason.usd;
  }
}
