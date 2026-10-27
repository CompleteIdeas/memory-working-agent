/**
 * Quiet hours (BL-07). An always-on agent shouldn't buzz a phone at 3 a.m. Jobs still RUN on time;
 * only PUSHES are held — the Telegram connector's messages and approval cards — and delivered when the
 * window ends. The web app's chat card is written at once: it interrupts nobody.
 *
 * - The window is wall-clock minutes in this machine's time zone (TZ), so daylight-saving changes
 *   need no special case, and a window that wraps midnight ("22:00-07:00") is handled explicitly. At
 *   most 16 hours: a near-24-hour window would hold an approval card until it had almost expired.
 * - Held pushes live in a small JSON-lines file beside the notifications log, so a restart keeps
 *   them. One job's results MERGE into one held item (its latest result and a count), so a 5-minute
 *   monitor doesn't queue a hundred messages overnight; the file holds at most MAX_HELD items.
 * - Delivery is at-least-once: each item leaves the file only after its message was ACCEPTED (the
 *   sender throws on failure), by a read-modify-write that keeps whatever was held meanwhile and any
 *   line it can't parse. A crash or a rate limit can repeat one message, never lose one.
 * - A job marked `urgent` (only from an attended, untainted conversation) skips the window.
 * - A held approval card is still actionable in the morning: one staged by a scheduled run lives 24
 *   hours (BL-03), longer than any window.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig, configPath } from './config.js';
import { recordReceipt } from './receipts.js';
import { notifyPath } from './paths.js';
import { localTz } from './sync/tz.js';

/** Every fire a held item speaks for: its own and those it replaced. */
export function firesOf(i: { fire?: string; replaced?: string[] }): string[] {
  return [...(i.replaced ?? []), ...(i.fire ? [i.fire] : [])];
}

export interface QuietWindow { start: number; end: number; label: string }
const MAX_WINDOW_MIN = 16 * 60;
const MAX_HELD = 300;

/** "22:00-07:00" → minutes of the day. Null for anything else (no quiet hours). */
export function parseQuietHours(s: string | undefined | null): QuietWindow | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(s ?? ''));
  if (!m) return null;
  const [h1, m1, h2, m2] = m.slice(1).map(Number);
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  const start = h1 * 60 + m1, end = h2 * 60 + m2;
  if (start === end) return null;
  const length = (end - start + 1440) % 1440;
  if (length > MAX_WINDOW_MIN) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return { start, end, label: `${pad(h1)}:${pad(m1)}-${pad(h2)}:${pad(m2)}` };
}

/** Minutes since midnight on the wall clock of `tz` (an IANA zone), or of this machine when none is given. */
function wallMinutes(at: Date, tz?: string): number {
  if (!tz) return at.getHours() * 60 + at.getMinutes();
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
    return (p.hour ?? 0) * 60 + (p.minute ?? 0);
  } catch { return at.getHours() * 60 + at.getMinutes(); }
}

/** Is this moment inside the window, on the wall clock of `tz` (P3 review: the PERSON's zone — a server on Railway
 *  runs in UTC, and 22:00 means the person's 22:00)? A window that wraps midnight is the union of its two halves. */
export function inQuietWindow(w: QuietWindow | null, at: Date = new Date(), tz?: string): boolean {
  if (!w) return false;
  const t = wallMinutes(at, tz);
  return w.start < w.end ? t >= w.start && t < w.end : t >= w.start || t < w.end;
}

/** The deployment's setting, trimmed; a blank value counts as unset. */
function envSetting(): string | undefined {
  const v = (process.env.MWA_QUIET_HOURS ?? '').trim();
  return v || undefined;
}

/** The deployment's MWA_QUIET_HOURS is set but isn't a valid window (reported, never silently off). */
export function quietEnvInvalid(): boolean {
  const v = envSetting();
  return v !== undefined && parseQuietHours(v) === null;
}

