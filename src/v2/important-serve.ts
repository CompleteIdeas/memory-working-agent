/**
 * The Important list in the running server (v2 slice A9): what triage needs from serve, and when it runs.
 *
 *   - after every mail sync: sort the new mail (rules › deterministic skips › known contacts › the background model
 *     within the daily budget) and rebuild the list;
 *   - after every calendar refresh: rebuild (double-bookings), no model;
 *   - every minute: rebuild the derived sources (job results, approvals, reconnects) — cheap, no model, and an
 *     unchanged item writes nothing.
 * With no model configured, mail is sorted by the person's rules and the deterministic signals only.
 */
import { MwaMemory } from '../awm.js';
import { logger } from '../logger.js';
import { onMailSynced } from '../sync/mail.js';
import { onCalendarSynced, calendarTz } from '../sync/calendar.js';
import { listPendingActions } from '../tools/approval.js';
import { setImportantRouteDeps } from '../api/routes/important.js';
import { refreshImportant, rebuildItems, setTriageDeps } from './triage.js';

const CONTACTS_TTL_MS = 30 * 60_000;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Addresses in the person's people notes (AWM person profiles), cached for half an hour. */
function contactsFrom(memory: () => MwaMemory): () => Promise<Set<string>> {
  let cache: { at: number; set: Set<string> } | null = null;
  return async () => {
    if (cache && Date.now() - cache.at < CONTACTS_TTL_MS) return cache.set;
    const set = new Set<string>();
    const m = memory();
    try {
      for (const p of (await m.listPeople()).slice(0, 200)) {
        if (p.personId.includes('@')) set.add(p.personId.toLowerCase());
        for (const n of await m.recallPersonProfile(p.personId, 40)) for (const a of n.content.match(EMAIL) ?? []) set.add(a.toLowerCase());
      }
    } catch (e) { logger.warn('triage', 'known contacts: memory not readable', { error: (e as Error).message.slice(0, 120) }); }
    finally { try { m.close(); } catch { /* closed */ } }
    cache = { at: Date.now(), set };
    return set;
  };
}

export function startImportant(o: { memory: () => MwaMemory; running: () => Set<string>; everyMs?: number }): () => void {
  setTriageDeps({ tz: () => calendarTz(), running: o.running, pendingApprovals: () => listPendingActions(), knownContacts: contactsFrom(o.memory) });
  setImportantRouteDeps({
    // a reminder is delivered as written (no run), and marked as coming from outside content
    remind: async (text, at) => {
      const m = o.memory();
      try { return await m.addScheduledTask(text, at, { kind: 'reminder', tainted: true }); } finally { m.close(); }
    },
  });
  const run = (mail: boolean) => { void refreshImportant({ mail }).catch((e) => logger.warn('triage', 'refresh failed', { error: (e as Error).message.slice(0, 200) })); };
  const offMail = onMailSynced(() => run(true));
  const offCal = onCalendarSynced(() => run(false));
  const timer = setInterval(() => { try { rebuildItems(); } catch { /* the database is busy: next minute */ } }, o.everyMs ?? 60_000);
  timer.unref?.();
  return () => { offMail(); offCal(); clearInterval(timer); };
}
