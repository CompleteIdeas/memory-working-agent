/**
 * Drafts MWA holds until the person confirms them (v2 build, slice A7, 2026-10-26).
 *
 * Before: propose_event / propose_outlook_event inserted a real "[Proposed] …" event into the person's calendar —
 * visible to anyone who shares it, and something to clean up when it was wrong. Now (MWA_V2_DRAFTS on, the default)
 * they create a cal_drafts row and say so in plain words; the calendar view shows the draft dashed, with Confirm and
 * Remove. Confirm is the person's own action (an API route, never a model tool): it inserts the event with no
 * invitations — Google sendUpdates 'none', Outlook with no attendees — and records the provider's id.
 *
 * Confirm cannot insert twice:
 *   - the router's Idempotency-Key replays a retried request;
 *   - a lease on the draft (takeConfirmLease) turns away a second confirm while one is in flight, and a confirmed
 *     draft answers "already added" without calling the provider;
 *   - the provider insert is itself idempotent: Google gets an event id derived from the draft id (a repeat is 409,
 *     then fetched), Outlook gets the draft id as its transactionId — so even a crash between the insert and the
 *     record cannot leave two events.
 */
import { createHash } from 'node:crypto';
import { createDraft, getDraft, takeConfirmLease, releaseConfirmLease, recordConfirmed, updateDraft, openDrafts, setSyncState, type CalDraftRow, type CalProvider } from '../v2/calendar.js';
import { parseWhen, localTz, addDays, localDate, zonedToUtc } from './tz.js';
import { reconnectNeeded, shortError } from './errors.js';
import { logger } from '../logger.js';
import { ToolRefusal } from '../tools/registry.js';
// a module cycle (the connectors' propose tools call into this file); only used inside functions, so it is safe
import { calendarClient, googleConfigured } from '../connectors/google.js';
import { graph, microsoftConfigured } from '../connectors/microsoft.js';

export const DRAFT_ADDED = 'Added to your calendar as a draft. Confirm it in MWA.';
export const CONFIRM_RECEIPT = 'Added by your helper just now. No invites were sent.';

/** v2 drafts are on unless MWA_V2_DRAFTS is 0/false/off. */
export function v2DraftsOn(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(0|false|off|no)$/i.test(String(env.MWA_V2_DRAFTS ?? '').trim());
}

export class DraftError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** What the person (or the helper) gave: title, start, end — ISO 8601, a local time, or a bare date (all day). */
export interface DraftInput { title: string; start: string; end?: string; allDay?: boolean; location?: string; notes?: string; provider?: CalProvider | null; projectId?: string | null; sourceItem?: string | null; createdByTry?: string | null; tz?: string }

export function draftFromInput(x: DraftInput): Parameters<typeof createDraft>[0] {
  const tz = x.tz || localTz();
  const title = String(x.title ?? '').replace(/\s+/g, ' ').trim();
  if (!title) throw new DraftError(400, 'bad_draft', 'A draft needs a title.');
  let s: { ms: number; dateOnly: boolean }, e: { ms: number; dateOnly: boolean } | null;
  try {
    s = parseWhen(String(x.start ?? ''), tz);
    e = x.end ? parseWhen(String(x.end), tz) : null;
  } catch { throw new DraftError(400, 'bad_draft', 'The start or end is not a date and time I can read (use ISO 8601, like 2026-11-14T15:00).'); }
  const allDay = x.allDay ?? (s.dateOnly && (!e || e.dateOnly));
  let startMs = s.ms, endMs: number;
  if (allDay) {
    const sd = localDate(s.ms, tz);
    startMs = zonedToUtc(`${sd}T00:00:00`, tz);
    // an all-day end given as a date is exclusive when after the start, else the event is that one day
    const ed = e ? localDate(e.ms, tz) : sd;
    endMs = zonedToUtc(`${ed > sd ? ed : addDays(sd, 1)}T00:00:00`, tz);
  } else {
    endMs = e ? e.ms : s.ms + 3_600_000; // no end: an hour
  }
  if (!(endMs > startMs)) throw new DraftError(400, 'bad_draft', 'The end must be after the start.');
  if (endMs - startMs > 31 * 86_400_000) throw new DraftError(400, 'bad_draft', 'A draft can be at most 31 days long.');
  return {
    title, startMs, endMs, allDay, tz, location: x.location ? String(x.location).slice(0, 300) : null, notes: x.notes ? String(x.notes).slice(0, 4000) : null,
    provider: x.provider ?? null, projectId: x.projectId ?? null, sourceItem: x.sourceItem ?? null, createdByTry: x.createdByTry ?? null,
  };
}

