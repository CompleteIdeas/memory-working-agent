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
import { priceFor, warnUnknownPrice, UNKNOWN_PRICE } from './model-prices.js';

export interface Ledger {
  /** dollars spent by the calls made under this ledger (its children included) */
  usd: number;
  calls: number;
  /** the dollar cap of the run that owns it, if any */
  cap?: number;
  /** dollars of this ledger's cap handed to follow-ups it scheduled (A3b re-review): spent from its allowance */
  reserved: number;
  parent?: Ledger;
  /** set once its owner has reported: a call landing afterwards is passed to `onLate` (the Try's cost is updated) */
  closed?: boolean;
  onLate?: (usd: number) => void;
}

export const spendLedger = new AsyncLocalStorage<Ledger>();

/** A new ledger under the current one (if any). */
export function newLedger(o: { cap?: number } = {}): Ledger {
  return { usd: 0, calls: 0, reserved: 0, ...(o.cap && o.cap > 0 ? { cap: o.cap } : {}), parent: spendLedger.getStore() };
}
/** Run `fn` with its own ledger (a child of the current one). */
export function withLedger<T>(l: Ledger, fn: () => T): T { return spendLedger.run(l, fn); }
/** The owner has reported what it spent: anything that lands later goes to `onLate` instead of being lost. */
export function closeLedger(l: Ledger, onLate?: (usd: number) => void): void { l.closed = true; if (onLate) l.onLate = onLate; }

/** The cap of the current ledger chain carries one (any ledger above with a cap). */
export const underCap = (l: Ledger | undefined = spendLedger.getStore()): boolean => { for (let x = l; x; x = x.parent) if (x.cap !== undefined) return true; return false; };

/**
 * One call's cost: the provider's own bill when it reports one; else its tokens at the list price — the model's row
 * in src/model-prices.ts when there is one (with Anthropic's cache reads and writes at their own rates), else the
 * provider's price. A model with no price at all is not free when a cap is set: it is counted at UNKNOWN_PRICE.
 */
export function callCostUsd(price: readonly [number, number] | undefined, usage: ChatResult['usage'] | undefined, o: { model?: string; local?: boolean; capped?: boolean } = {}): number {
  if (!usage) return 0;
  if (typeof usage.cost === 'number' && Number.isFinite(usage.cost)) return Math.max(0, usage.cost);
  const row = o.model ? priceFor(o.model) : null;
  let p: readonly [number, number] = row ? [row.in, row.out] : price ?? [0, 0];
  if (!(p[0] > 0 || p[1] > 0) && !o.local && o.capped) { if (o.model) warnUnknownPrice(o.model); p = [UNKNOWN_PRICE.in, UNKNOWN_PRICE.out]; }
  let v = ((usage.input ?? 0) / 1e6) * (p[0] ?? 0) + ((usage.output ?? 0) / 1e6) * (p[1] ?? 0);
  // Anthropic reports cached tokens beside `input`; OpenAI-style providers count them inside it (cacheInInput).
  if (!usage.cacheInInput) v += ((usage.cacheRead ?? 0) / 1e6) * (row?.cacheRead ?? 0.1 * p[0]) + ((usage.cacheWrite ?? 0) / 1e6) * (row?.cacheWrite ?? 1.25 * p[0]);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Add a call's cost to a ledger and every ledger above it; a closed one passes it on to its `onLate`. */
export function recordSpend(usd: number, l: Ledger | undefined = spendLedger.getStore()): void {
  for (let x = l; x; x = x.parent) { x.usd += usd; x.calls++; if (x.closed && usd > 0) { try { x.onLate?.(usd); } catch { /* bookkeeping */ } } }
}

/** What the current ledger chain may still spend: the smallest (cap − spent − reserved) over its capped ledgers. */
export function allowanceLeft(l: Ledger | undefined = spendLedger.getStore()): number | undefined {
  let left: number | undefined;
  for (let x = l; x; x = x.parent) if (x.cap !== undefined) left = Math.min(left ?? Infinity, x.cap - x.usd - x.reserved);
  return left === undefined ? undefined : Math.max(0, left);
}

/**
 * Hand part of the current run's allowance to a follow-up it schedules (A3b re-review, HIGH): half of what is left
 * after one call's worth is kept back for the run's own wrap-up, reserved on every capped ledger in the chain — so the
 * run and all its follow-ups together can never be authorised past the run's cap. Undefined when no cap applies.
 */
export function reserveForFollowUp(l: Ledger | undefined = spendLedger.getStore(), callUsd = 0.01): number | undefined {
  const left = allowanceLeft(l);
  if (left === undefined) return undefined;
  const share = Math.max(0, (left - callUsd) / 2);
  const give = Math.floor(share * 1e6) / 1e6;
  for (let x = l; x; x = x.parent) if (x.cap !== undefined) x.reserved += give;
  return give;
}

/** The provider that answers a call made now: through a router's tier or a background switch to the model itself. */
function leafOf(p: Provider): Provider {
  let cur: Provider = p;
  for (let i = 0; i < 4; i++) {
    const next = (cur as { current?: () => Provider }).current?.();
    if (!next || next === cur) break;
    cur = next;
  }
  return cur;
}

const METERED = Symbol('mwa.metered');
const wrapped = new WeakMap<object, Provider>();
/**
 * The provider, metered: each `chat` adds its cost to the ledger that was current when it was called. One wrapper per
 * provider object (wrapping a wrapper returns it), so a provider used as both brain and worker is counted once a call.
 * A call that throws after the provider paid for tokens (the error carries `usage`) is billed before it rethrows.
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
          // who answers and at what price, read before the call (an escalation between calls changes both)
          const ledger = spendLedger.getStore();
          let leaf: Provider = target;
          try { leaf = leafOf(target); } catch { leaf = target; }
          const price = leaf.price, model = leaf.model, local = /^ollama:/.test(String(leaf.id ?? ''));
          const bill = (usage: ChatResult['usage'] | undefined) => recordSpend(callCostUsd(price, usage, { model, local, capped: underCap(ledger) }), ledger);
          let r: ChatResult;
          try { r = await (target.chat as Provider['chat']).call(target, input); }
          catch (e) { const u = (e as { usage?: ChatResult['usage'] }).usage; if (u) bill(u); throw e; }
          bill(r?.usage);
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
