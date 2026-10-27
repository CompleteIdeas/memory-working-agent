/**
 * Fixture mode for Today and the Calendar's extras (v2 build, slice W2). The FixtureServer (./fixtures.ts) hands
 * GET /today, POST /today/seen, /today/checkin/done, /today/wrap/done, GET /calendar/accounts, POST /calendar/refresh
 * and POST /calendar/drafts to this module first; shapes follow api/openapi.yaml (tests/web-v2-w2-fixtures.test.ts
 * validates them) and the behaviour follows the server (src/v2/today.ts, src/api/routes/today.ts): counts-only
 * check-in, a wrap that quotes a title as “an event called …” (trust untrusted) and says only times aloud, Needs you
 * never made from mail, an unknown day never shown as a free one, "Done for you" after the last look.
 *
 * Scenarios (the prototype's Monday, November 9, 2026; clock per ./fixture-clock.ts):
 *   N00 (and N06, states) 9:10 AM — the check-in already done, the Thursday double-booking, three things done for you
 *   N05         7:30 AM — the morning check-in ("Here's your Monday: …", Done — show my day, Read it to me)
 *   midday      12:30 PM — no check-in, lunch is Now
 *   N09         6:30 PM — the evening wrap ("That's Monday", Good night)
 *   partial     Google synced, Outlook never has: "Your Outlook calendar hasn't synced yet, …"
 *   not-connected  no calendar: Next up says so instead of "Nothing else today"; the Calendar offers to connect
 *   reconnect   Google needs signing in again: a Needs-you card and the note
 * Every scenario holds W3's phishing-flagged message (./fixtures-important.ts): it is in Worth a look, never in Needs you.
 * EVERYTHING HERE IS EXAMPLE DATA.
 */
import type { CalendarAccounts, CalendarItem, Job, Schemas, Today } from '../api/client';
import { statusPill } from '../../../../src/v2/pill';
import { at, dayStart } from './fixture-data';

type Resp = { status: number; body: unknown };
type ImportantItem = Schemas['ImportantItem'];
type Need = Schemas['TodayNeed'];
type Done = Schemas['TodayDone'];
const err = (status: number, code: string, message: string): Resp => ({ status, body: { error: { code, message } } });
const MINUTE = 60_000;
export const TODAY_SCENARIOS = ['N05', 'N09', 'midday', 'partial', 'not-connected', 'reconnect'] as const;
export const FIXTURE_TZ = 'America/New_York';
const GOOGLE = 'google:robert@example.com', OUTLOOK = 'outlook:robert@example.com';

/** What this module needs from the FixtureServer (its private parts, passed in as closures). */
export interface TodayHost {
  clock(): number;
  jobs: Map<string, Job>;
  calendar: Map<string, CalendarItem>;
  putCal(c: CalendarItem): void;
  /** W3's Important list (every item, any state) */
  important(): ImportantItem[];
  /** the stream's data-less "today changed" notice */
  notify(): void;
  later(fn: () => void, ms: number): void;
}

