/**
 * Web push: what notifies, and when (v2 build, slice P3, 2026-10-27).
 *
 * A tick (every 30 s in serve) looks at the same sources Today's "Needs you" uses and notifies the person's
 * subscribed devices about the moments that need them:
 *   - approval  an approval waiting (the owner's; never one whose Important item carries the phishing caution);
 *   - waiting   a job entering "waiting for you" (the dollar limit it reached; a job waiting on an approval is the
 *               approval's notification, not a second one);
 *   - result    a result ready: a finished job's result not opened yet, or a repeating job's new result (each fire
 *               is its own); live chats are not notified (the person is in the conversation);
 *   - morning   the morning check-in, once a day at the person's time (default 07:30, in the calendar's zone), only
 *               when Today has something to say and the check-in was not already dismissed.
 *
 * Rules:
 *   - at most one notification per thing (push_sent), and several new things of a kind in one tick are ONE
 *     notification for the kind; each kind has its own tag (and push Topic), so the phone shows the latest per kind
 *     instead of a pile;
 *   - what was already there when notifications were first turned on is not announced (`baseline`);
 *   - quiet hours (the legacy setting, MWA_QUIET_HOURS or notify.quietHours, the same one Telegram respects) hold
 *     notifications; when the window ends, what still needs the person is sent, the rest is let go;
 *   - at most MWA_PUSH_PER_HOUR (6) an hour; more waits for the next hour;
 *   - receipts (receipts.ts) on the `push` channel: `accepted` means the push service took it — not that the phone
 *     showed it; `held`, `failed`, `dropped` (the subscription was gone) and `not-sent` say what happened otherwise.
 *
 * Payloads carry NO personal content: `{kind, id, tag}` and nothing else — no job title, no sender, no event, no
 * mail. The words on the phone are fixed per kind (the service worker's, web/src/pwa/sw-logic.ts), and the app
 * fetches the details after it opens.
 */
import { listJobs, viewJobs, ownerOwns, type JobView, type TryRow } from './jobs.js';
import { listPendingActions, type PendingView } from '../tools/approval.js';
import { itemId, phishingSource } from './important.js';
import { appDb } from './db.js';
import { buildToday, todayNow, todayTz, localMinutes, dayBounds } from './today.js';
import { inQuietWindow, quietWindow } from '../quiet.js';
import { recordReceipt, type ReceiptStatus } from '../receipts.js';
import { logger } from '../logger.js';
import { sendPush, pushSubject, vendorWords, vapidKeys, vapidReset, type SendOutcome, type Transport, type Vendor } from './webpush.js';
import {
  listSubscriptions, ownerLive, deleteSubscription, removeSubscriptionsOf, noteSendResult, sentState, markSent, logPush, sentLastHour,
  readPrefs, prunePushRecords, queueRetry, dueRetries, dropRetry, getSubscription, type PushKind, type SubRow, type RetryRow,
} from './push-store.js';

export type PayloadKind = PushKind | 'test';
/** The whole payload. Nothing else is ever sent (tests/push-server.test.ts holds it to that). */
export interface PushPayload { kind: PayloadKind; id: string | null; tag: string }
export const tagOf = (k: PayloadKind) => `mwa-${k}`;

export interface PushDeps {
  now: () => number;
  tz: () => string;
  /** live keys of the runs going now (job status) */
  running: () => Set<string>;
  pendingApprovals: () => PendingView[];
  /** inside quiet hours at this moment */
  quiet: (at: number) => boolean;
  /** Today has something to say this morning (and the check-in was not dismissed) */
  morningNews: (now: number) => Promise<boolean>;
  /** the HTTP request to the push service (tests: a fake; under vitest with none, nothing leaves the process) */
  transport?: Transport;
  perHour: () => number;
}
async function defaultMorningNews(now: number): Promise<boolean> {
  const t = await buildToday('push', { now });
  if (!t.checkin) return false; // outside 05:00–12:00, or the person already said "Done — show my day"
  return t.needsYou.length + t.nextUp.length + t.worthALook.length + t.doneForYou.length > 0;
}
const noNetwork: Transport = async () => { throw new Error('no network in tests'); };
const DEFAULT_DEPS: PushDeps = {
  now: () => todayNow(), tz: () => todayTz(), running: () => new Set(),
  pendingApprovals: () => { try { return listPendingActions(); } catch { return []; } },
  // the person's zone: the same clock as the morning check-in (P3 review: not the server's, which is UTC on Railway)
  quiet: (at) => inQuietWindow(quietWindow(), new Date(at), deps.tz()),
  morningNews: defaultMorningNews,
  perHour: () => { const n = Number(process.env.MWA_PUSH_PER_HOUR); return Number.isFinite(n) && n >= 1 && n <= 60 ? Math.floor(n) : 6; },
};
let deps: PushDeps = DEFAULT_DEPS;
export function setPushDeps(d: Partial<PushDeps> | null): void { deps = d ? { ...DEFAULT_DEPS, ...d } : DEFAULT_DEPS; }
const transport = (): Transport | undefined => deps.transport ?? (process.env.VITEST ? noNetwork : undefined);

