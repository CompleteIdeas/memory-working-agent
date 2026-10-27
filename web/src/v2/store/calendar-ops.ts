/**
 * The Calendar screen's logic (v2 build, slice W2), plain TypeScript so it is unit-tested (tests/web-v2-calendar.test.ts):
 *
 *   PendingDrafts     Confirm / Remove shown at once (optimistic): a removed draft leaves the list, a confirmed one
 *                     says "Adding to your calendar…". If the server refuses, it goes back to what it was and the
 *                     reason is shown; offline, it waits in the outbox and says so until it is sent.
 *   displayItems      the items with those pending taps laid over them.
 *   conflict helpers  which double-bookings touch a day, an item's "overlaps with …", the card's words.
 *   calendarHonesty   from the accounts: not connected / needs reconnecting / never synced / one calendar missing
 *                     (named) / stale — an unknown day is never called free.
 *   draftInput        the "New event" form → POST /calendar/drafts: times with this device's offset AND its zone
 *                     (`tz`), so the server reads them as entered wherever the person's own zone is; an end before
 *                     the start is the next day (overnight); a bare date = all day.
 *   draftIcs          the draft as an iCalendar file, made on the device (fixture mode has no file server) by the
 *                     server's own rules (src/sync/ics.ts, ported: escaping, folding, the all-day end).
 *   week math         Monday-first weeks, day keys, labels.
 */
import type { CalendarAccounts, CalendarItem, Schemas } from '../api/client';
import type { ActResult, DraftInput, OutboxEntry } from './core';

export type CalendarConflict = Schemas['CalendarConflict'];
export type CalendarAccount = CalendarAccounts['accounts'][number];
const DAY = 86_400_000;

// ---------- optimistic Confirm / Remove ----------

export interface PendingOp { kind: 'confirm' | 'remove'; queued: boolean }
export interface Receipt { id: string; text: string; at: number }
export interface PendingState { ops: Record<string, PendingOp>; receipt: Receipt | null }
export interface Actor { act(kind: 'draft.confirm' | 'draft.remove', args: { id: string }, label: string): Promise<ActResult> }

export class PendingDrafts {
  private s: PendingState = { ops: {}, receipt: null };
  private ls = new Set<() => void>();
  getState = (): PendingState => this.s;
  subscribe = (fn: () => void): (() => void) => { this.ls.add(fn); return () => { this.ls.delete(fn); }; };
  private set(p: Partial<PendingState>) { this.s = { ...this.s, ...p }; for (const l of [...this.ls]) l(); }
  private op(id: string, v: PendingOp | null) {
    const ops = { ...this.s.ops };
    if (v) ops[id] = v; else delete ops[id];
    this.set({ ops });
  }

  /** Confirm or Remove a draft: shown at once; the store's answer (or the outbox) decides what stays. */
  async run(actor: Actor, kind: 'confirm' | 'remove', item: Pick<CalendarItem, 'id' | 'title'>, now = Date.now()): Promise<ActResult> {
    if (this.s.ops[item.id]) return { ok: false, queued: false, message: 'Already on its way.' };
    this.op(item.id, { kind, queued: false });
    const r = await actor.act(kind === 'confirm' ? 'draft.confirm' : 'draft.remove', { id: item.id }, `${kind === 'confirm' ? 'Confirm' : 'Remove'} “${item.title}”`);
    if (r.ok) {
      // the store now holds the server's answer: nothing to lay over it any more
      this.op(item.id, null);
      const text = r.message ?? (kind === 'confirm' ? 'Added by your helper just now. No invites were sent.' : 'Removed. Nothing was added to your calendar.');
      this.set({ receipt: { id: item.id, text, at: now } });
    } else if (r.queued) {
      this.op(item.id, { kind, queued: true });
    } else {
      this.op(item.id, null); // refused: back as it was (the store showed the server's words)
    }
    return r;
  }

