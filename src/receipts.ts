/**
 * Delivery receipts (BL-13). A finished run is not a delivered result: a scheduled report can run
 * perfectly and still reach nobody — a Telegram chat that blocked the bot, an app nobody opened, a
 * job set to stay quiet. Each channel records what actually happened to each fire's result, so
 * "did my report reach me?" has an answer.
 *
 * - One file PER PROCESS (`deliveries-<producer>.jsonl` beside the notifications log): serve and the
 *   Telegram connector run their own schedulers, and two processes never append to the same file.
 *   Readers merge them.
 * - Statuses say what is known, no more. `served` means the app handed the result to an open app tab
 *   (which polls whether anyone is looking, and with no access password could be any client on the
 *   network) — not that a person read it. `sent` means Telegram accepted the message.
 * - Each file is capped: past ~1 MB it keeps its newest lines.
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { notifyPath } from './paths.js';

export type ReceiptChannel = 'app' | 'telegram' | 'push' | 'none';
/** stored: written to the app's feed · served: handed to an open app tab (not proof it was read) · sent: accepted by
 *  Telegram · accepted: (web push, P3) the browser vendor's push service took it — NOT that the phone showed it (the
 *  phone may be off; the service keeps it for a few hours), so it does not count as reached · held: waiting for quiet hours to end or a retry · failed / dropped: did not arrive ·
 *  not-sent: the job's delivery setting kept it quiet · superseded: a later result of the same job
 *  replaced it while it waited (that later one carries the fate). A job with NO channel is `failed`. */
export type ReceiptStatus = 'stored' | 'served' | 'sent' | 'accepted' | 'held' | 'failed' | 'dropped' | 'not-sent' | 'superseded';
export interface Receipt { ts: number; job: string; fire: string; channel: ReceiptChannel; status: ReceiptStatus; detail?: string; by: string }

const MAX_BYTES = 1_000_000;
const KEEP_LINES = 2000;
/** however busy other jobs are, each job keeps at least its newest few fires (BL-13 review). */
const KEEP_FIRES_PER_JOB = 5;
/** Receipts key a job by its id's first 8 characters: a resumed run knows its job only by that
 *  prefix (the `resumeof=` tag), and both must land on the same job (BL-13 review). */
export const jobKey = (id: string): string => id.slice(0, 8);
let producer = 'mwa';
/** Name this process's receipts file (serve, telegram, …). */
export function setReceiptProducer(name: string): void { producer = name.replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'mwa'; }

function receiptsDir(): string {
  return process.env.MWA_RECEIPTS_DIR ?? dirname(notifyPath());
}

function endsTorn(p: string): boolean {
  try {
    const size = statSync(p).size;
    if (!size) return false;
    const fd = openSync(p, 'r'); const buf = Buffer.alloc(1);
    try { readSync(fd, buf, 0, 1, size - 1); } finally { closeSync(fd); }
    return buf[0] !== 10;
  } catch { return false; }
}

/** Record what happened to one fire's result on one channel. Never throws: a receipt must not break delivery. */
export function recordReceipt(r: Omit<Receipt, 'ts' | 'by'> & { ts?: number }): void {
  try {
    const dir = receiptsDir();
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `deliveries-${producer}.jsonl`);
    // A crash mid-append leaves a torn last line; start a fresh line so this receipt isn't glued to it.
    appendFileSync(p, (endsTorn(p) ? '\n' : '') + JSON.stringify({ ts: r.ts ?? Date.now(), job: jobKey(r.job), fire: r.fire, channel: r.channel, status: r.status, ...(r.detail ? { detail: r.detail.slice(0, 200) } : {}), by: producer }) + '\n');
    if (statSync(p).size > MAX_BYTES) {
      // Keep the newest lines, and every job's newest few fires: a minute-by-minute monitor must not
      // push a daily job's only receipts out, which would read as "no data" (BL-13 review).
      const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
      const firesByJob = new Map<string, string[]>();
      const parsed = lines.map((l) => { try { return JSON.parse(l) as Receipt; } catch { return null; } });
      for (const r of parsed) if (r) { const f = firesByJob.get(r.job) ?? []; if (!f.includes(r.fire)) f.push(r.fire); firesByJob.set(r.job, f); }
      const keepFires = new Set([...firesByJob.values()].flatMap((f) => f.slice(-KEEP_FIRES_PER_JOB)));
      const cut = lines.length - KEEP_LINES;
      const kept = lines.filter((_, i) => i >= cut || (parsed[i] && keepFires.has(parsed[i]!.fire)));
      writeFileSync(`${p}.tmp`, kept.join('\n') + '\n');
      renameSync(`${p}.tmp`, p);
    }
  } catch { /* best-effort */ }
}