/** Create a draft, or hand back the open one with the same title and times (a repeated proposal is not a second draft). */
export function addDraft(x: DraftInput): { draft: CalDraftRow; existing: boolean } {
  const input = draftFromInput(x);
  const same = openDrafts().find((d) => d.title.toLowerCase() === input.title.toLowerCase()
    && Date.parse(d.start_utc) === input.startMs && Date.parse(d.end_utc) === input.endMs);
  if (same) return { draft: same, existing: true };
  return { draft: createDraft(input), existing: false };
}

const fmtWhen = (d: CalDraftRow): string => {
  const tz = d.tz || localTz();
  const s = Date.parse(d.start_utc), e = Date.parse(d.end_utc);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
  if (d.all_day) return `${day.format(s)}, all day`;
  const t = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  return `${day.format(s)}, ${t.format(s)} – ${t.format(e)}`;
};

/** The propose_event / propose_outlook_event tools when drafts are on: a draft row, a plain message. */
export function proposeDraft(provider: CalProvider, args: Record<string, unknown>): string {
  try {
    const { draft } = addDraft({
      title: String(args.summary ?? args.title ?? ''), start: String(args.start ?? ''), end: args.end ? String(args.end) : undefined,
      location: args.location ? String(args.location) : undefined, notes: args.description ? String(args.description) : undefined, provider,
    });
    // only MWA's own words and times: the tool is in OWN_OUTPUT_TOOLS (governance.ts), so it echoes no title text
    return `${DRAFT_ADDED} (${fmtWhen(draft)}; draft ${draft.id})`;
  } catch (e) {
    throw new ToolRefusal(`(could not add the draft: ${(e as Error).message})`);
  }
}

// ── confirm ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** How a confirmed draft reaches a calendar. serve uses the real connectors; tests point them at fakes. */
export interface DraftProviders {
  connected: (p: CalProvider) => boolean;
  /** insert the event (no invitations) and return the provider's id */
  insert: (p: CalProvider, d: CalDraftRow) => Promise<string>;
}

/** Google event ids are base32hex (a–v, 0–9), 5–1024 chars: a hash of the draft id fits and never collides with ours. */
export function googleEventIdFor(draftId: string): string {
  return `mcal${createHash('sha256').update(draftId).digest('hex').slice(0, 40)}`;
}

const httpStatus = (err: unknown): number | undefined => {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: number } };
  const n = Number(e?.response?.status ?? e?.status ?? e?.code);
  return Number.isFinite(n) ? n : undefined;
};

async function insertGoogle(d: CalDraftRow): Promise<string> {
  const cal = await calendarClient();
  const id = googleEventIdFor(d.id);
  const tz = d.tz || 'UTC';
  const when = (utc: string) => d.all_day ? { date: localDate(Date.parse(utc), tz) } : { dateTime: utc, timeZone: tz };
  try {
    const r = await cal.events.insert({
      calendarId: 'primary', sendUpdates: 'none',
      requestBody: {
        id, summary: d.title, location: d.location ?? undefined, description: d.notes ?? undefined, start: when(d.start_utc), end: when(d.end_utc),
        extendedProperties: { private: { mwaDraft: d.id } },
      },
    });
    return r.data.id ?? id;
  } catch (e) {
    if (httpStatus(e) !== 409) throw e;
    // already inserted (a confirm that died before recording it): the same event, not a second one
    const g = await cal.events.get({ calendarId: 'primary', eventId: id });
    return g.data.id ?? id;
  }
}