  /**
   * The taps waiting in the outbox ARE the queued ones: one there without a tap shown (after a reload) is shown as
   * waiting (W2 review M3); a queued tap whose action has left the outbox (sent, or dropped with a notice) goes — the
   * store holds the truth. A tap on its way (not queued) is left alone.
   */
  reconcile(outbox: OutboxEntry[]): void {
    const waiting = new Map<string, PendingOp['kind']>();
    for (const e of outbox) if ((e.kind === 'draft.confirm' || e.kind === 'draft.remove') && e.args.id) waiting.set(e.args.id, e.kind === 'draft.confirm' ? 'confirm' : 'remove');
    const ops = { ...this.s.ops };
    let changed = false;
    for (const [id, op] of Object.entries(ops)) if (op.queued && !waiting.has(id)) { delete ops[id]; changed = true; }
    for (const [id, kind] of waiting) if (!ops[id]) { ops[id] = { kind, queued: true }; changed = true; }
    if (changed) this.set({ ops });
  }

  clearReceipt(): void { if (this.s.receipt) this.set({ receipt: null }); }
}

export type DisplayItem = CalendarItem & { pending?: PendingOp };
/** The items as the screen shows them: a draft being removed is gone; one being confirmed carries its pending tap. */
export function displayItems(items: CalendarItem[], ops: Record<string, PendingOp>): DisplayItem[] {
  const out: DisplayItem[] = [];
  const events = new Set(items.filter((i) => i.kind === 'event').map((i) => `${i.title}|${i.start}`));
  for (const i of items) {
    // a confirmed draft is on the calendar: shown once — as its event when the calendar has it, else as one
    if (i.kind === 'draft' && i.state === 'confirmed') {
      if (!events.has(`${i.title}|${i.start}`)) out.push({ ...i, kind: 'event', addedByHelper: true });
      continue;
    }
    if (i.kind === 'draft' && i.state === 'removed') continue;
    const p = ops[i.id];
    if (!p || i.kind !== 'draft') { out.push(i); continue; }
    if (p.kind === 'remove') continue;
    out.push({ ...i, pending: p });
  }
  return out;
}

// ---------- days and weeks ----------

/** Midnight (local) of the day holding ms. */
export const startOfDay = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
/** Add whole local days (a clock change keeps midnight at midnight). */
export const addDays = (dayMs: number, n: number) => { const d = new Date(dayMs); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); };
/** Monday of the week holding ms (local midnight). */
export const weekStart = (ms: number) => { const d = startOfDay(ms); const wd = (new Date(d).getDay() + 6) % 7; return addDays(d, -wd); };
export const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const fromDayKey = (k: string) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

/** An item's span in instants; an all-day item's dates are local dates, end exclusive. */
export function itemSpan(i: Pick<CalendarItem, 'allDay' | 'start' | 'end'>): [number, number] {
  if (i.allDay) return [fromDayKey(i.start.slice(0, 10)), fromDayKey(i.end.slice(0, 10))];
  return [Date.parse(i.start), Date.parse(i.end)];
}
export function itemsOnDay<T extends Pick<CalendarItem, 'allDay' | 'start' | 'end'>>(items: T[], day: number): T[] {
  const b = addDays(day, 1);
  return items.filter((i) => { const [s, e] = itemSpan(i); return s < b && (e > day || (s === e && s >= day)); });
}

const short = (ms: number) => { const d = new Date(ms); const h = d.getHours() % 12 || 12, m = d.getMinutes(); return `${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`; };
const ap = (ms: number) => (new Date(ms).getHours() >= 12 ? 'pm' : 'am');
/** "8:15–8:45am", "12:30–1:30pm", "11am–2pm" (the prototype's way of saying a span). */
export const spanLabel = (a: number, b: number) => `${short(a)}${ap(a) !== ap(b) ? ap(a) : ''}–${short(b)}${ap(b)}`;
export const clockLabel = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
export const dayName = (ms: number) => new Date(ms).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
/** "November 9–15", "November 30–December 6" */
export function weekLabel(monday: number): string {
  const sun = addDays(monday, 6), a = new Date(monday), b = new Date(sun);
  const m = (d: Date) => d.toLocaleDateString('en-US', { month: 'long' });
  return a.getMonth() === b.getMonth() ? `${m(a)} ${a.getDate()}–${b.getDate()}` : `${m(a)} ${a.getDate()}–${m(b)} ${b.getDate()}`;
}

