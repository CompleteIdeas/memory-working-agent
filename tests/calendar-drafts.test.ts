// v2 build, slice A7: drafts MWA holds until the person confirms them. propose_event / propose_outlook_event no
// longer write to the calendar; Confirm inserts once (no invites); Remove; and the .ics file. Against FAKE Google
// and Graph servers over real HTTP (tests/fakes).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetAppDb, appDb } from '../src/v2/db.js';
import { getDraft, getCalEvent, getSyncState, calendarItems, openDrafts } from '../src/v2/calendar.js';
import { addDraft, confirmDraft, removeDraft, draftFromInput, googleEventIdFor, DRAFT_ADDED, CONFIRM_RECEIPT, DraftError, v2DraftsOn } from '../src/sync/drafts.js';
import { buildIcs, parseIcs, icsFold, icsEscape, icsFileName } from '../src/sync/ics.js';
import { googleTools } from '../src/connectors/google.js';
import { microsoftTools } from '../src/connectors/microsoft.js';
import { classifyTool, effectOf } from '../src/tools/governance.js';
import { ToolRefusal } from '../src/tools/registry.js';
import { calendarFakes, type CalendarFakes } from './fakes/calendar-env.js';

let f: CalendarFakes;
beforeEach(async () => { resetAppDb(':memory:'); f = await calendarFakes(); });
afterEach(async () => { await f.done(); });

const tool = (list: ReturnType<typeof googleTools>, name: string) => list.find((t) => t.def.name === name)!;
const ctx = {} as never;
const BOOK_FAIR = { title: 'Book fair', start: '2026-11-14T15:00', end: '2026-11-14T18:00', location: 'Oakwood Elementary' };

describe('propose_event / propose_outlook_event (the helper)', () => {
  it('BEFORE was a real "[Proposed]" event in Google; NOW a draft in MWA and nothing sent to Google', async () => {
    // before (MWA_V2_DRAFTS=0 keeps the old path): an insert into the person's calendar
    process.env.MWA_V2_DRAFTS = '0';
    const old = await tool(googleTools(), 'propose_event').handler({ summary: 'Book fair', start: '2026-11-14T15:00:00-05:00', end: '2026-11-14T18:00:00-05:00' }, ctx);
    expect(String(old)).toMatch(/proposed event created/);
    expect(f.google.inserts.map((i) => i.body.summary)).toEqual(['[Proposed] Book fair']);
    expect(classifyTool('propose_event')).toBe('external');

    // now (default): a draft row and a plain message; no request reaches Google at all
    delete process.env.MWA_V2_DRAFTS;
    expect(v2DraftsOn()).toBe(true);
    const before = f.google.requests.length;
    const out = String(await tool(googleTools(), 'propose_event').handler({ summary: 'Book fair', start: '2026-11-14T15:00', end: '2026-11-14T18:00', location: 'Oakwood Elementary' }, ctx));
    expect(out.startsWith(DRAFT_ADDED)).toBe(true);
    expect(out).toContain('Sat, Nov 14, 3:00 PM – 6:00 PM');
    expect(out).not.toContain('Book fair'); // own output: MWA's words and times only
    expect(f.google.requests.length).toBe(before);
    const [d] = openDrafts();
    expect(d).toMatchObject({ title: 'Book fair', start_utc: '2026-11-14T20:00:00.000Z', end_utc: '2026-11-14T23:00:00.000Z', provider: 'google', state: 'draft', location: 'Oakwood Elementary', all_day: 0 });
    expect(classifyTool('propose_event')).toBe('write-local');
    expect(effectOf('propose_outlook_event')).toBe('local');
  });

  it('a repeated proposal is the same draft, not a second one', async () => {
    const t = tool(googleTools(), 'propose_event');
    await t.handler({ summary: 'Book fair', start: '2026-11-14T15:00:00-05:00', end: '2026-11-14T18:00:00-05:00' }, ctx);
    await t.handler({ summary: 'book fair', start: '2026-11-14T20:00:00Z', end: '2026-11-14T23:00:00Z' }, ctx);
    expect(openDrafts().length).toBe(1);
  });

  it('propose_outlook_event: an Outlook draft; Graph is not called', async () => {
    const out = String(await tool(microsoftTools(), 'propose_outlook_event').handler({ summary: 'Board call', start: '2026-11-11T14:00', end: '2026-11-11T15:00' }, ctx));
    expect(out.startsWith(DRAFT_ADDED)).toBe(true);
    expect(f.graph.requests.length).toBe(0);
    expect(openDrafts()[0]).toMatchObject({ provider: 'outlook', start_utc: '2026-11-11T19:00:00.000Z' });
  });

  it('a bad time is a refusal (the run sees it failed), not a draft', async () => {
    await expect(tool(googleTools(), 'propose_event').handler({ summary: 'X', start: 'next Saturday', end: 'later' }, ctx)).rejects.toBeInstanceOf(ToolRefusal);
    expect(openDrafts().length).toBe(0);
  });
});