// ── what could notify ───────────────────────────────────────────────────────────────────────────────────────────

/** One thing that could notify. `receipt` is where its push receipt goes: the same job and fire keys the scheduler
 *  and Telegram record a result under (P3 review), so a job's delivery line can say "sent to your phone". */
export interface Candidate { kind: PushKind; key: string; id: string | null; since: number; receipt: { job: string; fire: string } }

function phishingApproval(id: string): boolean {
  try { return (appDb().prepare('SELECT caution FROM items WHERE id = ?').get(itemId(`approval:${id}`)) as { caution: string | null } | undefined)?.caution === 'phishing'; }
  catch { return false; }
}
/** The newest result that reached the person (the same rule as status.ts resultReady). */
function deliveredTry(tries: TryRow[]): TryRow | undefined {
  return [...tries].sort((a, b) => b.n - a.n).find((t) => t.state === 'ended' && t.delivered !== 0 && t.ended_by == null && t.reason !== 'stopped');
}
const lastEnded = (tries: TryRow[]) => [...tries].sort((a, b) => b.n - a.n).find((t) => t.state === 'ended');
/** The receipt keys of a Try: its schedule (the scheduler's `job`) and its fire id, else the v2 ids. */
const tryReceipt = (v: JobView, t: TryRow | undefined, key: string) => ({ job: t?.schedule_id ?? v.job.schedule_id ?? v.job.id, fire: t?.fire_id ?? key });

/** Approvals, waiting jobs and ready results right now (not the morning: that is a time, see tick). `complete` is
 *  false when a source could not be read (then nothing is pruned on its evidence). */
export function candidatesNow(now = deps.now()): { list: Candidate[]; complete: boolean } {
  const out: Candidate[] = [];
  let complete = true;
  let approvals: PendingView[] = [];
  try { approvals = deps.pendingApprovals(); } catch { approvals = []; complete = false; }
  for (const a of approvals) {
    // never a phishing-flagged approval: by its Important item's caution, or by the mail or item that tainted it
    if (!ownerOwns(a.personId) || phishingApproval(a.id) || phishingSource(a.taintSources)) continue;
    const key = `approval:${a.id}`;
    out.push({ kind: 'approval', key, id: a.id, since: a.createdAt, receipt: { job: 'approval', fire: key } });
  }
  let views: JobView[] = [];
  try { views = viewJobs(listJobs({}).filter((j) => ownerOwns(j.person)), { running: deps.running(), pending: new Set(approvals.map((a) => a.id)), now }); }
  catch { views = []; complete = false; }
  for (const v of views) {
    if (v.status.state === 'waiting' && v.status.primaryAction?.action !== 'review') {
      const t = lastEnded(v.tries);
      const key = `waiting:${v.job.id}:${t?.id ?? '-'}`;
      out.push({ kind: 'waiting', key, id: v.job.id, since: t?.ended_at ?? now, receipt: tryReceipt(v, t, key) });
    }
    if (v.status.resultReady && v.job.kind !== 'live') {
      const t = deliveredTry(v.tries);
      if (t) { const key = `result:${v.job.id}:${t.id}`; out.push({ kind: 'result', key, id: v.job.id, since: t.ended_at ?? now, receipt: tryReceipt(v, t, key) }); }
    }
  }
  return { list: out, complete };
}
export const candidates = (now = deps.now()): Candidate[] => candidatesNow(now).list;

// ── sending ─────────────────────────────────────────────────────────────────────────────────────────────────────

const TTL: Record<PayloadKind, number> = { approval: 24 * 3600, waiting: 12 * 3600, result: 12 * 3600, morning: 4 * 3600, test: 600 };
const URGENCY: Record<PayloadKind, 'high' | 'normal'> = { approval: 'high', waiting: 'high', result: 'normal', morning: 'normal', test: 'high' };
/** a subscription the push service refuses this many times in a row (not "try later") is removed */
const MAX_FAILS = 5;
/** P3 review: a subscription whose push service has answered nothing but failures (busy, down, refusing) for this
 *  long is removed; the phone shows "Off on this device" and can turn notifications on again. */