// ---------- double-bookings ----------

/** The double-bookings that start on a day (local). */
export function conflictsOnDay(conflicts: CalendarConflict[], day: number): CalendarConflict[] {
  const b = addDays(day, 1);
  return conflicts.filter((c) => { const s = Date.parse(c.start); return s >= day && s < b; });
}
/** For one item: the titles it overlaps with (in the conflicts given). */
export function overlapsOf(id: string, conflicts: CalendarConflict[]): string[] {
  const out: string[] = [];
  for (const c of conflicts) {
    const k = c.between.indexOf(id);
    if (k >= 0) out.push(c.titles[1 - k]);
  }
  return out;
}
/** "Thursday at 4 is double-booked" — our own words; the titles go in the text, as text. */
export function conflictTitle(c: CalendarConflict, today: number): string {
  const s = Date.parse(c.start), day = startOfDay(s);
  const when = day === today ? 'Today' : day === addDays(today, 1) ? 'Tomorrow' : new Date(s).toLocaleDateString('en-US', { weekday: 'long' });
  return `${when} at ${clockLabel(s).replace(':00', '')} is double-booked`;
}
/** "Riley’s soccer practice and Farrier at the barn overlap, 4–5pm." */
export function conflictText(c: CalendarConflict): string {
  return `${c.titles[0] || 'An event'} and ${c.titles[1] || 'another event'} overlap, ${spanLabel(Date.parse(c.start), Date.parse(c.end))}.`;
}

// ---------- honest calendar states (from the accounts) ----------

export type Honesty = 'ok' | 'stale' | 'partial' | 'not_synced' | 'reconnect' | 'not_connected' | 'unknown';
export const CAL_STALE_MS = 2 * 3_600_000;
const calName = (a: CalendarAccount) => (a.provider === 'outlook' ? 'Outlook calendar' : 'Google calendar');

/**
 * What the accounts say about the calendar shown (the same rules as the server's Today freshness): nothing
 * connected; one needs signing in again; none ever synced; one synced and another never has (named: "Your Outlook
 * calendar hasn't synced yet…"); the last sync is old. `null` accounts (not loaded yet): unknown, say nothing.
 */
export function calendarHonesty(accounts: CalendarAccount[] | null, now: number): { state: Honesty; note: string | null; canSayFree: boolean; asOf: number | null } {
  if (!accounts) return { state: 'unknown', note: null, canSayFree: false, asOf: null };
  const on = accounts.filter((a) => a.connected);
  const oks = on.map((a) => a.lastOk).filter((x): x is number => x != null);
  const asOf = oks.length ? Math.min(...oks) : null;
  const re = on.filter((a) => a.needsReconnect);
  const never = on.filter((a) => a.lastOk == null && !a.needsReconnect);
  if (!on.length) return { state: 'not_connected', note: 'No calendar is connected yet, so I can’t show your days.', canSayFree: false, asOf };
  if (re.length) return { state: 'reconnect', note: `${re[0].label} needs to be reconnected, so what you see may be out of date.`, canSayFree: false, asOf };
  if (asOf === null) return { state: 'not_synced', note: 'Your calendar hasn’t synced yet, so I can’t tell what’s on. That doesn’t mean your days are free.', canSayFree: false, asOf };
  if (never.length) return { state: 'partial', note: `Your ${never.map(calName).join(' and ')} hasn’t synced yet, so your days may be missing things.`, canSayFree: false, asOf };
  if (now - asOf > CAL_STALE_MS) return { state: 'stale', note: `Last updated ${new Date(asOf).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`, canSayFree: true, asOf };
  return { state: 'ok', note: null, canSayFree: true, asOf };
}

// ---------- a new draft from the person's input ----------

