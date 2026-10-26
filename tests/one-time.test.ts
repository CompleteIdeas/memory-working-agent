/**
 * Pending list 2026-10-26, 4c: one-time codes and sign-in / reset links in outside content are hidden before the
 * model reads them (Muse does; MWA hid only saved vault values).
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripOneTimeSecrets, stripCodesOn } from '../src/tools/one-time.js';
import { runAgent } from '../src/agent.js';
import { MwaMemory } from '../src/awm.js';

describe('a run hides what arrives in outside content, not what is on this machine', () => {
  it('the model sees the placeholder, never the code, from a page or an email; a local file is left as written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-onetime-'));
    const mem = new MwaMemory('onetime', join(dir, 'm.db'));
    vi.stubEnv('MWA_FAST_CHAT', '0');
    const seen: string[] = []; // every model input, flattened
    const names = ['http_request', 'read_file'];
    const tools = {
      defs: () => names.map((name) => ({ name, description: 'x', parameters: { type: 'object', properties: {} } })),
      has: (n: string) => names.includes(n),
      callDetailed: async (n: string) => ({ text: n === 'http_request' ? 'Subject: Your sign-in code\n\nYour verification code is 482913. Or use https://portal.example/signin/verify?t=pQ8sR2tU4vW6xY8zA0bC2d' : 'notes.md: the door code is 482913 (my own file)', failed: false }),
      call: async () => 'ok',
    };
    let n = 0;
    const brain = { id: 'b', model: 'b', price: [0, 0] as [number, number], chat: async (input: { system?: string; messages: { content: unknown }[] }) => {
      const sys = String(input.system ?? ''); if (!sys.includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      seen.push(sys + '\n' + input.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n'));
      n++;
      if (n === 1) return { text: JSON.stringify({ action: 'http_request', url: 'https://portal.example/mail/1' }), usage: { input: 1, output: 1 } };
      if (n === 2) return { text: JSON.stringify({ action: 'read_file', path: 'notes.md' }), usage: { input: 1, output: 1 } };
      return { text: JSON.stringify({ action: 'done', summary: 'read both', outcome: 'no-change' }), usage: { input: 1, output: 1 } };
    } };
    try {
      const r = await runAgent({ instruction: 'Read the sign-in email and my notes', dir, memory: mem, brain: brain as never, worker: brain as never, tools: tools as never, interactive: true, plan: false, budget: { maxSteps: 6, maxWallMs: 30_000 } } as never);
      const all = seen.join('\n');
      expect(all).toContain('‹one-time code hidden›');
      expect(all).toContain('‹one-time link hidden: portal.example›');
      expect(all).not.toContain('pQ8sR2tU4vW6xY8zA0bC2d');
      expect(all).toContain('the door code is 482913 (my own file)'); // local content untouched
      expect(all.split('482913').length - 1).toBe(1); // the email's code never reached the model
      expect(r.history.join('\n')).toMatch(/hid 1 one-time code and 1 sign-in\/reset link in http_request's result/);
    } finally { vi.unstubAllEnvs(); mem.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});

describe('stripOneTimeSecrets', () => {
  it('hides a verification code that words announce, either side of it', () => {
    for (const [s, hidden] of [
      ['Your verification code is 482913. It expires in 10 minutes.', '482913'],
      ['Your one-time passcode: 482 913', '482 913'],
      ['Use code 48291 to sign in.', '48291'],
      ['482913 is your Fox Run security code', '482913'],
      ['Two-factor authentication code: K7X9QZ', 'K7X9QZ'],
      ['Enter this PIN to confirm: 7731', '7731'],
    ] as const) {
      const r = stripOneTimeSecrets(s);
      expect([s, r.codes]).toEqual([s, 1]);
      expect(r.text).not.toContain(hidden);
      expect(r.text).toContain('‹one-time code hidden›');
    }
  });
  it('leaves ordinary numbers alone: years, order numbers, prices, a phone, a date, a page with no code words', () => {
    for (const s of [
      'Entries close Nov 13 2026; the fee is $45 and the order number is 884412.',
      'Call 555-0100 or see page 12 of the 2025 rulebook.',
      'Fox Run results: Tessa 3rd with 29.4 penalties, dressage 28.1.',
      'Your order #1203 ships Monday. Account 4471 is in good standing.',
      'The code for the new feature is in src/agent.ts line 2155.',
      // audit 2026-10-26: the pages MWA is used for — a menu's "Sign in", event and member numbers, ZIP codes
      'Sign in | Register\nEvent 18969 Fox Run Horse Trials',
      '[1] link "Log in"\n[2] link "USEF 341980"',
      'Access 2024 results for event 18969',
      'Your confirmation number is 884412.',
      'ZIP code 20147, area code 703',
      'Booking confirmation code: ABC123',
      'PLEASE ENTER YOUR VERIFICATION CODE on the next page',
      'Promo code SUMMER26 gives 10% off; the discount code is 2026SALE',
      'Flight confirmation code: K7X9QZ for the 06:40 to Lexington',
      'Your confirmation number is 48291733.',
      'Sign in to see your dressage score: 1234 and the entry 20147',
      '1200 Main St, Lexington KY 40511 — call 800 555 0100 to access the barn',
      'SECURITY NOTICE: CONTINUE AT YOUR OWN RISK',
      'Error code 500123 from the server; HTTP status code 404',
    ]) {
      const r = stripOneTimeSecrets(s);
      expect([s, r.codes, r.links]).toEqual([s, 0, 0]);
      expect(r.text).toBe(s);
    }
  });
  it('hides the other shapes a code takes: dashes, spaced pairs, a letter prefix', () => {
    for (const [s, hidden] of [
      ['Your verification code: 4821-9937', '4821-9937'],
      ['One-time passcode 48 29 13 expires in 5 minutes', '48 29 13'],
      ['G-482913 is your Google verification code', 'G-482913'],
      ['Your Apple ID code is: 123456. Do not share it.', '123456'],
      ['Your code: x7k9q2', 'x7k9q2'],
      ['Steam Guard code: F8K2Q', 'F8K2Q'],
      ['Enter the verification code 4 8 2 9 1 3 to continue', '4 8 2 9 1 3'],
    ] as const) {
      const r = stripOneTimeSecrets(s);
      expect([s, r.codes]).toEqual([s, 1]);
      expect(r.text).not.toContain(hidden);
    }
  });
  it('is linear on a long hostile URL and leaves file paths and campaign names alone', () => {
    const hostile = `https://e.com/${'auth/'.repeat(8_000)}`;
    const t0 = Date.now();
    const r = stripOneTimeSecrets(`see ${hostile} now`);
    expect(Date.now() - t0).toBeLessThan(200);
    expect(r.links).toBe(0);
    for (const s of [
      'https://github.com/CompleteIdeas/mwa/blob/master/src/auth/magic-link-settings-page.ts',
      'https://shop.example/invite-friends/campaign_summer_2026_promo',
      'https://portal.example.com/login',
      'https://www.npr.org/2026/10/26/election-results-confirmed-by-state-officials',
      'https://www.npr.org/authors/jane-doe-and-somebody-else-writes-here',
      'Page: Entries — https://www.useventing.com/login?returnUrl=/events/foxrun2026results',
    ]) expect([s, stripOneTimeSecrets(s).links]).toEqual([s, 0]);
    expect(stripOneTimeSecrets('https://accounts.example.com/reset/3f9a2c7b1d4e5f6a8b9c0d1e2f3a4b5c').links).toBe(1); // a hex token
  });
  it('hides a reset or sign-in link that carries a token, keeping the host, and leaves plain links', () => {
    const reset = 'Reset your password: https://accounts.example.com/reset?token=Zx9kq2LmP0aQ7vTbR4sWe1 — the link expires in an hour.';
    const r = stripOneTimeSecrets(reset);
    expect(r.links).toBe(1);
    expect(r.text).toContain('‹one-time link hidden: accounts.example.com›');
    expect(r.text).not.toContain('Zx9kq2LmP0aQ7vTbR4sWe1');
    const magic = 'Sign in with this link: https://app.example.org/auth/magic/aB3dE6fG9hJ2kL5mN8pQ';
    expect(stripOneTimeSecrets(magic).links).toBe(1);
    const plain = 'Results: https://www.useventing.com/results/fox-run-2026 and the login page https://portal.example.com/login';
    const p = stripOneTimeSecrets(plain);
    expect([p.links, p.codes]).toEqual([0, 0]);
    expect(p.text).toBe(plain);
  });
  it('an email with both: the code and the link go, the message stays readable', () => {
    const mail = 'From: no-reply@portal.example\nSubject: Your sign-in code\n\nYour sign-in code is 220 417. Or use https://portal.example/signin/verify?t=pQ8sR2tU4vW6xY8zA0bC2d (valid 15 minutes). Questions? Call 555-0100.';
    const r = stripOneTimeSecrets(mail);
    expect([r.codes, r.links]).toEqual([1, 1]);
    expect(r.text).toContain('Your sign-in code is ‹one-time code hidden›.');
    expect(r.text).toContain('555-0100');
  });
  it('is on unless MWA_STRIP_CODES=0', () => {
    expect(stripCodesOn({})).toBe(true);
    expect(stripCodesOn({ MWA_STRIP_CODES: '0' })).toBe(false);
    expect(stripCodesOn({ MWA_STRIP_CODES: '1' })).toBe(true);
  });
});