export const FAILING_REMOVE_MS = 3 * 86_400_000;

export interface Delivery { accepted: number; gone: number; failed: number; retry: number; per: { id: string; vendor: string; outcome: SendOutcome['outcome']; status: number; detail?: string }[] }

/**
 * Subscriptions that may receive: their owner still live, made with this server's current VAPID key (P3 review: one
 * made with a key that was replaced can never be delivered), and not failing for days. The others are removed here.
 */
export function liveSubscriptions(now = deps.now()): SubRow[] {
  const all = listSubscriptions();
  const dead = new Set(all.filter((s) => !ownerLive(s.owner, Date.now())).map((s) => s.owner));
  for (const o of dead) removeSubscriptionsOf(o);
  let key: string | null = null;
  try { key = vapidKeys().publicKey; } catch { key = null; }
  const r = vapidReset();
  const out: SubRow[] = [];
  for (const s of all) {
    if (dead.has(s.owner)) continue;
    const staleKey = (key && s.vapid && s.vapid !== key) || (r && !s.vapid && s.created_at < r.at);
    const failing = s.failing_since != null && Date.now() - s.failing_since > FAILING_REMOVE_MS;
    if (staleKey || failing) { deleteSubscription(s.id); continue; }
    if (s.expires_at == null || s.expires_at > now) out.push(s);
  }
  return out;
}

export function payloadFor(kind: PayloadKind, id: string | null): PushPayload {
  // an id is ours (a job, an approval): kept only if it looks like one
  const safe = id && /^[A-Za-z0-9_.:-]{1,100}$/.test(id) ? id : null;
  return { kind, id: safe, tag: tagOf(kind) };
}

/** Send one payload to these subscriptions. Gone ones are removed; repeated refusals remove one too. Each
 *  subscription's own outcome is in `per` (a "try later" is queued per device by the caller). */
export async function deliver(subs: SubRow[], payload: PushPayload): Promise<Delivery> {
  const out: Delivery = { accepted: 0, gone: 0, failed: 0, retry: 0, per: [] };
  const subject = pushSubject();
  await Promise.all(subs.map(async (s) => {
    const r = await sendPush({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, payload,
      { ttlSec: TTL[payload.kind], urgency: URGENCY[payload.kind], topic: payload.kind, subject }, transport());
    out[r.outcome]++;
    out.per.push({ id: s.id, vendor: s.vendor, outcome: r.outcome, status: r.status, ...(r.detail ? { detail: r.detail } : {}) });
    if (r.outcome === 'accepted') noteSendResult(s.id, { ok: true, status: r.status });
    else if (r.outcome === 'gone') deleteSubscription(s.id);
    else {
      noteSendResult(s.id, { ok: false, status: r.status, error: r.detail ?? `status ${r.status}` });
      if (r.outcome === 'failed' && s.fails + 1 >= MAX_FAILS) deleteSubscription(s.id);
    }
  }));
  return out;
}

function receiptFor(c: { key: string; receipt: { job: string; fire: string } }, status: ReceiptStatus, detail: string): void {
  recordReceipt({ job: c.receipt.job, fire: c.receipt.fire, channel: 'push', status, detail });
}
const vendorList = (vs: string[]) => [...new Set(vs.map((v) => vendorWords(v as Vendor)))].join(' and ') || 'the push service';
function vendorsOf(d: Delivery): string { return vendorList(d.per.filter((p) => p.outcome === 'accepted').map((p) => p.vendor)); }
const deviceWord = (n: number) => `${n} device${n === 1 ? '' : 's'}`;

// ── the tick ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TickReport {
  sent: { kind: PushKind; keys: string[]; delivery: Delivery }[]; held: string[]; baseline: string[]; skipped: string[];
  retried: { sub: string; keys: string[]; outcome: SendOutcome['outcome'] }[]; note?: string;
}
const PRIORITY: PushKind[] = ['approval', 'waiting', 'result', 'morning'];
const hhmmToMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const PRUNE_EVERY_MS = 86_400_000;
let lastPrune = 0;
export function resetPushPrune(): void { lastPrune = 0; }

/**
 * The per-device retries that are due (P3 review): a device whose push service said "try later" gets the item later
 * instead of losing it — 30 s, then doubling, at most an hour apart — while the item still stands. One payload per
 * device per kind. A device failing for FAILING_REMOVE_MS is removed (liveSubscriptions).
 */