async function insertOutlook(d: CalDraftRow): Promise<string> {
  const tz = d.tz || 'UTC';
  const wallUtc = (utc: string) => utc.replace(/Z$/, '');
  const when = (utc: string) => d.all_day ? { dateTime: `${localDate(Date.parse(utc), tz)}T00:00:00`, timeZone: tz } : { dateTime: wallUtc(utc), timeZone: 'UTC' };
  const e = await graph('/me/events', {
    method: 'POST',
    body: JSON.stringify({
      subject: d.title, body: { contentType: 'Text', content: d.notes ?? '' }, ...(d.location ? { location: { displayName: d.location } } : {}),
      start: when(d.start_utc), end: when(d.end_utc), isAllDay: d.all_day === 1,
      transactionId: d.id, // Graph's own guard against a repeated POST
    }),
  });
  return String(e.id);
}

let providers: DraftProviders = {
  connected: (p) => (p === 'google' ? googleConfigured() : microsoftConfigured()),
  insert: (p, d) => (p === 'google' ? insertGoogle(d) : insertOutlook(d)),
};
export function setDraftProviders(p: Partial<DraftProviders>): void { providers = { ...providers, ...p }; }

export interface ConfirmResult { draft: CalDraftRow; message: string; already: boolean }

export async function confirmDraft(id: string, opts: { provider?: CalProvider } = {}): Promise<ConfirmResult> {
  const lease = takeConfirmLease(id);
  if (!lease.ok) {
    if (lease.why === 'missing') throw new DraftError(404, 'not_found', 'No such draft.');
    if (lease.why === 'confirmed') return { draft: lease.draft!, message: 'It is already on your calendar. Nothing new was added.', already: true };
    if (lease.why === 'removed') throw new DraftError(409, 'removed', 'That draft was removed.');
    throw new DraftError(409, 'in_progress', 'That draft is being added right now.');
  }
  const draft = lease.draft;
  const order: CalProvider[] = opts.provider ? [opts.provider] : draft.provider ? [draft.provider] : ['google', 'outlook'];
  const provider = order.find((p) => providers.connected(p));
  if (!provider) {
    releaseConfirmLease(id);
    throw new DraftError(409, 'no_calendar', opts.provider || draft.provider
      ? `${(opts.provider ?? draft.provider) === 'google' ? 'Google Calendar' : 'Outlook'} is not connected. Connect it, or download the .ics file instead.`
      : 'No calendar is connected. Connect one, or download the .ics file instead.');
  }
  let providerId: string;
  try {
    providerId = await providers.insert(provider, draft);
  } catch (e) {
    releaseConfirmLease(id);
    if (reconnectNeeded(e)) {
      try { setSyncState(provider, 'calendar', { needs_reconnect: 1, last_error: shortError(e) }); } catch { /* best-effort */ }
      throw new DraftError(409, 'needs_reconnect', `${provider === 'google' ? 'Google' : 'Outlook'} needs you to sign in again before I can add it.`);
    }
    logger.warn('calendar', 'confirm failed', { provider, error: shortError(e) });
    throw new DraftError(502, 'calendar_error', `${provider === 'google' ? 'Google Calendar' : 'Outlook'} did not take it: ${shortError(e)}`);
  }
  const done = recordConfirmed(draft, provider, providerId);
  return { draft: done, message: CONFIRM_RECEIPT, already: false };
}

export function removeDraft(id: string): { draft: CalDraftRow; message: string } {
  const d = getDraft(id);
  if (!d) throw new DraftError(404, 'not_found', 'No such draft.');
  if (d.state === 'removed') return { draft: d, message: 'Removed.' };
  if (d.state === 'confirmed') throw new DraftError(409, 'confirmed', 'It is already on your calendar. Remove it there.');
  if (d.confirm_lease && Date.now() - d.confirm_lease < 120_000) throw new DraftError(409, 'in_progress', 'That draft is being added right now.');
  return { draft: updateDraft(id, { state: 'removed' }), message: 'Removed. Nothing was added to your calendar.' };
}
