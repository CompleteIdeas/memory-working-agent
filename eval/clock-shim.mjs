// Accelerated clock for the promise assessment (docs/assessment-2026-10-19.md).
//
// Loaded before anything else with NODE_OPTIONS=--import=/eval/clock-shim.mjs. When
// MWA_EVAL_CLOCK_FILE names a file holding {"offsetMs": N}, every Date in this process reads
// real time + N: the harness jumps virtual time by rewriting the file. Timers (setTimeout,
// setInterval) and performance.now stay real, so model-call timeouts are unaffected, and
// virtual time flows at the real rate between jumps. Without the variable this does nothing.
import { readFileSync } from 'node:fs';

const FILE = process.env.MWA_EVAL_CLOCK_FILE;
if (FILE && !globalThis.__mwaEvalClock) {
  const Real = Date;
  const realNow = Real.now.bind(Real);
  let offset = 0;
  let readAt = -Infinity;
  const off = () => {
    const t = realNow();
    if (t - readAt > 200) {
      readAt = t;
      try { offset = Number(JSON.parse(readFileSync(FILE, 'utf8')).offsetMs) || 0; } catch { /* keep the last offset */ }
    }
    return offset;
  };
  const now = () => realNow() + off();
  globalThis.Date = new Proxy(Real, {
    construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [now()], newTarget); },
    apply() { return new Real(now()).toString(); },
    get(target, prop, receiver) { return prop === 'now' ? now : Reflect.get(target, prop, receiver); },
  });
  globalThis.__mwaEvalClock = { now, realNow };
}