describe('reading the person’s input', () => {
  it('local times, offsets, bare dates (all day), a default hour, and refusals', () => {
    expect(draftFromInput({ ...BOOK_FAIR })).toMatchObject({ startMs: Date.parse('2026-11-14T20:00:00Z'), endMs: Date.parse('2026-11-14T23:00:00Z'), allDay: false, tz: 'America/New_York' });
    expect(draftFromInput({ title: 'Lunch', start: '2026-11-11T12:00' }).endMs).toBe(Date.parse('2026-11-11T18:00:00Z'));
    const allDay = draftFromInput({ title: 'Clocks change', start: '2026-11-01' });
    expect([new Date(allDay.startMs).toISOString(), new Date(allDay.endMs).toISOString(), allDay.allDay]).toEqual(['2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z', true]);
    const twoDays = draftFromInput({ title: 'Show', start: '2026-11-14', end: '2026-11-16' });
    expect(new Date(twoDays.endMs).toISOString()).toBe('2026-11-16T05:00:00.000Z');
    expect(() => draftFromInput({ title: 'x', start: '2026-11-14T15:00', end: '2026-11-14T14:00' })).toThrow(/after the start/);
    expect(() => draftFromInput({ title: ' ', start: '2026-11-14T15:00' })).toThrow(/title/);
    expect(() => draftFromInput({ title: 'x', start: 'soon' })).toThrow(/ISO 8601/);
  });
});

