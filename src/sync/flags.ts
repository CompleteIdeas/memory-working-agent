/**
 * One way to read an on/off setting (review of A7: MWA_V2_DRAFTS and MWA_CALENDAR_SYNC were parsed two different
 * ways). Off: 0, false, off, no. On: 1, true, on, yes. Anything else, or unset: the default. Case and spaces ignored.
 */
export function flagOn(value: string | undefined | null, dflt: boolean): boolean {
  const v = String(value ?? '').trim().toLowerCase();
  if (/^(0|false|off|no)$/.test(v)) return false;
  if (/^(1|true|on|yes)$/.test(v)) return true;
  return dflt;
}

/** MWA-held calendar drafts (v2 A7): on unless turned off. */
export const v2DraftsOn = (env: Record<string, string | undefined> = process.env): boolean => flagOn(env.MWA_V2_DRAFTS, true);
/** The 30-minute calendar sync in serve: on unless turned off. */
export const calendarSyncOn = (env: Record<string, string | undefined> = process.env): boolean => flagOn(env.MWA_CALENDAR_SYNC, true);
/** The 15-minute mail header sync in serve (A8): on unless turned off. */
export const mailSyncOn = (env: Record<string, string | undefined> = process.env): boolean => flagOn(env.MWA_MAIL_SYNC, true);
