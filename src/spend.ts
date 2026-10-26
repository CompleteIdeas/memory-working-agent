/**
 * v2 slice A3b (review fix H1): what a run spends, counted call by call.
 *
 * The first cut took differences of RoutedProvider.spentUsd(), a counter that one provider object keeps for every run
 * it serves and that each run resets at its start. That lost spend (an uncapped run after another on the same router
 * reported $0; every plan step lost the previous step's) and mixed concurrent runs together. Now every model call made
 * by a run is priced once, as it returns — the provider's own bill (`usage.cost`, OpenRouter) when it gives one, else
 * its tokens at the price of the provider that answered — and added to the run's ledger and to every ledger above it
 * (a plan step's spend is also the plan's, and the scheduler's for the Try it runs).
 *
 * The ledger travels in AsyncLocalStorage, so concurrent runs on one provider object never count each other's calls,
 * and so does everything a run awaits: the worker, sampled answers and their merge, the boss's escalation, compaction,
 * the lesson judge (each provider is wrapped with `metered`). The wrapper is a Proxy: `instanceof RoutedProvider`,
 * escalate() and reset() keep working on the provider underneath. billing.ts and tokens.jsonl are unchanged.
 *
 * Not counted: the Cloudflare second opinion (src/second-opinion.ts) is billed by Cloudflare outside MWA's model
 * providers; it is a fixed, small Workers AI call and is not part of a run's dollar cap.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Provider, ChatResult } from './provider.js';

export interface Ledger {
  /** dollars spent by the calls made under this ledger (its children included) */
  usd: number;
  calls: number;
  /** the dollar cap of the run that owns it, if any (a follow-up it schedules inherits what is left) */
  cap?: number;
  parent?: Ledger;
}

export const spendLedger = new AsyncLocalStorage<Ledger>();

/** A new ledger under the current one (if any). */
export function newLedger(o: { cap?: number } = {}): Ledger {
  return { usd: 0, calls: 0, ...(o.cap && o.cap > 0 ? { cap: o.cap } : {}), parent: spendLedger.getStore() };
}
/** Run `fn` with its own ledger (a child of the current one). */
export function withLedger<T>(l: Ledger, fn: () => T): T { return spendLedger.run(l, fn); }

/** One call's cost: the provider's own bill when it reports one, else tokens at its list price ($ per million). */
export function callCostUsd(price: readonly [number, number] | undefined, usage: ChatResult['usage'] | undefined): number {
  if (!usage) return 0;
  if (typeof usage.cost === 'number' && Number.isFinite(usage.cost)) return Math.max(0, usage.cost);
  const p = price ?? [0, 0];
  const v = ((usage.input ?? 0) / 1e6) * (p[0] ?? 0) + ((usage.output ?? 0) / 1e6) * (p[1] ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Add a call's cost to the current ledger and every ledger above it. */
export function recordSpend(usd: number): void {
  for (let l = spendLedger.getStore(); l; l = l.parent) { l.usd += usd; l.calls++; }
}

/** What the current ledger chain may still spend: the smallest (cap − spent) over the ledgers that carry a cap. */
export function allowanceLeft(l: Ledger | undefined = spendLedger.getStore()): number | undefined {
  let left: number | undefined;
  for (let x = l; x; x = x.parent) if (x.cap !== undefined) left = Math.min(left ?? Infinity, x.cap - x.usd);
  return left === undefined ? undefined : Math.max(0, left);
}

const METERED = Symbol('mwa.metered');
const wrapped = new WeakMap<object, Provider>();
/**
 * The provider, metered: each `chat` adds its cost to whatever ledger is current when it is called. One wrapper per
 * provider object (wrapping a wrapper returns it), so a provider used as both brain and worker is counted once a call.
 */
export function metered<P extends Provider>(p: P): P;
export function metered<P extends Provider>(p: P | null | undefined): P | null | undefined;
export function metered<P extends Provider>(p: P | null | undefined): P | null | undefined {
  if (!p || typeof p !== 'object') return p;
  if ((p as unknown as Record<symbol, unknown>)[METERED]) return p;
  const had = wrapped.get(p);
  if (had) return had as P;
  const proxy = new Proxy(p, {
    get(target, prop) {
      if (prop === METERED) return true;
      if (prop === 'chat') {
        return async (input: Parameters<Provider['chat']>[0]) => {
          // the price of the tier that answers, read before the call (an escalation between calls changes it)
          let price: [number, number] | undefined;
          try { price = Reflect.get(target, 'price', target) as [number, number]; } catch { price = undefined; }
          const r = await (target.chat as Provider["chat"]).call(target, input);
          recordSpend(callCostUsd(price, r?.usage));
          return r;
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
    set(target, prop, value) { return Reflect.set(target, prop, value, target); },
  });
  wrapped.set(p, proxy);
  return proxy;
}