/** Every receipt from every process, oldest first. */
export function readReceipts(): Receipt[] {
  const out: Receipt[] = [];
  let files: string[] = [];
  try { files = readdirSync(receiptsDir()).filter((f) => /^deliveries-[a-z0-9-]+\.jsonl$/i.test(f)); } catch { return out; }
  for (const f of files) {
    let text = '';
    try { text = readFileSync(join(receiptsDir(), f), 'utf8'); } catch { continue; }
    for (const l of text.split('\n')) {
      if (!l.trim()) continue;
      try { const r = JSON.parse(l) as Receipt; if (r && typeof r.job === 'string' && typeof r.fire === 'string') out.push(r); } catch { /* skip a torn line */ }
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

const REACHED: ReceiptStatus[] = ['sent', 'served'];

/** Per fire of one job: each channel's latest status, and whether it reached the person. Newest first. */
export function jobDeliveries(job: string, receipts: Receipt[] = readReceipts()): { fire: string; ts: number; channels: Record<string, Receipt>; reached: boolean; quiet: boolean }[] {
  const fires = new Map<string, { fire: string; ts: number; channels: Record<string, Receipt> }>();
  const key = jobKey(job);
  for (const r of receipts) {
    if (jobKey(r.job) !== key) continue;
    const f = fires.get(r.fire) ?? { fire: r.fire, ts: r.ts, channels: {} };
    f.channels[r.channel] = r; // receipts are oldest first, so the last one per channel wins
    fires.set(r.fire, f);
  }
  return [...fires.values()]
    .map((f) => {
      const all = Object.values(f.channels);
      // `superseded`: a later result of the same job replaced it in the queue — it reached the person
      // exactly when that later one did, so it neither counts as reached nor as lost on its own.
      return { ...f, reached: all.some((r) => REACHED.includes(r.status)), quiet: all.length > 0 && all.every((r) => (r.status === 'not-sent' && r.channel === 'none') || r.status === 'superseded') };
    })
    .sort((a, b) => b.ts - a.ts);
}

const CHANNEL = { app: 'the app', telegram: 'Telegram', push: 'phone notifications', none: '' } as const;
/** The time, with the date when it isn't today — a job that stopped firing must not look current. */
const hhmm = (ts: number) => {
  const d = new Date(ts); const t = d.toTimeString().slice(0, 5);
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleString('en-US', { month: 'short', day: 'numeric' })} ${t}`;
};
function describe(r: Receipt): string {
  if (r.channel === 'none' && r.status === 'failed') return `nothing could send it${r.detail ? `: ${r.detail}` : ''}`;
  const where = CHANNEL[r.channel];
  switch (r.status) {
    case 'sent': return `sent to ${where} ${hhmm(r.ts)}${r.detail ? ` (${r.detail})` : ''}`;
    case 'accepted': return `handed to the push service ${hhmm(r.ts)} (not proof the phone showed it)`;
    case 'served': return `shown in an open app tab ${hhmm(r.ts)} (not proof it was read)`;
    case 'stored': return `saved in ${where}, not yet shown in an open tab`;
    case 'superseded': return `replaced by a later result before it was sent`;
    case 'held': return `held for ${where}${r.detail ? `: ${r.detail}` : ''}`;
    case 'failed': return `${where} failed${r.detail ? `: ${r.detail}` : ''}`;
    case 'dropped': return `${where} dropped it${r.detail ? `: ${r.detail}` : ''}`;
    case 'not-sent': return `not sent${r.detail ? ` (${r.detail})` : ''}`;
  }
}

/** One line for schedule_list: the latest result's fate per channel, and a warning when several in a
 *  row reached no one (a job can run green for days while its reports go nowhere). */
export function deliveryLine(job: string, receipts?: Receipt[]): string {
  const fires = jobDeliveries(job, receipts);
  if (!fires.length) return '';
  const last = fires[0];
  const parts = Object.values(last.channels).sort((a, b) => a.channel.localeCompare(b.channel)).map(describe);
  const lostRun = fires.slice(0, 3);
  const warn = lostRun.length === 3 && lostRun.every((f) => !f.reached && !f.quiet && !Object.values(f.channels).some((r) => r.status === 'held' || r.status === 'stored'))
    ? ' — ⚠ the last 3 results reached no one'
    : '';
  return `last result (${hhmm(last.ts)}): ${parts.join('; ')}${warn}`;
}
