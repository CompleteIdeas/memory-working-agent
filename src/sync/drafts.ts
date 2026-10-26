/**
 * Drafts MWA holds until the person confirms them (v2 build, slice A7, 2026-10-26).
 *
 * Before: propose_event / propose_outlook_event inserted a real "[Proposed] …" event into the person's calendar —
 * visible to anyone who shares it, and something to clean up when it was wrong. Now (MWA_V2_DRAFTS on, the default)
 * they create a cal_drafts row and say so in plain words; the calendar view shows the draft dashed, with Confirm and
 * Remove. Confirm is the person's own action (an API route, never a model tool): it inserts the event with no
 * invitations — Google sendUpdates 'none', Outlook with no attendees — and records the provider's id.
 *
 * Provenance (review of A7): a draft says where it came from — 'you' (the person's own input through the API), 'helper',
 * or 'helper-after-reading' when the helper's run had read outside content (an email, a web page) before proposing it,
 * which is when a draft may carry someone else's words. The run that proposed it is kept (created_by_try).
 *
 * Confirm cannot insert twice:
 *   - the router's Idempotency-Key replays a retried request (a transient refusal is not remembered, so a retry runs);
 *   - a lease with a token on the draft turns away a second confirm while one is in flight; only the holder of the
 *     lease may record the result, and never over a draft the person removed meanwhile;
 *   - the provider insert is itself idempotent. Google: an event id derived from the draft id (a repeat is 409, then
 *     fetched — and if the person deleted that event in Google, it is not added again). Outlook: the event carries
 *     the draft id in a single-value extended property, looked up before inserting (transactionId is sent too, but
 *     its replay behaviour is not documented, so nothing depends on it).
 *
 * Remove: refused while a confirm holds the draft ("Adding it right now"). A confirm whose insert lands after the
 * person removed the draft deletes that event again (MWA made it moments before, with no invitations, so nobody else
 * has seen it, and the person's last word was Remove); if that delete fails, the draft keeps the event's id in
 * orphan_provider_id and the person is told to remove it in their calendar.
 */
import { createHash } from 'node:crypto';
import {
  createDraft, getDraft, takeConfirmLease, releaseConfirmLease, recordConfirmed, updateDraft, openDrafts, setSyncState,
  CONFIRM_LEASE_MS, type CalDraftRow, type CalProvider,
} from '../v2/calendar.js';
import { parseWhen, localTz, addDays, localDate, zonedToUtc } from './tz.js';
import { reconnectNeeded, shortError, errorStatus } from './errors.js';
import { logger } from '../logger.js';
import { appDb } from '../v2/db.js';
import { ToolRefusal, type ToolContext } from '../tools/registry.js';
// a module cycle (the connectors' propose tools call into this file); only used inside functions, so it is safe
import { calendarClient, googleConfigured } from '../connectors/google.js';
import { graph, microsoftConfigured } from '../connectors/microsoft.js';
import { calendarAccountKey } from './calendar.js';
import { GRAPH_TIMEOUT_MS } from './outlook-calendar.js';
export { v2DraftsOn } from './flags.js';

export const DRAFT_ADDED = 'Added to your calendar as a draft. Confirm it in MWA.';
export const CONFIRM_RECEIPT = 'Added by your helper just now. No invites were sent.';
export const AFTER_READING_NOTE = 'Suggested after your helper read outside content (an email or a web page). Check it before you confirm.';
const ADDING_NOW = 'Adding it right now — try again in a moment.';

export class DraftError extends Error {
  /** transient: worth retrying with the same Idempotency-Key (a reconnect, a calendar being connected, a busy draft) */
  constructor(public status: number, public code: string, message: string, public transient = false) { super(message); }
}
const label = (p: CalProvider) => (p === 'google' ? 'Google Calendar' : 'Outlook');