export interface DraftForm { title: string; date: string; allDay: boolean; start: string; end: string; location: string }
/** This device's zone ("Europe/London"), or none. */
export const deviceTz = (): string | undefined => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; } };
/** A wall time on this device as ISO 8601 with its offset: "2026-11-14T15:00:00-05:00". */
export function withOffset(date: string, hhmm: string, plusDays = 0): string {
  const [y, m, d] = date.split('-').map(Number), [hh, mm] = hhmm.split(':').map(Number);
  const t = new Date(y, m - 1, d + plusDays, hh, mm);
  const off = -t.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', a = Math.abs(off);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}:00${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}
/**
 * The form → the request body, or what is wrong in plain words. Times go with this device's offset and its zone, as
 * shown on this device (W2 review M4: a phone abroad means the time it shows). An end at or before the start is the
 * next morning (an overnight event); an end equal to the start is refused.
 */
export function draftInput(f: DraftForm, tz: string | undefined = deviceTz()): { ok: true; body: DraftInput } | { ok: false; error: string; field: keyof DraftForm } {
  const title = f.title.trim();
  if (!title) return { ok: false, error: 'Give it a name.', field: 'title' };
  if (title.length > 300) return { ok: false, error: 'That name is too long (300 characters at most).', field: 'title' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return { ok: false, error: 'Pick a day.', field: 'date' };
  const location = f.location.trim().slice(0, 300);
  const zone = tz ? { tz } : {};
  if (f.allDay) return { ok: true, body: { title, start: f.date, allDay: true, ...(location ? { location } : {}), ...zone } };
  if (!/^\d{2}:\d{2}$/.test(f.start)) return { ok: false, error: 'Pick a start time.', field: 'start' };
  const body: DraftInput = { title, start: withOffset(f.date, f.start), ...(location ? { location } : {}), ...zone };
  if (f.end) {
    if (!/^\d{2}:\d{2}$/.test(f.end)) return { ok: false, error: 'That end time isn’t a time.', field: 'end' };
    if (f.end === f.start) return { ok: false, error: 'The end is the same as the start.', field: 'end' };
    body.end = withOffset(f.date, f.end, f.end < f.start ? 1 : 0); // before the start: the next day
  }
  return { ok: true, body };
}

// ---------- a calendar file made on the device ----------

const utcStamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
/** TEXT escaping, as the server's icsEscape (src/sync/ics.ts, RFC 5545 3.3.11): backslash, semicolon, comma, newlines
 *  (CRLF, CR or LF) as \n; other control characters dropped (a lone CR can never start a new property). */
export function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000A-\u001F\u007F]/g, '');
}
/** Fold one content line at 75 octets (UTF-8, never inside a character); continuation lines start with a space. */
export function icsFold(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > 75) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}
const nextDate = (d: string) => dayKey(addDays(fromDayKey(d), 1));
/** The draft as the server's buildIcs makes it (same lines, same order), with UID `<id>@mwa`. */
export function draftIcs(i: Pick<CalendarItem, 'id' | 'title' | 'start' | 'end' | 'allDay' | 'location'>, now = Date.now()): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MWA//Calendar draft//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT', `UID:${i.id}@mwa`, `DTSTAMP:${utcStamp(now)}`];
  if (i.allDay) {
    const s = i.start.slice(0, 10), e = i.end && i.end.slice(0, 10) > s ? i.end.slice(0, 10) : nextDate(s);
    lines.push(`DTSTART;VALUE=DATE:${s.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${e.replace(/-/g, '')}`);
  } else {
    lines.push(`DTSTART:${utcStamp(Date.parse(i.start))}`, `DTEND:${utcStamp(Date.parse(i.end))}`);
  }
  lines.push(`SUMMARY:${icsEscape(i.title)}`);
  if (i.location) lines.push(`LOCATION:${icsEscape(i.location)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}
/** "book-fair.ics" */
export function icsName(title: string): string {
  // as the server's icsFileName (src/sync/ics.ts)
  const base = title.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60);
  return `${base || 'event'}.ics`;
}

// ---------- going to a day from elsewhere (Today's cards and lines) ----------

let requested: { day: string; highlight: string | null } | null = null;
/** Ask the Calendar screen to open on a day (YYYY-MM-DD), optionally highlighting an item; it reads this once. */
export function openCalendarOn(day: string, highlight: string | null = null): void { requested = { day, highlight }; }
export function takeCalendarRequest(): { day: string; highlight: string | null } | null { const r = requested; requested = null; return r; }

export { DAY };
