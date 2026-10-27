/**
 * Signing in with the password — one path for POST /api/v1/session and the legacy POST /api/login (W5 security review,
 * finding 1: the legacy route had no throttle at all and led to the same session). Every attempt goes through the
 * sign-in gate (gate.ts: per-source waits that grow with failures, never a refusal of the right password); a success
 * starts a session with its own record (sessions.ts).
 */
import type { IncomingMessage } from 'node:http';
import { signInGate } from './gate.js';
import { sourceOf } from './trust.js';
import { cookieSecure } from './trust.js';
import { issueSession, SESSION_COOKIE, SESSION_MS } from './sessions.js';

export function sessionCookie(req: IncomingMessage, token: string, maxAgeS = Math.round(SESSION_MS / 1000)): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeS}${cookieSecure(req) ? '; Secure' : ''}`;
}

/** Check a password for this request's source. Resolves with the Set-Cookie value on success, null on a wrong one. */
export function signInWithPassword(req: IncomingMessage, password: string, check: (pw: string) => boolean, via = 'password'): Promise<string | null> {
  return signInGate.attempt(sourceOf(req), () => {
    const ok = typeof password === 'string' && password.length > 0 && password.length <= 1000 && check(password);
    return { ok, value: ok ? sessionCookie(req, issueSession(via).token) : null };
  });
}
