/**
 * CSRF guard (sameOriginOk) unit tests — the defense now applied to /api/chat, the approval confirm/
 * cancel, /api/questions, /api/stepup/*, and /api/open (gap analysis 2026-07, safety C1/C3/C4/M1).
 */
import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { sameOriginOk, readBody } from '../src/serve.js';

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

describe('readBody — UTF-8 integrity across chunk boundaries', () => {
  async function* chunked(buf: Buffer, at: number): AsyncGenerator<Buffer> {
    yield buf.subarray(0, at); yield buf.subarray(at);
  }
  it('decodes a multi-byte char split across two chunks (e.g. a big onboarding save)', async () => {
    // Content with an em-dash, smart quotes, accent, and emoji — the kind of thing in real docs.
    const body = Buffer.from(JSON.stringify({ memories: [{ concept: 'Rule — pay', content: 'Verify “amount” at café 🚀 — always.' }] }), 'utf8');
    const emDashStart = body.indexOf(0xe2); // first byte of the em-dash (E2 80 94)
    const out = await readBody(chunked(body, emDashStart + 1)); // split INSIDE the em-dash
    expect(out.memories[0].concept).toBe('Rule — pay');
    expect(out.memories[0].content).toBe('Verify “amount” at café 🚀 — always.');
    expect(JSON.stringify(out)).not.toContain('�'); // no replacement char
  });
  it('handles an empty/invalid body gracefully', async () => {
    async function* one(b: Buffer) { yield b; }
    expect(await readBody(one(Buffer.from('')))).toEqual({});
    expect(await readBody(one(Buffer.from('not json')))).toEqual({});
  });
});
