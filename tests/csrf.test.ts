/**
 * CSRF guard (sameOriginOk) unit tests — the defense now applied to /api/chat, the approval confirm/
 * cancel, /api/questions, /api/stepup/*, and /api/open (gap analysis 2026-07, safety C1/C3/C4/M1).
 */
import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { sameOriginOk } from '../src/serve.js';

const req = (headers: Record<string, string>) => ({ headers } as unknown as IncomingMessage);

describe('sameOriginOk (CSRF guard)', () => {
  it('allows Sec-Fetch-Site: same-origin', () => {
    expect(sameOriginOk(req({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
  });
  it('BLOCKS Sec-Fetch-Site: cross-site (the attack)', () => {
    expect(sameOriginOk(req({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });
  it('BLOCKS Sec-Fetch-Site: same-site (different subdomain)', () => {
    expect(sameOriginOk(req({ 'sec-fetch-site': 'same-site' }))).toBe(false);
  });
  it('allows direct navigation (Sec-Fetch-Site: none)', () => {
    expect(sameOriginOk(req({ 'sec-fetch-site': 'none' }))).toBe(true);
  });
  it('falls back to Origin host == Host (same → allow)', () => {
    expect(sameOriginOk(req({ origin: 'http://127.0.0.1:7788', host: '127.0.0.1:7788' }))).toBe(true);
  });
  it('falls back to Origin host == Host (different → block)', () => {
    expect(sameOriginOk(req({ origin: 'http://evil.example', host: '127.0.0.1:7788' }))).toBe(false);
  });
  it('allows non-browser requests with no Origin/Sec-Fetch-Site (curl/server)', () => {
    expect(sameOriginOk(req({ host: '127.0.0.1:7788' }))).toBe(true);
  });
});