describe('Confirm', () => {
  it('Google: inserted once with no invitations, recorded, and in the calendar view as the helper’s', async () => {
    const { draft } = addDraft({ ...BOOK_FAIR, provider: 'google' });
    const r = await confirmDraft(draft.id);
    expect(r).toMatchObject({ message: CONFIRM_RECEIPT, already: false });
    expect(r.message).toBe('Added by your helper just now. No invites were sent.');
    expect(f.google.inserts.length).toBe(1);
    const ins = f.google.inserts[0];
    expect(ins.query.sendUpdates).toBe('none');
    expect(ins.body.attendees).toBeUndefined();
    expect(ins.body).toMatchObject({ id: googleEventIdFor(draft.id), summary: 'Book fair', location: 'Oakwood Elementary', start: { dateTime: '2026-11-14T20:00:00.000Z' } });
    expect(googleEventIdFor(draft.id)).toMatch(/^[a-v0-9]{5,1024}$/); // Google's id alphabet (base32hex)
    expect(getDraft(draft.id)).toMatchObject({ state: 'confirmed', provider: 'google', provider_id: googleEventIdFor(draft.id), confirm_lease: null });
    expect(getCalEvent('google', googleEventIdFor(draft.id))).toMatchObject({ is_helper_confirmed: 1, start_utc: '2026-11-14T20:00:00.000Z' });
    const items = calendarItems('2026-11-14T05:00:00.000Z', '2026-11-15T05:00:00.000Z');
    expect(items).toEqual([expect.objectContaining({ kind: 'event', title: 'Book fair', addedByHelper: true })]); // shown once
  });

  it('a double confirm inserts once (sequential and concurrent)', async () => {
    const a = addDraft({ ...BOOK_FAIR, provider: 'google' }).draft;
    await confirmDraft(a.id);
    const again = await confirmDraft(a.id);
    expect(again.already).toBe(true);
    expect(f.google.inserts.length).toBe(1);

    const b = addDraft({ title: 'Dentist', start: '2026-11-11T15:30', end: '2026-11-11T16:15', provider: 'google' }).draft;
    const both = await Promise.allSettled([confirmDraft(b.id), confirmDraft(b.id)]);
    expect(f.google.inserts.length).toBe(2); // one more, not two
    const ok = both.filter((x) => x.status === 'fulfilled');
    const refused = both.filter((x) => x.status === 'rejected') as PromiseRejectedResult[];
    expect(ok.length + refused.length).toBe(2);
    for (const x of refused) expect((x.reason as DraftError).code).toBe('in_progress');
    expect(getDraft(b.id)!.state).toBe('confirmed');
  });

  it('a confirm that died after Google took it does not make a second event (fixed id → 409 → the same one)', async () => {
    const { draft } = addDraft({ ...BOOK_FAIR, provider: 'google' });
    f.google.put({ id: googleEventIdFor(draft.id), summary: 'Book fair', start: { dateTime: '2026-11-14T20:00:00Z' }, end: { dateTime: '2026-11-14T23:00:00Z' } });
    const r = await confirmDraft(draft.id);
    expect(r.already).toBe(false);
    expect(getDraft(draft.id)!.provider_id).toBe(googleEventIdFor(draft.id));
    expect(f.google.requests.filter((q) => q.method === 'GET' && q.path.endsWith(googleEventIdFor(draft.id))).length).toBe(1);
  });

  it('Outlook: no attendees, the draft id as transactionId; a repeat after a lost record returns the same event', async () => {
    const { draft } = addDraft({ title: 'Board call', start: '2026-11-11T14:00', end: '2026-11-11T15:00', provider: 'outlook' });
    const r = await confirmDraft(draft.id);
    expect(r.message).toBe(CONFIRM_RECEIPT);
    const body = f.graph.inserts[0];
    expect(body.attendees).toBeUndefined();
    expect(body).toMatchObject({ subject: 'Board call', transactionId: draft.id, isAllDay: false, start: { dateTime: '2026-11-11T19:00:00.000', timeZone: 'UTC' } });
    const pid = getDraft(draft.id)!.provider_id;
    // simulate a crash that lost the record: back to draft, confirm again
    appDb().prepare(`UPDATE cal_drafts SET state = 'draft', provider_id = NULL WHERE id = ?`).run(draft.id);
    await confirmDraft(draft.id);
    expect(f.graph.inserts.length).toBe(2); // asked twice …
    expect(getDraft(draft.id)!.provider_id).toBe(pid); // … one event
  });

  it('all-day: Google gets dates, Outlook midnight in the zone', async () => {
    const g = addDraft({ title: 'Book fair week', start: '2026-11-14', provider: 'google' }).draft;
    await confirmDraft(g.id);
    expect(f.google.inserts[0].body).toMatchObject({ start: { date: '2026-11-14' }, end: { date: '2026-11-15' } });
    const o = addDraft({ title: 'School closed', start: '2026-11-13', provider: 'outlook' }).draft;
    await confirmDraft(o.id);
    expect(f.graph.inserts[0]).toMatchObject({ isAllDay: true, start: { dateTime: '2026-11-13T00:00:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-11-14T00:00:00' } });
  });

  it('no calendar connected: refused, the draft stays a draft (download the .ics instead)', async () => {
    f.disconnect('google'); f.disconnect('outlook');
    const { draft } = addDraft({ ...BOOK_FAIR });
    await expect(confirmDraft(draft.id)).rejects.toMatchObject({ code: 'no_calendar', status: 409 });
    expect(getDraft(draft.id)).toMatchObject({ state: 'draft', confirm_lease: null });
  });

  it('a revoked sign-in: needs_reconnect, nothing inserted, the draft stays', async () => {
    f.googleToken({ expired: true });
    f.google.refreshFails = 'invalid_grant';
    const { draft } = addDraft({ ...BOOK_FAIR, provider: 'google' });
    await expect(confirmDraft(draft.id)).rejects.toMatchObject({ code: 'needs_reconnect' });
    expect(f.google.inserts.length).toBe(0);
    expect(getSyncState('google', 'calendar')).toMatchObject({ needs_reconnect: 1 });
    expect(getDraft(draft.id)).toMatchObject({ state: 'draft', confirm_lease: null });
  });
});

describe('Remove', () => {
  it('marks it removed; again is fine; a removed draft cannot be confirmed; a confirmed one cannot be removed', async () => {
    const { draft } = addDraft({ ...BOOK_FAIR, provider: 'google' });
    expect(removeDraft(draft.id).draft.state).toBe('removed');
    expect(removeDraft(draft.id).draft.state).toBe('removed');
    await expect(confirmDraft(draft.id)).rejects.toMatchObject({ code: 'removed' });
    expect(f.google.inserts.length).toBe(0);
    expect(calendarItems('2026-11-14T00:00:00.000Z', '2026-11-16T00:00:00.000Z')).toEqual([]);
    const other = addDraft({ ...BOOK_FAIR, provider: 'google' }).draft; // a fresh one with the same details is allowed
    await confirmDraft(other.id);
    expect(() => removeDraft(other.id)).toThrow(/already on your calendar/);
    expect(() => removeDraft('cd_nope')).toThrow(/No such draft/);
  });
});

