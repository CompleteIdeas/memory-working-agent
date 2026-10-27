/**
 * Slowing down guesses without ever locking the owner out (W5 security review, 2026-10-26).
 *
 * The A2/W5 throttles refused outright: 10 wrong passwords (5 wrong codes) per source in 10 minutes, and a global
 * ceiling of 200 — so anyone could lock the owner out by flooding, and the source was taken from X-Forwarded-For,
 * which anyone can write. Now:
 *   - the source is the socket peer (X-Forwarded-For only behind a configured trusted proxy: trust.ts sourceOf);
 *   - attempts from one source are checked one at a time, and each waits longer after that source's recent failures:
 *     nothing for the first 3, then 0.25 s doubling to at most 10 s;
 *   - many failures across all sources (over 50 in a minute) add up to 3 s more to every attempt;
 *   - nothing is ever refused for being throttled: a correct password (or code) is checked and accepted, at worst
 *     after the wait. An attempt never waits more than 30 s in all, however long the queue in front of it.
 * Failures are counted for 10 minutes. In memory; a restart clears it.
 */
const WINDOW_MS = 10 * 60_000;
const MAX_WAIT_MS = 30_000;

export interface GateOptions {
  /** free failures per source before waits begin */
  free?: number;
  baseMs?: number;
  maxPerSourceMs?: number;
  /** failures in the last minute, across all sources, before everyone waits a little */
  globalFree?: number;
  globalStepMs?: number;
  globalMaxMs?: number;
  /** tests: a sleep that records instead of waiting */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class SlowGate {
  private fails = new Map<string, number[]>();
  private global: number[] = [];
  private tails = new Map<string, Promise<void>>();
  private o: Required<GateOptions>;
  constructor(o: GateOptions = {}) {
    this.o = {
      free: 3, baseMs: 250, maxPerSourceMs: 10_000, globalFree: 50, globalStepMs: 20, globalMaxMs: 3_000,
      sleep: (ms) => new Promise((r) => { const t = setTimeout(r, ms); (t as { unref?: () => void }).unref?.(); }),
      now: () => Date.now(), ...o,
    };
  }
  private recent(list: number[], since: number): number[] { while (list.length && list[0] < since) list.shift(); return list; }
  /** How long the next attempt from this source waits now. */
  delayFor(source: string): number {
    const now = this.o.now();
    const n = this.recent(this.fails.get(source) ?? [], now - WINDOW_MS).length;
    const per = n < this.o.free ? 0 : Math.min(this.o.maxPerSourceMs, this.o.baseMs * 2 ** (n - this.o.free));
    const g = this.recent(this.global, now - 60_000).length;
    const glob = g <= this.o.globalFree ? 0 : Math.min(this.o.globalMaxMs, (g - this.o.globalFree) * this.o.globalStepMs);
    return per + glob;
  }
  failures(source: string): number { return this.recent(this.fails.get(source) ?? [], this.o.now() - WINDOW_MS).length; }
  /** Run one attempt for `source`: after the attempts already queued for it, and after its wait. `check` answers
   *  whether it succeeded; a failure is counted, a success clears the source's count. */
  async attempt<T>(source: string, check: () => Promise<{ ok: boolean; value: T }> | { ok: boolean; value: T }): Promise<T> {
    const start = this.o.now();
    const queued = this.tails.get(source);
    const before = queued ?? Promise.resolve();
    let done!: () => void;
    const mine = new Promise<void>((r) => { done = r; });
    const tail = before.then(() => mine);
    this.tails.set(source, tail);
    try {
      const left = () => Math.max(0, MAX_WAIT_MS - (this.o.now() - start));
      if (queued) await Promise.race([before, this.o.sleep(left())]); // wait for the attempts in front, at most 30 s
      const wait = Math.min(this.delayFor(source), left());
      if (wait > 0) await this.o.sleep(wait);
      const r = await check();
      const now = this.o.now();
      if (r.ok) this.fails.delete(source);
      else {
        const l = this.recent(this.fails.get(source) ?? [], now - WINDOW_MS); l.push(now); this.fails.set(source, l);
        this.recent(this.global, now - 60_000).push(now);
      }
      return r.value;
    } finally {
      done();
      if (this.tails.get(source) === tail) this.tails.delete(source);
    }
  }
  reset(): void { this.fails.clear(); this.global = []; this.tails.clear(); }
  /** Tests: change the timing (a recording sleep, a fake clock). */
  configure(o: GateOptions): void { this.o = { ...this.o, ...o } as Required<GateOptions>; }
}

/** Password sign-ins (POST /api/v1/session and the legacy POST /api/login share it) and pairing codes. */
export const signInGate = new SlowGate();
export const pairingGate = new SlowGate();