async function runRetries(now: number, liveKeys: ReadonlySet<string>, rep: TickReport): Promise<void> {
  const due = dueRetries(now);
  if (!due.length) return;
  const bySub = new Map<string, RetryRow[]>();
  for (const r of due) {
    if (!liveKeys.has(r.key)) { dropRetry(r.sub_id, r.key); continue; } // answered, opened, the morning passed
    bySub.set(r.sub_id, [...(bySub.get(r.sub_id) ?? []), r]);
  }
  const subs = new Map(liveSubscriptions(now).map((s) => [s.id, s]));
  for (const [subId, rows] of bySub) {
    const sub = subs.get(subId) ?? null;
    if (!sub) { for (const r of rows) dropRetry(subId, r.key); continue; }
    for (const kind of PRIORITY) {
      const group = rows.filter((r) => r.kind === kind);
      if (!group.length) continue;
      const d = await deliver([sub], payloadFor(kind, group.length === 1 ? group[0].item_id : null));
      const outcome = d.per[0]?.outcome ?? 'retry';
      rep.retried.push({ sub: subId, keys: group.map((r) => r.key), outcome });
      for (const r of group) {
        const c = { key: r.key, receipt: { job: r.receipt_job ?? r.key.split(':')[0], fire: r.receipt_fire ?? r.key } };
        if (outcome === 'retry' && getSubscription(subId)) { queueRetry({ subId, key: r.key, kind: r.kind, itemId: r.item_id, receiptJob: c.receipt.job, receiptFire: c.receipt.fire }, now); continue; }
        dropRetry(subId, r.key);
        if (outcome === 'accepted') receiptFor(c, 'accepted', `accepted by ${vendorList([sub.vendor])} on a later try (${r.tries + 1})`);
        else if (outcome === 'gone') receiptFor(c, 'dropped', 'the phone’s subscription no longer exists');
        else if (outcome === 'failed') receiptFor(c, 'failed', `${d.per[0]?.status ?? 0} ${d.per[0]?.detail ?? ''}`.trim().slice(0, 180));
      }
    }
  }
}

let ticking = false;
export async function pushTick(): Promise<TickReport> {
  const rep: TickReport = { sent: [], held: [], baseline: [], skipped: [], retried: [] };
  if (ticking) return { ...rep, note: 'busy' };
  ticking = true;
  try {
    const now = deps.now();
    const subs = liveSubscriptions(now);
    if (!subs.length) return { ...rep, note: 'no subscriptions' };
    const enabledAt = Math.min(...subs.map((s) => s.created_at));
    const prefs = readPrefs();
    const all = candidatesNow(now);
    const cands = all.list.filter((c) => prefs.kinds[c.kind]);
    // the morning check-in: once a day, from the person's time until noon
    const tz = deps.tz();
    const mins = localMinutes(now, tz), at = hhmmToMin(prefs.morning);
    const liveKeys = new Set(all.list.map((c) => c.key));
    if (prefs.kinds.morning && mins >= at && mins < 12 * 60) {
      const day = dayBounds(now, tz).day, key = `morning:${day}`, st = sentState(key);
      liveKeys.add(key); // a morning retry stands until noon
      const since = now - (mins - at) * 60_000;
      // turned on after this morning's time: today's check-in is not announced (and Today is not built every tick)
      if (st === null && since < enabledAt) { markSent(key, 'morning', 'baseline', now); rep.baseline.push(key); }
      else if (st === null || st === 'held') {
        let news = false;
        try { news = await deps.morningNews(now); } catch { news = false; }
        if (news) cands.push({ kind: 'morning', key, id: null, since, receipt: { job: 'morning', fire: key } });
        else { markSent(key, 'morning', 'skipped', now); rep.skipped.push(key); }
      }
    }
    // P3 review: "sent" records stay while their item still stands (pruned daily, only on complete evidence)
    if (now - lastPrune > PRUNE_EVERY_MS) { lastPrune = now; try { prunePushRecords(now, all.complete ? liveKeys : undefined); } catch { /* next day */ } }

    // what is new: never recorded, or held earlier (quiet hours, the hourly limit)
    const fresh: Candidate[] = [];
    for (const c of cands) {
      const st = sentState(c.key);
      if (st === 'sent' || st === 'baseline' || st === 'skipped') continue;
      if (st === null && c.since < enabledAt) { markSent(c.key, c.kind, 'baseline', now); rep.baseline.push(c.key); continue; }
      fresh.push(c);
    }
    // held earlier, no longer needing the person (answered, opened, the morning passed): let go, and say so
    const live = new Set(cands.map((c) => c.key));
    for (const h of appDb().prepare(`SELECT key, kind FROM push_sent WHERE state = 'held'`).all() as { key: string; kind: string }[]) {
      if (live.has(h.key)) continue;
      markSent(h.key, h.kind, 'skipped', now); rep.skipped.push(h.key);
      receiptFor({ key: h.key, receipt: { job: h.key.split(':')[0], fire: h.key } }, 'not-sent', 'it no longer needed you by the time it could be sent');
    }

    const quiet = deps.quiet(now);
    if (!quiet) await runRetries(now, liveKeys, rep);
    if (!fresh.length) return rep;

    const hold = (c: Candidate, why: string) => {
      if (sentState(c.key) !== 'held') receiptFor(c, 'held', why);
      markSent(c.key, c.kind, 'held', now); rep.held.push(c.key);
    };
    if (quiet) { for (const c of fresh) hold(c, 'quiet hours'); return rep; }

    let room = deps.perHour() - sentLastHour(now);
    for (const kind of PRIORITY) {
      const group = fresh.filter((c) => c.kind === kind);
      if (!group.length) continue;
      if (room <= 0) { for (const c of group) hold(c, 'the hourly limit for notifications'); continue; }
      const d = await deliver(liveSubscriptions(now), payloadFor(kind, group.length === 1 ? group[0].id : null));
      rep.sent.push({ kind, keys: group.map((c) => c.key), delivery: d });
      room--;
      logPush(kind, false, now);
      // a device whose service said "try later" gets each of these later (per device, with backoff)
      const later = d.per.filter((p) => p.outcome === 'retry' && getSubscription(p.id));
      for (const p of later) for (const c of group) queueRetry({ subId: p.id, key: c.key, kind: c.kind, itemId: c.id, receiptJob: c.receipt.job, receiptFire: c.receipt.fire }, now);
      const total = d.per.length;
      for (const c of group) {
        markSent(c.key, c.kind, 'sent', now);
        if (d.accepted) receiptFor(c, 'accepted', `accepted by ${vendorsOf(d)} for ${d.accepted} of ${deviceWord(total)}${later.length ? `; ${deviceWord(later.length)} to try again` : ''}`);
        else if (later.length) receiptFor(c, 'held', `the push service said to try later; trying again for ${deviceWord(later.length)}`);
        else if (d.gone === total) receiptFor(c, 'dropped', 'the phone’s subscription no longer exists');
        else receiptFor(c, 'failed', d.per.map((p) => `${p.status}${p.detail ? ` ${p.detail}` : ''}`).join('; ').slice(0, 180));
      }
    }
    return rep;
  } finally {
    ticking = false;
  }
}