/** What the person (or the helper) gave: title, start, end — ISO 8601, a local time, or a bare date (all day). */
export interface DraftInput {
  title: string; start: string; end?: string; allDay?: boolean; location?: string; notes?: string; provider?: CalProvider | null;
  projectId?: string | null; sourceItem?: string | null; createdByTry?: string | null; tz?: string;
  origin?: 'you' | 'helper'; suggestedAfterOutside?: boolean; originNote?: string | null;
}

export function draftFromInput(x: DraftInput): Parameters<typeof createDraft>[0] {
  const tz = x.tz || localTz();
  const title = String(x.title ?? '').replace(/\s+/g, ' ').trim();
  if (!title) throw new DraftError(400, 'bad_draft', 'A draft needs a title.');
  let s: { ms: number; dateOnly: boolean }, e: { ms: number; dateOnly: boolean } | null;
  try {
    s = parseWhen(String(x.start ?? ''), tz);
    e = x.end ? parseWhen(String(x.end), tz) : null;
  } catch { throw new DraftError(400, 'bad_draft', 'The start or end is not a real date and time I can read (use ISO 8601, like 2026-11-14T15:00).'); }
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
    origin: x.origin ?? 'helper', suggestedAfterOutside: !!x.suggestedAfterOutside, originNote: x.originNote ?? null,
  };
}

