/**
 * The status pill (v2 slices A10 and W1): one status line for every screen, from the jobs' own server-computed states
 * (src/v2/status.ts jobStatus) — what is working, what waits for the person, what results are ready. The server
 * (GET /today `status`) and the web app (web/src/v2/store/status.ts pillFor) both call THIS function, so the pill, the
 * working sheet's heading and Today can never disagree. No imports, on purpose: the web build compiles it as is.
 *
 *   state                         counts as
 *   working, continuing           working
 *   waiting                       waiting for you
 *   any other state + resultReady result ready (a finished job not opened yet, or a repeating job's new result)
 *
 * Words (the prototype's): "Helper is resting", "Working on 1 thing", "Working on 2 things",
 * "Working on 1 · 1 waiting for you", "Working on 1 · 1 result ready", "1 result ready".
 */

export type PillTone = 'needs' | 'working' | 'resting';
export interface StatusPill {
  text: string;
  /** needs: something waits for the person or a result is ready; working: only work in progress; resting: nothing */
  tone: PillTone;
  working: number;
  waiting: number;
  ready: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The pill from job statuses (archived jobs left out by the caller). */
export function statusPill(statuses: readonly { state: string; resultReady?: boolean | null }[]): StatusPill {
  let working = 0, waiting = 0, ready = 0;
  for (const s of statuses) {
    if (s.state === 'working' || s.state === 'continuing') { working++; continue; }
    if (s.state === 'waiting') waiting++;
    else if (s.resultReady === true) ready++;
  }
  const parts: string[] = [];
  if (working) parts.push(waiting || ready ? `Working on ${working}` : `Working on ${plural(working, 'thing', 'things')}`);
  if (waiting) parts.push(`${waiting} waiting for you`);
  if (ready) parts.push(`${plural(ready, 'result', 'results')} ready`);
  return { text: parts.length ? parts.join(' · ') : 'Helper is resting', tone: waiting || ready ? 'needs' : working ? 'working' : 'resting', working, waiting, ready };
}
