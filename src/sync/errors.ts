/**
 * Telling "sign in again" apart from "try later" (v2 build, slice A7; mail sync in A8 can use the same).
 *
 * Reconnect: the refresh token was revoked or expired (OAuth `invalid_grant`, from google-auth-library as a
 * GaxiosError whose response data says so, or from the Outlook token refresh), a 401 after refreshing, a 403 for a
 * permission the sign-in does not carry (e.g. an Outlook sign-in from before Calendars.Read was asked for), or no
 * token at all. Everything else (5xx, network, 429) is transient: keep the cache and try at the next tick.
 */

export function errorStatus(err: unknown): number | undefined {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: number } };
  const n = Number(e?.response?.status ?? e?.status ?? e?.code);
  return Number.isFinite(n) && n >= 100 && n < 600 ? n : undefined;
}

export function reconnectNeeded(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; response?: { data?: { error?: unknown } } };
  const data = e?.response?.data?.error;
  const msg = String(e?.message ?? err ?? '');
  if (e?.code === 'invalid_grant' || data === 'invalid_grant' || /invalid_grant/i.test(msg)) return true;
  if (/not connected/i.test(msg)) return true;
  const s = errorStatus(err);
  // Google answers rate limits with 403 too (rateLimitExceeded, userRateLimitExceeded, quotaExceeded): transient
  if (s === 403 && /rate ?limit|quota|usage limit/i.test(msg)) return false;
  return s === 401 || s === 403;
}

/** One line for last_error: no tokens, no long bodies. */
export function shortError(err: unknown): string {
  const msg = String((err as { message?: unknown })?.message ?? err ?? 'error');
  return msg.replace(/Bearer\s+\S+/gi, 'Bearer …').replace(/\s+/g, ' ').trim().slice(0, 200);
}