// Cached for a minute: this is read on every poll and every fire, and loadConfig logs its warnings
// each time it runs (BL-07 review).
let cache: { at: number; key: string; w: QuietWindow | null } | null = null;
let warnedInvalid = false;

/** The configured window: MWA_QUIET_HOURS, else mwa.config.json notify.quietHours. */
export function quietWindow(): QuietWindow | null {
  const env = envSetting();
  const key = `${env ?? ''}|${configPath()}`;
  if (cache && cache.key === key && Date.now() - cache.at < 60_000) return cache.w;
  let w: QuietWindow | null;
  if (env !== undefined) {
    w = parseQuietHours(env);
    if (!w && !warnedInvalid) { warnedInvalid = true; console.error(`[quiet-hours] MWA_QUIET_HOURS="${env}" is not HH:MM-HH:MM (at most 16 hours) — quiet hours are OFF until it is fixed`); }
  } else {
    w = parseQuietHours(loadConfig().notify?.quietHours);
  }
  cache = { at: Date.now(), key, w };
  return w;
}

export function isQuietNow(at: Date = new Date()): boolean {
  return inQuietWindow(quietWindow(), at, localTz());
}

/** The person's time zone (MWA_TZ, else this machine's — the calendar's and the morning check-in's), for saying what
 *  "22:00" means and for keeping it. */
export function timeZoneName(): string {
  try { return localTz(); } catch { return process.env.TZ || 'local time'; }
}

/** Save the window to mwa.config.json ("off" clears it). Refuses to touch a config it can't parse —
 *  rewriting it would wipe the models, access settings and folders (BL-07 review). */