/** Create a draft, or hand back the open one with the same title and times (a repeated proposal is not a second draft). */
export function addDraft(x: DraftInput): { draft: CalDraftRow; existing: boolean } {
  const input = draftFromInput(x);
  const same = openDrafts().find((d) => d.title.toLowerCase() === input.title.toLowerCase()
    && Date.parse(d.start_utc) === input.startMs && Date.parse(d.end_utc) === input.endMs);
  if (same) {
    // the same proposal again, this time after outside reading: the draft says so (it never loses that mark)
    if (input.suggestedAfterOutside && !same.suggested_after_outside && same.origin === 'helper') {
      appDb().prepare('UPDATE cal_drafts SET suggested_after_outside = 1, origin_note = COALESCE(origin_note, ?) WHERE id = ?').run(input.originNote ?? AFTER_READING_NOTE, same.id);
      return { draft: updateDraft(same.id, {}), existing: true };
    }
    return { draft: same, existing: true };
  }
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

/** The propose_event / propose_outlook_event tools when drafts are on: a draft row with its provenance, a plain message. */
export function proposeDraft(provider: CalProvider, args: Record<string, unknown>, ctx?: Partial<ToolContext>): string {
  try {
    const tainted = !!ctx?.tainted;
    const { draft } = addDraft({
      title: String(args.summary ?? args.title ?? ''), start: String(args.start ?? ''), end: args.end ? String(args.end) : undefined,
      location: args.location ? String(args.location) : undefined, notes: args.description ? String(args.description) : undefined, provider,
      origin: 'helper', createdByTry: ctx?.runId ?? (ctx?.jobId ? `job:${ctx.jobId}` : null),
      suggestedAfterOutside: tainted, originNote: tainted ? AFTER_READING_NOTE : null,
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
  /** insert the event (no invitations), or find the one an earlier attempt made; return the provider's id */
  insert: (p: CalProvider, d: CalDraftRow) => Promise<string>;
  /** take an event MWA just made off the calendar again (no notifications) */
  remove: (p: CalProvider, providerId: string) => Promise<void>;
}

/** The event MWA made earlier for this draft was deleted in the calendar by the person. */
export class DeletedInCalendar extends Error {}

/** Google event ids are base32hex (a–v, 0–9), 5–1024 chars: a hash of the draft id fits and never collides with ours. */
export function googleEventIdFor(draftId: string): string {
  return `mcal${createHash('sha256').update(draftId).digest('hex').slice(0, 40)}`;
}

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
    if (errorStatus(e) !== 409) throw e;
    // the id is taken: an earlier confirm got it in (and died before recording it) — the same event, not a second one.
    // Unless the person has since deleted it in Google (a deleted event keeps its id, status 'cancelled').
    const g = await cal.events.get({ calendarId: 'primary', eventId: id });
    if (g.data.status === 'cancelled') throw new DeletedInCalendar('deleted in Google Calendar');
    return g.data.id ?? id;
  }
}

/** The extended property an Outlook event made by MWA carries: the draft it came from. */
export const OUTLOOK_DRAFT_PROP = 'String {6b0f5c2e-8a51-4d3c-9f1e-2a7d4c6b9e10} Name mwaDraft';

async function findOutlookEvent(draftId: string): Promise<string | null> {
  const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${OUTLOOK_DRAFT_PROP}' and ep/value eq '${draftId.replace(/'/g, "''")}')`;
  const r = await graph(`/me/events?$filter=${encodeURIComponent(filter)}&$select=id&$top=1`, { signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) });
  const hit = (r?.value ?? [])[0];
  return hit?.id ? String(hit.id) : null;
}

async function insertOutlook(d: CalDraftRow): Promise<string> {
  // an earlier attempt may have got it in before dying: find it by the draft id it carries, add only if it is not there
  const existing = await findOutlookEvent(d.id);
  if (existing) return existing;
  const tz = d.tz || 'UTC';
  const wallUtc = (utc: string) => utc.replace(/Z$/, '');
  const when = (utc: string) => d.all_day ? { dateTime: `${localDate(Date.parse(utc), tz)}T00:00:00`, timeZone: tz } : { dateTime: wallUtc(utc), timeZone: 'UTC' };
  const e = await graph('/me/events', {
    method: 'POST', signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    body: JSON.stringify({
      subject: d.title, body: { contentType: 'Text', content: d.notes ?? '' }, ...(d.location ? { location: { displayName: d.location } } : {}),
      start: when(d.start_utc), end: when(d.end_utc), isAllDay: d.all_day === 1,
      singleValueExtendedProperties: [{ id: OUTLOOK_DRAFT_PROP, value: d.id }],
      transactionId: d.id, // sent as well; not relied on
    }),
  });
  return String(e.id);
}

async function removeEvent(p: CalProvider, providerId: string): Promise<void> {
  if (p === 'google') {
    const cal = await calendarClient();
    await cal.events.delete({ calendarId: 'primary', eventId: providerId, sendUpdates: 'none' });
  } else {
    await graph(`/me/events/${encodeURIComponent(providerId)}`, { method: 'DELETE', signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) });
  }
}

/** The real connectors (exported so a test can wrap them). */
export const DEFAULT_PROVIDERS: DraftProviders = {
  connected: (p) => (p === 'google' ? googleConfigured() : microsoftConfigured()),
  insert: (p, d) => (p === 'google' ? insertGoogle(d) : insertOutlook(d)),
  remove: removeEvent,
};
let providers: DraftProviders = DEFAULT_PROVIDERS;
/** Tests: replace parts; null restores the real connectors. */
export function setDraftProviders(p: Partial<DraftProviders> | null): void { providers = p ? { ...providers, ...p } : DEFAULT_PROVIDERS; }

export interface ConfirmResult { draft: CalDraftRow; message: string; already: boolean }

export async function confirmDraft(id: string, opts: { provider?: CalProvider } = {}): Promise<ConfirmResult> {
  const lease = takeConfirmLease(id);
  if (!lease.ok) {
    if (lease.why === 'missing') throw new DraftError(404, 'not_found', 'No such draft.');
    if (lease.why === 'confirmed') return { draft: lease.draft!, message: 'It is already on your calendar. Nothing new was added.', already: true };
    if (lease.why === 'removed') throw new DraftError(409, 'removed', 'That draft was removed.');
    throw new DraftError(409, 'in_progress', ADDING_NOW, true);
  }
  const { draft, token } = lease;
  const order: CalProvider[] = opts.provider ? [opts.provider] : draft.provider ? [draft.provider] : ['google', 'outlook'];
  const provider = order.find((p) => providers.connected(p));
  if (!provider) {
    releaseConfirmLease(id, token);
    const want = opts.provider ?? draft.provider;
    throw new DraftError(409, 'no_calendar', want
      ? `${label(want)} is not connected. Connect it, or download the .ics file instead.`
      : 'No calendar is connected. Connect one, or download the .ics file instead.', true);
  }
  let account: string = provider;
  try { account = calendarAccountKey(provider); } catch { /* the bare provider key */ }
  let providerId: string;
  try {
    providerId = await providers.insert(provider, draft);
  } catch (e) {
    if (e instanceof DeletedInCalendar) {
      // its id can never be used again in Google: the draft is done; a new draft can be made if it is still wanted
      updateDraft(id, { state: 'removed', confirm_lease: null, confirm_token: null });
      throw new DraftError(409, 'deleted_in_calendar', `It was added to ${label(provider)} earlier and then deleted there, so I didn't add it again. Make a new draft if you still want it.`);
    }
    releaseConfirmLease(id, token);
    if (reconnectNeeded(e)) {
      try { setSyncState(account, 'calendar', { needs_reconnect: 1, last_error: shortError(e) }); } catch { /* best-effort */ }
      throw new DraftError(409, 'needs_reconnect', `${provider === 'google' ? 'Google' : 'Outlook'} needs you to sign in again before I can add it.`, true);
    }
    logger.warn('calendar', 'confirm failed', { provider, error: shortError(e) });
    throw new DraftError(502, 'calendar_error', `${label(provider)} did not take it: ${shortError(e)}`, true);
  }
  const rec = recordConfirmed(id, token, provider, providerId, account);
  if (rec.ok) return { draft: rec.draft, message: CONFIRM_RECEIPT, already: false };
  if (rec.why === 'removed') {
    // the person removed it while it was being added: take it off the calendar again (see the header)
    let undone = true, why = '';
    try { await providers.remove(provider, providerId); } catch (e) { undone = false; why = shortError(e); }
    if (undone) {
      logger.info('calendar', 'confirm landed after remove; event deleted again', { draft: id, provider });
      throw new DraftError(409, 'removed', `You removed it while it was being added, so I took it off ${label(provider)} again. Nothing is left there.`);
    }
    updateDraft(id, { orphan_provider_id: providerId, provider, account });
    logger.warn('calendar', 'confirm landed after remove; could not delete it', { draft: id, provider, error: why });
    throw new DraftError(409, 'removed_but_added', `You removed it while it was being added, and it reached ${label(provider)} before I could stop it. I couldn't take it off: please delete "${rec.draft?.title ?? 'it'}" there.`);
  }
  // someone else's takeover recorded it (or will): the event is the same one, made idempotently
  const now = getDraft(id);
  if (now?.state === 'confirmed') return { draft: now, message: CONFIRM_RECEIPT, already: true };
  throw new DraftError(409, 'in_progress', ADDING_NOW, true);
}

export function removeDraft(id: string, now = Date.now()): { draft: CalDraftRow; message: string } {
  const d = getDraft(id);
  if (!d) throw new DraftError(404, 'not_found', 'No such draft.');
  if (d.state === 'removed') return { draft: d, message: 'Removed.' };
  if (d.state === 'confirmed') throw new DraftError(409, 'confirmed', 'It is already on your calendar. Remove it there.');
  if (d.confirm_lease) {
    // a confirm holds it. A lease older than CONFIRM_LEASE_MS is a dead process's (every call it could be waiting on
    // has timed out by then); clear it and carry on. Otherwise: wait.
    if (now - d.confirm_lease < CONFIRM_LEASE_MS) throw new DraftError(409, 'in_progress', ADDING_NOW, true);
  }
  return { draft: updateDraft(id, { state: 'removed', confirm_lease: null, confirm_token: null }), message: 'Removed. Nothing was added to your calendar.' };
}