// ── test ────────────────────────────────────────────────────────────────────────────────────────────────────────

const tests = new Map<string, number[]>();
export const TEST_LIMIT = 5, TEST_WINDOW_MS = 10 * 60_000;
/** "Send a test" to these subscriptions: now, quiet hours or not (the person asked), at most 5 per 10 minutes each. */
export async function sendTest(caller: string, subs: SubRow[], now = Date.now()): Promise<{ limited: true } | { limited: false; delivery: Delivery }> {
  const recent = (tests.get(caller) ?? []).filter((t) => now - t < TEST_WINDOW_MS);
  if (recent.length >= TEST_LIMIT) return { limited: true };
  recent.push(now); tests.set(caller, recent);
  const d = await deliver(subs, payloadFor('test', null));
  logPush('test', true, now);
  const status: ReceiptStatus = d.accepted ? 'accepted' : d.gone === d.per.length ? 'dropped' : 'failed';
  recordReceipt({ job: 'push-test', fire: `test:${now}`, channel: 'push', status, detail: `accepted by ${vendorsOf(d)} for ${d.accepted} of ${deviceWord(d.per.length)}` });
  return { limited: false, delivery: d };
}
export function resetPushTests(): void { tests.clear(); }

// ── serve ───────────────────────────────────────────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
/** serve: tick every 30 s (MWA_PUSH_TICK_MS, at least 1 s); records are pruned daily inside the tick. */
export function startPushNotifier(d: Partial<PushDeps> = {}): void {
  setPushDeps(d);
  if (timer) clearInterval(timer);
  const every = Math.max(1000, Number(process.env.MWA_PUSH_TICK_MS) || 30_000);
  timer = setInterval(() => {
    void pushTick().then((r) => {
      for (const s of r.sent) logger.info('push', `notified: ${s.kind} ×${s.keys.length} (${s.delivery.accepted} accepted, ${s.delivery.gone} gone, ${s.delivery.failed} failed, ${s.delivery.retry} to retry)`);
    }).catch((e) => logger.error('push', 'notification tick failed', { error: (e as Error).message.slice(0, 200) }));
  }, every);
  timer.unref?.();
}
export function stopPushNotifier(): void { if (timer) clearInterval(timer); timer = null; }