export function setQuietHours(value: string): QuietWindow | null {
  const off = /^\s*(off|none)\s*$/i.test(value);
  const w = off ? null : parseQuietHours(value);
  if (!off && !w) throw new Error('use HH:MM-HH:MM (at most 16 hours), for example 22:00-07:00, or "off"');
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath())) {
    try { raw = JSON.parse(readFileSync(configPath(), 'utf8')); }
    catch { throw new Error(`the settings file ${configPath()} isn't valid JSON — fix it first, or quiet hours would overwrite everything in it`); }
  }
  const notify = { ...((raw.notify as Record<string, unknown>) ?? {}) };
  if (w) notify.quietHours = w.label; else delete notify.quietHours;
  raw.notify = notify;
  const tmp = `${configPath()}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  renameSync(tmp, configPath());
  cache = null;
  return w;
}

// ── the held queue ─────────────────────────────────────────────────────────────────────────────
export interface HeldPush {
  id: string; at: number; chat: string; text: string; files?: string[]; approvals?: string[];
  /** merge key: one job's results become one held item, the latest kept and counted */
  key?: string; count?: number;
  /** this chat's "while it was quiet" header has already gone out */
  announced?: boolean;
  /** failed delivery attempts; an item that keeps failing for an unknown reason is dropped */
  tries?: number;
  /** the scheduled fire this result came from — its delivery receipts (BL-13) — and the earlier
   *  fires of the same job it replaced while held (they share its fate). */
  job?: string;
  fire?: string;
  replaced?: string[];
}

function heldPath(): string {
  return process.env.MWA_HELD ?? join(dirname(notifyPath()), 'held.jsonl');
}

/** Raw lines: parsed items, plus lines that wouldn't parse (kept, never silently dropped). */
function readRaw(): { items: HeldPush[]; bad: string[] } {
  const items: HeldPush[] = []; const bad: string[] = [];
  let text = '';
  try { text = readFileSync(heldPath(), 'utf8'); } catch { return { items, bad }; }
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { const o = JSON.parse(l) as HeldPush; if (o && typeof o.id === 'string' && typeof o.chat === 'string') items.push(o); else bad.push(l); }
    catch { bad.push(l); }
  }
  return { items, bad };
}

function writeRaw(items: HeldPush[], bad: string[]): void {
  const p = heldPath(), tmp = `${p}.tmp`;
  mkdirSync(dirname(p), { recursive: true });
  const lines = [...bad, ...items.map((i) => JSON.stringify(i))];
  writeFileSync(tmp, lines.join('\n') + (lines.length ? '\n' : ''));
  renameSync(tmp, p);
}

/** Keep a push for when the window ends. With a `key` (a job id), a later result REPLACES the held
 *  one and counts it, rather than queueing another message. */
export function holdPush(p: Omit<HeldPush, 'id' | 'at' | 'count' | 'announced'>): string {
  const { items, bad } = readRaw();
  const prev = p.key ? items.find((i) => i.key === p.key && i.chat === p.chat) : undefined;
  if (prev) {
    prev.count = (prev.count ?? 1) + 1;
    prev.text = p.text; prev.files = p.files; prev.at = Date.now();
    // The newest fire now owns the item; the one it replaced keeps a record of what happened (BL-13 review).
    if (prev.fire && p.fire && prev.fire !== p.fire) {
      const all = [...(prev.replaced ?? []), prev.fire];
      // Past 50, the oldest are settled now rather than left held forever.
      for (const f of all.slice(0, Math.max(0, all.length - 50))) recordReceipt({ job: prev.job ?? f, fire: f, channel: 'telegram', status: 'superseded' });
      prev.replaced = all.slice(-50);
    }
    if (p.fire) { prev.fire = p.fire; prev.job = p.job ?? prev.job; }
    prev.approvals = [...new Set([...(prev.approvals ?? []), ...(p.approvals ?? [])])];
    writeRaw(items, bad);
    return prev.id;
  }
  const item: HeldPush = { id: randomBytes(6).toString('hex'), at: Date.now(), ...p };
  if (items.length < MAX_HELD && !bad.length) {
    mkdirSync(dirname(heldPath()), { recursive: true });
    appendFileSync(heldPath(), JSON.stringify(item) + '\n');
  } else {
    // At the cap the OLDEST goes, and the next delivery says so — bounded, never silent.
    const kept = [...items, item].sort((a, b) => a.at - b.at);
    const dropped = kept.length - MAX_HELD;
    const trimmed = dropped > 0 ? kept.slice(dropped) : kept;
    if (dropped > 0) trimmed[0] = { ...trimmed[0], text: `(${dropped} older held message${dropped > 1 ? 's were' : ' was'} dropped to keep the queue small)\n\n${trimmed[0].text}` };
    for (const gone of kept.slice(0, Math.max(0, dropped))) for (const f of firesOf(gone)) recordReceipt({ job: gone.job ?? f, fire: f, channel: 'telegram', status: 'dropped', detail: 'the held queue was full' });
    writeRaw(trimmed, bad);
  }
  return item.id;
}

export function heldPushes(): HeldPush[] {
  return readRaw().items.sort((a, b) => a.at - b.at);
}

/** Remove one delivered item, or update one, by re-reading the file — so a push held while a flush
 *  runs is kept (BL-07 review: rewriting from a stale snapshot lost it). */
function updateHeld(id: string, change: ((i: HeldPush) => HeldPush) | null): void {
  const { items, bad } = readRaw();
  writeRaw(change ? items.map((i) => (i.id === id ? change(i) : i)) : items.filter((i) => i.id !== id), bad);
}

/** What to do when a send fails: `drop` the item (it can never be delivered — a chat that blocked
 *  the bot), `skip` the rest of this chat until the next flush, or `stop` the whole flush (a rate
 *  limit: everything waits `retryAfterMs`). */
export type SendFailure = { action: 'drop' | 'skip' | 'stop'; retryAfterMs?: number };
/** an item that fails this many times for a reason the classifier doesn't know is dropped */
export const MAX_TRIES = 5;

/**
 * Deliver what is held, oldest first, at most `limit` items per call (so a full queue doesn't hold up
 * the person's own messages for minutes). A chat with more than three items gets one "N messages
 * while it was quiet" line first — marked on every item of that chat, so a retry never repeats it.
 * `send` must THROW when a message isn't accepted; `onFail` says what that means (default: skip the
 * chat). One bad chat never blocks the others (BL-07 review). An item is removed only if it is
 * unchanged since it was sent — a result merged into it meanwhile stays for the next flush.
 * Returns how many were sent and, after a rate limit, how long to wait.
 */
export async function flushHeld(
  send: (item: HeldPush) => Promise<void>,
  header?: (chat: string, n: number) => Promise<void>,
  allowed: (chat: string) => boolean = () => true,
  onFail: (err: unknown) => SendFailure = () => ({ action: 'skip' }),
  limit = Infinity,
  log: (line: string) => void = (l) => console.error(l),
  onGiveUp?: (items: HeldPush[], why: string, status: 'dropped' | 'failed') => void,
): Promise<{ sent: number; retryAfterMs?: number }> {
  const items = heldPushes();
  if (!items.length) return { sent: 0 };
  const byChat = new Map<string, HeldPush[]>();
  for (const i of items) byChat.set(i.chat, [...(byChat.get(i.chat) ?? []), i]);
  let sent = 0;
  for (const [chat, list] of byChat) {
    if (!allowed(chat)) { for (const i of list) updateHeld(i.id, null); onGiveUp?.(list, 'that chat is no longer allowed', 'dropped'); continue; }
    // A failure says what it means: `drop` — this chat can never receive (blocked the bot, gone), so
    // all of its items go; `stop` — rate-limited, everything waits; `skip` — this chat waits for the
    // next flush, and the item it failed on counts a try (dropped, logged, after MAX_TRIES).
    let failed: { f: SendFailure; on: HeldPush; err: unknown } | null = null;
    if (header && list.length > 3 && !list.some((i) => i.announced)) {
      try {
        await header(chat, list.length);
        for (const i of list) updateHeld(i.id, (x) => ({ ...x, announced: true }));
      } catch (e) { failed = { f: onFail(e), on: list[0], err: e }; }
    }
    if (!failed) for (const item of list) {
      if (sent >= limit) return { sent };
      try { await send(item); }
      catch (e) { failed = { f: onFail(e), on: item, err: e }; break; }
      // Removed only if nothing was merged into it while it was being sent. If something was, the
      // fires just delivered come off its replaced list — a later send must not re-mark them (BL-13).
      const now = readRaw().items.find((x) => x.id === item.id);
      if (now && now.at === item.at && (now.count ?? 1) === (item.count ?? 1)) updateHeld(item.id, null);
      else if (now) { const done = new Set(firesOf(item)); updateHeld(item.id, (x) => ({ ...x, replaced: (x.replaced ?? []).filter((f) => !done.has(f)) })); }
      sent++;
    }
    if (!failed) continue;
    const why = String((failed.err as Error)?.message ?? failed.err).slice(0, 100);
    if (failed.f.action === 'stop') return { sent, retryAfterMs: failed.f.retryAfterMs };
    if (failed.f.action === 'drop') {
      for (const i of list) updateHeld(i.id, null);
      onGiveUp?.(list, why, 'dropped');
      log(`[quiet-hours] dropped ${list.length} held message(s) for chat ${chat}: ${why}`);
      continue;
    }
    const tries = (failed.on.tries ?? 0) + 1;
    if (tries >= MAX_TRIES) {
      updateHeld(failed.on.id, null);
      onGiveUp?.([failed.on], `gave up after ${tries} tries: ${why}`, 'failed');
      log(`[quiet-hours] dropped a held message for chat ${chat} after ${tries} failed tries: ${why}`);
    } else {
      updateHeld(failed.on.id, (x) => ({ ...x, tries }));
    }
  }
  return { sent };
}