const localDay = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const minutesOf = (ms: number) => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };
const clockLabel = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/ /g, ' ').replace(/:00(?=\s)/, '');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const weekdayOf = (ms: number) => new Date(ms).toLocaleDateString('en-US', { weekday: 'long' });
type Part = Schemas['TodayPart'];
/** As the server (src/v2/today.ts): outside words carry no quote marks; the flat text quotes them (or not, `bare`). */
const outside = (t: string): Part => ({ text: t.replace(/[“”„‟"«»]/g, "'"), outside: true });
const ours = (t: string): Part => ({ text: t, outside: false });
const flat = (ps: Part[], bare = false) => ps.map((x) => (x.outside && !bare ? `“${x.text}”` : x.text)).join('');

export function conflictId(a: string, b: string): string { return `c_${a}_${b}`; }

export class TodayFixtures {
  seenAt: number | null = null;
  checkinDone: boolean;
  wrapDone = false;
  private n = 0;
  private pending = false;

  constructor(private h: TodayHost, private scenario: string) {
    // the prototype's N00 has no check-in on screen at 9:10: it was done earlier this morning
    this.checkinDone = scenario !== 'N05';
  }

  seed(): void {
    if (this.scenario === 'not-connected') this.h.calendar.clear();
  }

  /** Something Today is made of changed: one data-less notice on the stream, as the server sends (coalesced). */
  changed(): void {
    if (this.pending) return;
    this.pending = true;
    this.h.later(() => { this.pending = false; this.h.notify(); }, 0);
  }

  // ---------- requests ----------
  read(path: string): Resp | null {
    if (path === '/today') return { status: 200, body: this.doc() };
    if (path === '/calendar/accounts') return { status: 200, body: this.accounts() };
    return null;
  }

  write(method: string, path: string, body: unknown): Resp | null {
    if (method !== 'POST') return null;
    const now = this.h.clock();
    const b = (body ?? {}) as { seenAt?: unknown; day?: unknown };
    if (path === '/today/seen') {
      // the Today that was looked at, clamped to [the last look, now] (as the server)
      if (b.seenAt !== undefined && (typeof b.seenAt !== 'number' || b.seenAt < 0)) return err(400, 'bad_seen', '`seenAt` is a time in milliseconds.');
      const at = typeof b.seenAt === 'number' ? Math.min(b.seenAt, now) : now;
      this.seenAt = Math.max(this.seenAt ?? 0, at);
      return { status: 200, body: { seenAt: this.seenAt } };
    }
    // a check-in or wrap for another day (a tap queued yesterday): nothing changes
    if ((path === '/today/checkin/done' || path === '/today/wrap/done') && b.day !== undefined && b.day !== localDay(now)) {
      return { status: 200, body: { message: 'That was for another day, so nothing changed.', ignored: true, today: this.doc() } };
    }
    if (path === '/today/checkin/done') { this.checkinDone = true; this.changed(); return { status: 200, body: { message: `Morning check-in done. Have a good ${weekdayOf(now)}.`, today: this.doc() } }; }
    if (path === '/today/wrap/done') { this.wrapDone = true; this.changed(); return { status: 200, body: { message: 'See you in the morning.', today: this.doc() } }; }
    if (path === '/calendar/refresh') return { status: 200, body: this.accounts(true) };
    if (path === '/calendar/drafts') return this.createDraft(body);
    return null;
  }

  private createDraft(body: unknown): Resp {
    const b = (body ?? {}) as { title?: unknown; start?: unknown; end?: unknown; allDay?: unknown; location?: unknown; provider?: unknown };
    const title = String(b.title ?? '').trim();
    if (!title) return err(400, 'bad_title', 'Give the event a name.');
    const start = String(b.start ?? '');
    const allDay = b.allDay === true || /^\d{4}-\d{2}-\d{2}$/.test(start);
    // an offset is honoured as given; without one, the time is this machine's local time (the fixture's zone)
    const local = (s: string) => {
      if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return Date.parse(s);
      const [d, t = '00:00'] = s.split('T'); const [y, m, dd] = d.split('-').map(Number); const [hh, mm] = t.split(':').map(Number); return new Date(y, m - 1, dd, hh, mm).getTime();
    };
    if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?)?$/i.test(start)) return err(400, 'bad_start', 'That start isn’t a date or a time.');
    let s: string, e: string;
    if (allDay) {
      s = start.slice(0, 10);
      const next = new Date(local(s)); next.setDate(next.getDate() + 1);
      e = b.end ? String(b.end).slice(0, 10) : localDay(next.getTime());
    } else {
      const sm = local(start), em = b.end ? local(String(b.end)) : sm + 60 * MINUTE;
      if (em <= sm) return err(400, 'bad_end', 'The end is before the start.');
      s = new Date(sm).toISOString(); e = new Date(em).toISOString();
    }
    const same = [...this.h.calendar.values()].find((x) => x.kind === 'draft' && x.state === 'draft' && x.title === title && x.start === s && x.end === e);
    if (same) return { status: 200, body: { draft: same, message: 'That draft is already there.' } };
    const connected = this.scenario !== 'not-connected';
    const draft: CalendarItem = { id: `cd_you${++this.n}`, kind: 'draft', title, start: s, end: e, allDay, location: b.location ? String(b.location) : null,
      provider: connected ? (b.provider === 'outlook' ? 'outlook' : 'google') : null, state: 'draft', confirmedAt: null, origin: 'you' };
    this.h.putCal(draft);
    return { status: 201, body: { draft, message: 'Added as a draft. Nothing is on your calendar until you confirm it.' } };
  }

  // ---------- the calendar's accounts ----------
  accounts(refresh = false): CalendarAccounts {
    const now = this.h.clock();
    const google = { account: GOOGLE, provider: 'google' as const, label: 'Google Calendar', connected: true, needsReconnect: false, lastOk: refresh ? now : now - 5 * MINUTE, lastError: null };
    let accounts: CalendarAccounts['accounts'], results: CalendarAccounts['results'] = [];
    switch (this.scenario) {
      case 'not-connected':
        accounts = [{ ...google, connected: false, lastOk: null }];
        results = [{ account: GOOGLE, ok: false, skipped: 'not_connected' }];
        break;
      case 'partial':
        accounts = [google, { account: OUTLOOK, provider: 'outlook', label: 'Outlook', connected: true, needsReconnect: false, lastOk: null, lastError: null }];
        results = [{ account: GOOGLE, ok: true }, { account: OUTLOOK, ok: false, error: 'Outlook didn’t answer. Try again in a moment.' }];
        break;
      case 'reconnect':
        accounts = [{ ...google, needsReconnect: true, lastOk: at(0, '07:40'), lastError: 'The sign-in expired.' }];
        results = [{ account: GOOGLE, ok: false, error: 'Google Calendar needs to be reconnected.' }];
        break;
      default:
        accounts = [google];
        results = [{ account: GOOGLE, ok: true }];
    }
    return refresh ? { accounts, results } : { accounts };
  }

  // ---------- Today ----------
  private calState(): { state: Today['freshness']['calendar']; note: string | null; asOf: number | null } {
    const now = this.h.clock();
    switch (this.scenario) {
      case 'not-connected': return { state: 'not_connected', note: 'Your calendar isn\'t connected, so I can\'t show what\'s next.', asOf: null };
      case 'partial': return { state: 'partial', note: 'Your Outlook calendar hasn\'t synced yet, so your day may be missing things.', asOf: now - 5 * MINUTE };
      case 'reconnect': return { state: 'reconnect', note: `Google Calendar needs to be reconnected, so your day may be out of date (last updated ${clockLabel(at(0, '07:40'))}).`, asOf: at(0, '07:40') };
      default: return { state: 'ok', note: null, asOf: now - 5 * MINUTE };
    }
  }

  /** Timed events (not drafts) that overlap, from now through two weeks, soonest first. */
  conflicts(): Schemas['CalendarConflict'][] {
    const now = this.h.clock(), until = now + 14 * 86_400_000;
    const timed = [...this.h.calendar.values()].filter((i) => !i.allDay && i.kind === 'event' && Date.parse(i.end) > now && Date.parse(i.start) < until)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || (a.id < b.id ? -1 : 1));
    const out: Schemas['CalendarConflict'][] = [];
    for (let a = 0; a < timed.length; a++) for (let b = a + 1; b < timed.length; b++) {
      const s = Math.max(Date.parse(timed[a].start), Date.parse(timed[b].start)), e = Math.min(Date.parse(timed[a].end), Date.parse(timed[b].end));
      if (s < e) out.push({ id: conflictId(timed[a].id, timed[b].id), between: [timed[a].id, timed[b].id], titles: [timed[a].title, timed[b].title], start: new Date(s).toISOString(), end: new Date(e).toISOString() });
    }
    return out.sort((x, y) => Date.parse(x.start) - Date.parse(y.start));
  }

  /** Worth a look: the top open Important items (W3's world), minus what a Needs-you card shows. */
  private worth(shown: Set<string>): { top: ImportantItem[]; total: number } {
    const open = this.h.important().filter((i) => i.state === 'open' && i.source !== 'approval' && i.source !== 'connection').sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1));
    return { top: open.filter((i) => !shown.has(i.id)).slice(0, 3), total: open.length };
  }

  private doneLines(): Done[] {
    const said = (...parts: Part[]) => ({ text: flat(parts), parts });
    const all: Done[] = [
      { id: 'draft:cd_e9', kind: 'draft-event', at: at(0, '05:30'), trust: 'untrusted', open: { kind: 'calendar', id: 'cd_e9', date: localDay(dayStart(2)) },
        ...said(ours('I added '), outside('Riley — dentist'), ours(' on Wed Nov 11 at 3:30 PM as a draft. Confirm it when you see it.')) },
      { id: 'action:41', kind: 'reply-drafted', at: at(0, '06:45'), trust: 'trusted', open: { kind: 'mail', id: 'm_m1' }, ...said(ours('I drafted a yes to Coach Ellen about Saturday. Nothing was sent.')) },
      { id: 'job:j_news', kind: 'job-finished', at: at(0, '07:05'), trust: 'trusted', open: { kind: 'job', id: 'j_news' }, ...said(ours('I found 3 AI stories for Thursday’s newsletter.')) },
    ];
    const since = this.since();
    return all.filter((d) => d.at > since && d.at <= this.h.clock()).sort((a, b) => b.at - a.at);
  }
  private since(): number { return Math.max(this.h.clock() - 7 * 86_400_000, this.seenAt ?? this.h.clock() - 24 * 3_600_000); }

  doc(): Today {
    const now = this.h.clock(), mins = minutesOf(now), day = localDay(now);
    const part: Today['part'] = mins < 300 ? 'night' : mins < 720 ? 'morning' : mins < 1020 ? 'afternoon' : 'evening';
    const weekday = weekdayOf(now);
    const cal = this.calState();
    const known = cal.state !== 'not_connected' && cal.state !== 'not_synced';
    const d0 = dayStart(0), d1 = dayStart(1), d2 = dayStart(2);
    const items = [...this.h.calendar.values()];
    const agenda = items.filter((i) => (i.kind === 'event' || i.state === 'draft') && Date.parse(i.start) < d1 && Date.parse(i.end) > d0).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const onCal = agenda.filter((i) => i.kind === 'event' || i.state === 'confirmed');
    const remaining = onCal.filter((i) => i.allDay || Date.parse(i.end) > now);
    const upcoming = remaining.filter((i) => !i.allDay);
    const nextUp = upcoming.slice(0, 3).map((i) => {
      const gap = Math.round((Date.parse(i.start) - now) / 60_000);
      return { id: i.id, kind: i.kind, title: i.title, start: i.start, end: i.end, location: i.location, startLabel: clockLabel(Date.parse(i.start)), soon: gap <= 0 ? 'Now' : gap <= 60 ? `in ${gap} min` : null };
    });

    // needs you: a job waiting, the next double-booking, an account to reconnect — never mail
    const needs: (Need & { spoken: string })[] = [];
    const waiting = [...this.h.jobs.values()].filter((j) => !j.archived && j.status.state === 'waiting');
    if (waiting.length) {
      const j = waiting[0];
      needs.push({ id: 'need:jobs', kind: 'job', count: waiting.length, title: j.title, text: j.status.detail, titleParts: [ours(j.title)], textParts: [ours(j.status.detail)], trust: 'trusted', itemId: null,
        action: j.status.primaryAction ? { kind: j.status.primaryAction.action, label: j.status.primaryAction.label } : null, open: { kind: 'job', id: j.id }, spoken: 'A job is waiting for you.' });
    }
    const conflicts = known ? this.conflicts() : [];
    if (conflicts.length) {
      const c = conflicts[0];
      needs.push({ id: `need:conflict:${c.id}`, kind: 'conflict', count: conflicts.length, title: 'Thursday at 4 is double-booked',
        text: 'Riley’s practice and the farrier overlap. Want me to draft a note asking the farrier for 5:30?', trust: 'untrusted', itemId: 'it_clash',
        // the clash's Important item is the helper's own (trusted) in the example world: its words are ours
        titleParts: [ours('Thursday at 4 is double-booked')], textParts: [ours('Riley’s practice and the farrier overlap. Want me to draft a note asking the farrier for 5:30?')],
        action: { kind: 'draft-note', label: 'Draft the note' }, open: { kind: 'item', id: 'it_clash', date: localDay(Date.parse(c.start)) }, spoken: `${weekdayOf(Date.parse(c.start))} at ${clockLabel(Date.parse(c.start))} is double-booked.` });
    }
    if (this.scenario === 'reconnect') {
      needs.push({ id: 'need:reconnect', kind: 'reconnect', count: 1, title: 'Google Calendar needs to be reconnected', text: 'I can\'t check it until you sign in again.', trust: 'trusted', itemId: null,
        titleParts: [ours('Google Calendar needs to be reconnected')], textParts: [ours('I can\'t check it until you sign in again.')],
        action: { kind: 'reconnect', label: 'Reconnect' }, open: { kind: 'reconnect', id: GOOGLE, resource: 'calendar' }, spoken: 'Google Calendar needs to be reconnected.' });
    }
    const needCount = needs.reduce((s, c) => s + c.count, 0);
    const done = this.doneLines();
    const worth = this.worth(new Set(needs.map((n) => n.itemId).filter((x): x is string => !!x)));
    const weekCounts = { repliesDrafted: 6, eventsAdded: 4, documentsLearned: 2, jobsFinished: 3 };

    let checkin: Today['checkin'] = null;
    if (mins >= 300 && mins < 720 && !this.checkinDone) {
      const events = known ? remaining.length : 0;
      const cal1 = !known ? 'I can’t see your calendar yet' : cal.state === 'partial' ? `${plural(events, 'thing', 'things')} on the calendars I can see` : `${plural(events, 'thing', 'things')} on your calendar`;
      const overnight = done.length;
      const text = `Here’s your ${weekday}: ${cal1}, ${needCount ? `${plural(needCount, 'thing needs', 'things need')} you` : 'nothing needs you'}, and I did ${plural(overnight, 'thing', 'things')} overnight. It’s all below.`;
      const first = known && nextUp[0] ? ` Your first thing is at ${nextUp[0].startLabel}.` : '';
      checkin = { title: 'Your morning check-in', text, spoken: `${text.replace(' It’s all below.', '')}${first}${needs[0] ? ` ${needs[0].spoken}` : ''}`, trust: 'trusted', counts: { events, needsYou: needCount, overnight } };
    }

    let wrap: Today['wrap'] = null;
    if (mins >= 1020 && !this.wrapDone) {
      const tomorrow = items.filter((i) => i.kind === 'event' && !i.allDay && Date.parse(i.start) >= d1 && Date.parse(i.start) < d2).sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).slice(0, 2);
      const line1 = 'You confirmed 1 event and I drafted 2 replies today.';
      const unknown = !known ? 'I can’t see tomorrow’s calendar yet.' : !tomorrow.length ? 'Nothing is on your calendar tomorrow yet.' : null;
      const t = (i: CalendarItem) => clockLabel(Date.parse(i.start));
      const line2Parts: Part[] = unknown ? [ours(unknown)] : [ours(`Tomorrow starts at ${t(tomorrow[0])} with an event called `), outside(tomorrow[0].title.slice(0, 60)), ours(`${tomorrow[1] ? `, then something at ${t(tomorrow[1])}` : ''}.`)];
      const said2 = unknown ?? `Tomorrow starts at ${t(tomorrow[0])}${tomorrow[1] ? `, then ${t(tomorrow[1])}` : ''}.`;
      wrap = { title: `That’s ${weekday}`, lines: [line1, flat(line2Parts)], lineParts: [[ours(line1)], line2Parts], spoken: `${line1} ${said2}`, trust: unknown ? 'trusted' : 'untrusted', counts: { eventsConfirmed: 1, repliesDrafted: 2, jobsFinished: 0, doneToday: 3 } };
    }

    return {
      id: 'today', date: day, weekday, dateLabel: new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }), tz: FIXTURE_TZ, now,
      greetingName: 'Robert', greeting: `${part === 'morning' ? 'Good morning' : part === 'afternoon' ? 'Good afternoon' : 'Good evening'}, Robert`, part,
      checkin, wrap,
      needsYou: needs.map(({ spoken: _s, ...n }) => n),
      nextUp: known ? nextUp : [], nextUpMore: known ? Math.max(0, upcoming.length - nextUp.length) : 0, agenda: known ? agenda : [],
      doneForYou: done.slice(0, 3), doneMore: Math.max(0, done.length - 3), doneSince: this.since(),
      worthALook: worth.top, worthALookTotal: worth.total,
      weekLine: { text: 'In the last 7 days: 6 replies drafted, 4 events added, 2 documents learned, 3 jobs finished.', counts: weekCounts },
      month: { usedUsd: 1.29, limitUsd: 20, state: 'ok' },
      status: statusPill([...this.h.jobs.values()].filter((j) => !j.archived).map((j) => j.status)),
      freshness: {
        calendarAsOf: cal.asOf, mailAsOf: now - 5 * MINUTE, calendar: cal.state, mail: 'ok', calendarNote: cal.note, mailNote: null,
        needsReconnect: this.scenario === 'reconnect' ? [{ account: GOOGLE, resource: 'calendar', label: 'Google Calendar' }] : [],
      },
    };
  }
}