describe('.ics', () => {
  const physical = (ics: string) => ics.split('\r\n').slice(0, -1);
  it('a valid VCALENDAR for the book fair: UTC times, UID, DTSTAMP, CRLF everywhere', () => {
    const ics = buildIcs({ uid: 'cd_abc@mwa', title: 'Book fair', start: Date.parse('2026-11-14T20:00:00Z'), end: Date.parse('2026-11-14T23:00:00Z'), allDay: false, location: 'Oakwood Elementary', stamp: Date.parse('2026-10-26T12:34:56Z') });
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/); // no bare LF or CR
    const p = parseIcs(ics);
    expect(p.lines[0]).toBe('BEGIN:VCALENDAR');
    expect(p.lines).toContain('VERSION:2.0');
    expect(p.lines.at(-1)).toBe('END:VCALENDAR');
    expect(p.events.length).toBe(1);
    const e = p.events[0];
    expect(e.UID.value).toBe('cd_abc@mwa');
    expect(e.DTSTAMP.value).toBe('20261026T123456Z');
    expect(e.DTSTART.value).toBe('20261114T200000Z');
    expect(e.DTEND.value).toBe('20261114T230000Z');
    expect(e.SUMMARY.value).toBe('Book fair');
    expect(e.LOCATION.value).toBe('Oakwood Elementary');
    expect(icsFileName('Book fair')).toBe('book-fair.ics');
  });
  it('escapes TEXT and folds long lines at 75 octets without splitting a character', () => {
    const notes = 'Bring: books, a bag; cash\\change.\nSecond line — café ☕ '.repeat(6);
    const ics = buildIcs({ uid: 'u@mwa', title: 'Fair, part 1; bring \\ cash', start: 0, end: 3_600_000, allDay: false, notes, stamp: 0 });
    for (const line of physical(ics)) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
      expect(Buffer.from(line, 'utf8').toString('utf8')).toBe(line); // whole characters only
    }
    expect(physical(ics).some((l) => l.startsWith(' '))).toBe(true); // it did fold
    const e = parseIcs(ics).events[0];
    expect(e.SUMMARY.value).toBe('Fair, part 1; bring \\ cash');
    expect(e.DESCRIPTION.value).toBe(notes);
    expect(icsEscape('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
    // an emoji (4 octets) that would cross the boundary moves whole to the next line
    const folded = icsFold('X'.repeat(72) + '😀');
    expect(folded.split('\r\n').map((l) => Buffer.byteLength(l))).toEqual([72, 5]);
    expect(folded.split('\r\n')[1]).toBe(' 😀');
  });
  it('all day: VALUE=DATE, end exclusive', () => {
    const e = parseIcs(buildIcs({ uid: 'u', title: 'Book fair', start: '2026-11-14', end: '2026-11-15', allDay: true, stamp: 0 })).events[0];
    expect([e.DTSTART.params, e.DTSTART.value, e.DTEND.value]).toEqual([';VALUE=DATE', '20261114', '20261115']);
  });
});

describe('list_events (the helper reads the synced calendar)', () => {
  it('lists events and open drafts in local time, flags double-bookings, and is a classified read', async () => {
    const { calendarTools } = await import('../src/sync/calendar-tool.js');
    const { upsertCalEvent } = await import('../src/v2/calendar.js');
    const { hasExplicitCategory } = await import('../src/tools/governance.js');
    const { isCalendarList } = await import('../src/calendar-check.js');
    upsertCalEvent('google', 'google', { provider_id: 'p', title: 'Riley — practice', start_utc: '2026-11-12T21:00:00.000Z', end_utc: '2026-11-12T22:30:00.000Z', all_day: false });
    upsertCalEvent('google', 'google', { provider_id: 'f', title: 'Farrier', start_utc: '2026-11-12T21:00:00.000Z', end_utc: '2026-11-12T22:00:00.000Z', all_day: false });
    addDraft({ ...BOOK_FAIR });
    const t = calendarTools()[0];
    expect(t.def.name).toBe('list_events');
    expect(isCalendarList(t.def.name)).toBe(true); // calendar-check.ts now has its tool
    expect(hasExplicitCategory('list_events')).toBe(true);
    expect(classifyTool('list_events')).toBe('read');
    const out = String(await t.handler({ from: '2026-11-12', to: '2026-11-14' }, ctx));
    expect(out).toContain('Thu, Nov 12 | 4:00 PM–5:00 PM | Farrier');
    expect(out).toContain('Sat, Nov 14 | 3:00 PM–6:00 PM | Book fair (draft, not confirmed) | Oakwood Elementary');
    expect(out).toMatch(/Double-booked: Farrier and Riley — practice overlap Thu, Nov 12 4:00 PM–5:00 PM/);
    expect(String(await t.handler({ from: '2026-12-01', to: '2026-12-02' }, ctx))).toBe('No events in that range.');
  });
});
