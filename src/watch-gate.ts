/**
 * BL-73 — a change-only watch's message, checked by Clef before it goes out. Robert, 2026-10-23: "if we could get
 * Clef working better, we could use that … the reason you might use clef is speed … So it's a layered approach."
 *
 * The scheduler decides "changed" by comparing the watch's reading as TEXT (sameReading: case, spacing and end
 * punctuation only). Sol words a reading the same way each day; the cheap models measured in the job bake-off
 * (2026-10-23) do not, and each rewording reached the person as news:
 *   - "FINAL (2026-11-06)" then "RESULTS: FINAL (dated 2026-11-06)" on the confirming check — "Confirmed finished"
 *     and the whole message again (MiniMax M3.1 Flash, Haiku 5.5);
 *   - "PROVISIONAL" then "PROVISIONAL (scores corrected Nov 5)", for someone who asked only to hear "final" (Haiku);
 *   - "No change." with no reading and no declared outcome, sent as news twice (Luna).
 * Clef answers one question — as far as the person's request goes, does this check report the same situation as
 * the last one? — and a yes keeps the watch quiet. It only ever turns a message into silence on a watch set to
 * report changes; a failure, a staged action, or no answer in time changes nothing.
 *
 * Needs MWA_CLEF_TOKEN and MWA_CLEF_ACCOUNT, as the approval reviewer does; MWA_WATCH_GATE=off turns it off. The
 * person's watch request, the last reading and this check's message go to Cloudflare.
 */

export interface WatchGateInput {
  /** what the person asked for when the watch was set up */
  request: string;
  /** the condition that finishes the watch, if it has one */
  until?: string;
  /** what the watch last reported: its reading, else its last message */
  previous: string;
  /** this check's reading, when the run gave one */
  reading?: string;
  /** this check's message */
  message: string;
}
/** Clef's probability that this check reports the same situation as the last one; null when it did not answer. */
export type WatchGate = (input: WatchGateInput) => Promise<number | null>;

/** At or above this, the check is the same situation and stays quiet (docs/watch-gate-calibration-2026-10-23.md). */
export const SAME_THRESHOLD = 0.6;
const TIMEOUT_MS = 4_000;

const QUESTIONS = {
  same: { type: 'noul', instructions: 'The person set up a watch and asked to be told only about a specific change (REQUEST; the watch stops once UNTIL holds). PREVIOUS is what the watch last reported; NOW is this check. As far as the request goes, does NOW report the same situation as PREVIOUS, so there is nothing new they asked to hear? Yes when the only differences are wording, formatting, emphasis, extra detail, or a change that does not bear on what they asked about (for example a status that is still not the one they wait for). No when the thing they asked about has changed, or what they wait for now holds and did not before.' },
} as const;

/** Clef over Cloudflare Workers AI; null on any failure or after the timeout. */
export function clefWatchGate(o: { token: string; account: string; model?: string; fetchImpl?: typeof fetch; timeoutMs?: number }): WatchGate {
  const model = o.model ?? 'clef';
  const f = o.fetchImpl ?? fetch;
  return async (i) => {
    try {
      const res = await f(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(o.account)}/ai/run/@cf/cloudflare/${model}`, {
        method: 'POST', headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS),
        body: JSON.stringify({ model, questions: QUESTIONS, state: {
          request: i.request.slice(0, 1500),
          until: (i.until ?? '(none)').slice(0, 400),
          previous: i.previous.slice(0, 1000),
          now: (i.reading ? `Reading: ${i.reading}\nMessage: ${i.message}` : i.message).slice(0, 2000),
        } }),
      });
      if (!res.ok) return null;
      const body = await res.json() as { success?: boolean; result?: { answers?: Record<string, { noul?: number }> } };
      const p = Number(body.result?.answers?.same?.noul);
      return body.success === false || !Number.isFinite(p) ? null : p;
    } catch { return null; }
  };
}

let cached: { key: string; gate: WatchGate | null } | null = null;
/** The configured gate, or null (no Clef, or MWA_WATCH_GATE=off). */
export function configuredWatchGate(env: NodeJS.ProcessEnv = process.env): WatchGate | null {
  if (/^(0|off|false|no)$/i.test(String(env.MWA_WATCH_GATE ?? '').trim())) return null;
  const token = env.MWA_CLEF_TOKEN ?? '';
  const account = env.MWA_CLEF_ACCOUNT ?? '';
  const key = `${token.length}:${account}`;
  if (cached?.key === key) return cached.gate;
  cached = { key, gate: token && account ? clefWatchGate({ token, account }) : null };
  return cached.gate;
}
