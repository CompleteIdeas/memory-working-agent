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
 *   draftInput        the "New event" form → POST /calendar/drafts (local time, no offset; a bare date = all day).
 *   draftIcs          the draft as an iCalendar file, made on the device (fixture mode has no file server).
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

  /** A queued tap leaves when its action has left the outbox (sent, or dropped with a notice): the store holds the truth. */
  reconcile(outbox: OutboxEntry[]): void {
    const waiting = new Set(outbox.filter((e) => e.kind === 'draft.confirm' || e.kind === 'draft.remove').map((e) => e.args.id));
    const stale = Object.entries(this.s.ops).filter(([id, op]) => op.queued && !waiting.has(id));
    if (!stale.length) return;
    const ops = { ...this.s.ops };
    for (const [id] of stale) delete ops[id];
    this.set({ ops });
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
/** The form → the request body, or what is wrong in plain words. Times are local (no offset), as the spec allows. */
export function draftInput(f: DraftForm): { ok: true; body: DraftInput } | { ok: false; error: string; field: keyof DraftForm } {
  const title = f.title.trim();
  if (!title) return { ok: false, error: 'Give it a name.', field: 'title' };
  if (title.length > 300) return { ok: false, error: 'That name is too long (300 characters at most).', field: 'title' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return { ok: false, error: 'Pick a day.', field: 'date' };
  const location = f.location.trim().slice(0, 300);
  if (f.allDay) return { ok: true, body: { title, start: f.date, allDay: true, ...(location ? { location } : {}) } };
  if (!/^\d{2}:\d{2}$/.test(f.start)) return { ok: false, error: 'Pick a start time.', field: 'start' };
  const body: DraftInput = { title, start: `${f.date}T${f.start}`, ...(location ? { location } : {}) };
  if (f.end) {
    if (!/^\d{2}:\d{2}$/.test(f.end)) return { ok: false, error: 'That end time isn’t a time.', field: 'end' };
    if (f.end <= f.start) return { ok: false, error: 'The end is before the start.', field: 'end' };
    body.end = `${f.date}T${f.end}`;
  }
  return { ok: true, body };
}

// ---------- a calendar file made on the device ----------

const icsTime = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** Fold at 75 octets (RFC 5545 §3.1), CRLF line ends. */
function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}
/** A VCALENDAR with one VEVENT, as the server makes it (UTC times, CRLF, folded). */
export function draftIcs(i: Pick<CalendarItem, 'id' | 'title' | 'start' | 'end' | 'allDay' | 'location'>, now = Date.now()): string {
  const [s, e] = itemSpan(i);
  const when = i.allDay
    ? [`DTSTART;VALUE=DATE:${i.start.slice(0, 10).replace(/-/g, '')}`, `DTEND;VALUE=DATE:${i.end.slice(0, 10).replace(/-/g, '')}`]
    : [`DTSTART:${icsTime(s)}`, `DTEND:${icsTime(e)}`];
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MWA//Calendar draft//EN', 'BEGIN:VEVENT', `UID:${i.id}@mwa`, `DTSTAMP:${icsTime(now)}`, ...when,
    `SUMMARY:${icsText(i.title)}`, ...(i.location ? [`LOCATION:${icsText(i.location)}`] : []), 'END:VEVENT', 'END:VCALENDAR'];
  return lines.map(fold).join('\r\n') + '\r\n';
}
/** "book-fair.ics" */
export const icsName = (title: string) => `${title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'event'}.ics`;

// ---------- going to a day from elsewhere (Today's cards and lines) ----------

let requested: { day: string; highlight: string | null } | null = null;
/** Ask the Calendar screen to open on a day (YYYY-MM-DD), optionally highlighting an item; it reads this once. */
export function openCalendarOn(day: string, highlight: string | null = null): void { requested = { day, highlight }; }
export function takeCalendarRequest(): { day: string; highlight: string | null } | null { const r = requested; requested = null; return r; }

export { DAY };
