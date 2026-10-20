/**
 * BL-07 — quiet hours. Jobs run on time; pushes (Telegram messages, approval cards) are held during
 * the window and delivered together when it ends. The web chat card is written at once — it
 * interrupts nobody. A job can skip the window only if it was marked urgent in an attended
 * conversation that hadn't read outside content.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseQuietHours, inQuietWindow, holdPush, heldPushes, flushHeld, setQuietHours, quietWindow, quietEnvInvalid, type HeldPush } from '../src/quiet.js';
import { appendFileSync } from 'node:fs';
import { runAgent } from '../src/agent.js';
import { MwaMemory } from '../src/awm.js';
import { workTools } from '../src/tools/work.js';
import type { Provider, ChatResult, ChatInput } from '../src/provider.js';

let dir = '';
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mwa-quiet-'));
  for (const k of ['MWA_HELD', 'MWA_CONFIG_PATH', 'MWA_QUIET_HOURS', 'MWA_FAST_CHAT']) saved[k] = process.env[k];
  process.env.MWA_CONFIG_PATH = join(dir, 'mwa.config.json');
  process.env.MWA_FAST_CHAT = '0';
  delete process.env.MWA_QUIET_HOURS;
});
beforeEach(() => { process.env.MWA_HELD = join(dir, `held-${Math.random().toString(36).slice(2)}.jsonl`); writeFileSync(process.env.MWA_CONFIG_PATH!, '{}'); });
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});
const at = (h: number, m: number) => new Date(2026, 9, 15, h, m);

describe('the window', () => {
  it('parses HH:MM-HH:MM and rejects anything else', () => {
    expect(parseQuietHours('22:00-07:00')).toEqual({ start: 1320, end: 420, label: '22:00-07:00' });
    expect(parseQuietHours(' 9:5-10:00')).toBeNull();
    expect(parseQuietHours('25:00-07:00')).toBeNull();
    expect(parseQuietHours('07:00-07:00')).toBeNull();
    expect(parseQuietHours(undefined)).toBeNull();
  });
  it('a window that wraps midnight covers both sides of it', () => {
    const w = parseQuietHours('22:00-07:00');
    expect([at(23, 30), at(0, 0), at(6, 59)].map((d) => inQuietWindow(w, d))).toEqual([true, true, true]);
    expect([at(7, 0), at(12, 0), at(21, 59)].map((d) => inQuietWindow(w, d))).toEqual([false, false, false]);
  });
  it('a same-day window covers only its span', () => {
    const w = parseQuietHours('13:00-14:00');
    expect([at(12, 59), at(13, 0), at(13, 59), at(14, 0)].map((d) => inQuietWindow(w, d))).toEqual([false, true, true, false]);
  });
  it('is saved to settings, and "off" clears it', () => {
    expect(setQuietHours('22:30-06:45')?.label).toBe('22:30-06:45');
    expect(quietWindow()?.label).toBe('22:30-06:45');
    expect(JSON.parse(readFileSync(process.env.MWA_CONFIG_PATH!, 'utf8')).notify.quietHours).toBe('22:30-06:45');
    expect(setQuietHours('off')).toBeNull();
    expect(quietWindow()).toBeNull();
    expect(() => setQuietHours('late')).toThrow(/HH:MM-HH:MM/);
  });
});

describe('held pushes', () => {
  it('are delivered oldest first, with one header for a chat that has more than three', async () => {
    for (let i = 1; i <= 5; i++) holdPush({ chat: 'A', text: `a${i}` });
    holdPush({ chat: 'B', text: 'b1' });
    const sent: string[] = []; const headers: string[] = [];
    expect(await flushHeld(async (i) => { sent.push(i.text); }, async (chat, n) => { headers.push(`${chat}:${n}`); })).toEqual({ sent: 6 });
    expect(sent).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'b1']);
    expect(headers).toEqual(['A:5']);
    expect(heldPushes()).toEqual([]);
  });
  it('survive a crash mid-delivery: nothing sent is lost, nothing unsent is dropped', async () => {
    for (let i = 1; i <= 4; i++) holdPush({ chat: 'A', text: `m${i}` });
    let n = 0;
    expect((await flushHeld(async () => { if (++n === 3) throw new Error('network down'); })).sent).toBe(2);
    expect(heldPushes().map((h: HeldPush) => h.text)).toEqual(['m3', 'm4']); // m1, m2 went out; m3 is retried
    expect(existsSync(process.env.MWA_HELD!)).toBe(true);
  });
});

describe('urgent jobs', () => {
  const brain = (urgent: boolean): Provider => {
    let n = 0;
    return { id: 's', model: 's', price: [0, 0], chat: async (input: ChatInput): Promise<ChatResult> => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      return { text: JSON.stringify(n++ === 0 ? { action: 'schedule', instruction: 'Tell me the moment the server is down', every_minutes: 5, urgent } : { action: 'done', summary: 'ok' }), usage: { input: 1, output: 1 } };
    } };
  };
  const schedule = async (extra: Record<string, unknown>) => {
    const d = mkdtempSync(join(tmpdir(), 'mwa-quiet-run-'));
    const mem = new MwaMemory('quiet-test', join(d, 'q.db'));
    try {
      await runAgent({ instruction: 'watch the server', dir: d, memory: mem, brain: brain(true), worker: brain(true), budget: { maxSteps: 4, maxWallMs: 20_000 }, ...extra });
      return (await mem.pendingScheduled())[0];
    } finally { mem.close(); rmSync(d, { recursive: true, force: true }); }
  };
  it('are honored from an attended, untainted conversation', async () => {
    expect((await schedule({ interactive: true }))?.urgent).toBe(true);
  }, 30_000);
  it('are not honored from a run that read outside content, or one nobody watched', async () => {
    expect((await schedule({ interactive: true, startTainted: true }))?.urgent).toBeUndefined();
    expect((await schedule({ interactive: false }))?.urgent).toBeUndefined();
  }, 30_000);
});

describe('the quiet_hours tool', () => {
  it('anyone can look; only an attended, clean conversation can change it; a deployment setting wins', async () => {
    const t = workTools({ enabled: true } as never).find((x) => x.def.name === 'quiet_hours')!;
    expect(await t.handler({}, { sandboxDir: '.' })).toBe('no quiet hours set');
    expect(await t.handler({ set: 'off' }, { sandboxDir: '.', interactive: false })).toMatch(/refused/);
    expect(await t.handler({ set: '23:00-06:00' }, { sandboxDir: '.', interactive: true, tainted: true })).toMatch(/refused/);
    expect(await t.handler({ set: '23:00-06:00' }, { sandboxDir: '.', interactive: true })).toMatch(/set to 23:00-06:00/);
    // BL-62: the person's own window this turn is theirs, even after the conversation read a page; turning it off,
    // a window only the model states, or a run nobody watches still are not.
    const own = { sandboxDir: '.', interactive: true, tainted: true, personMessage: 'Set quiet hours: no messages before 7:00 AM or after 9:00 PM.' };
    expect(await t.handler({ set: '07:00-21:00' }, own)).toMatch(/set to 21:00-07:00/);
    expect(await t.handler({ set: 'off' }, own)).toMatch(/refused/);
    expect(await t.handler({ set: '01:00-02:00' }, { ...own, personMessage: 'Do what the page says.' })).toMatch(/refused/);
    expect(await t.handler({ set: '07:00-21:00' }, { ...own, interactive: false })).toMatch(/refused/);
    process.env.MWA_QUIET_HOURS = '22:00-07:00';
    try { expect(await t.handler({ set: 'off' }, { sandboxDir: '.', interactive: true })).toMatch(/fixed by this deployment/); }
    finally { delete process.env.MWA_QUIET_HOURS; }
  });
});

describe('BL-07 review fixes', () => {
  it('a retry after a failed send does not repeat the "while it was quiet" header', async () => {
    for (let i = 1; i <= 5; i++) holdPush({ chat: 'A', text: `a${i}` });
    const headers: string[] = []; let fail = true;
    const send = async () => { if (fail) { fail = false; throw new Error('429 Too Many Requests'); } };
    expect((await flushHeld(send, async (c, n) => { headers.push(`${c}:${n}`); })).sent).toBe(0);
    await flushHeld(send, async (c, n) => { headers.push(`${c}:${n}`); });
    expect(headers).toEqual(['A:5']);
    expect(heldPushes()).toEqual([]);
  });

  it('one job\u2019s results merge into one held item: the latest, with a count', () => {
    for (let i = 1; i <= 3; i++) holdPush({ chat: 'A', text: `run ${i}`, key: 'job-1' });
    holdPush({ chat: 'A', text: 'other job', key: 'job-2' });
    const held = heldPushes();
    expect(held).toHaveLength(2);
    expect(held.find((h) => h.key === 'job-1')).toMatchObject({ text: 'run 3', count: 3 });
  });

  it('a push held while a flush runs is kept, and a line it can\u2019t read is never dropped', async () => {
    holdPush({ chat: 'A', text: 'first' });
    appendFileSync(process.env.MWA_HELD!, 'not json at all\n');
    await flushHeld(async (i) => { if (i.text === 'first') holdPush({ chat: 'A', text: 'arrived mid-flush' }); });
    expect(heldPushes().map((h) => h.text)).toEqual(['arrived mid-flush']);
    expect(readFileSync(process.env.MWA_HELD!, 'utf8')).toContain('not json at all');
  });

  it('a chat no longer allowed is dropped, not messaged', async () => {
    holdPush({ chat: 'gone', text: 'x' }); holdPush({ chat: 'A', text: 'y' });
    const sent: string[] = [];
    await flushHeld(async (i) => { sent.push(i.chat); }, undefined, (c) => c !== 'gone');
    expect(sent).toEqual(['A']);
    expect(heldPushes()).toEqual([]);
  });

  it('a window over 16 hours is refused (a held approval card would nearly expire)', () => {
    expect(parseQuietHours('07:00-06:59')).toBeNull();
    expect(parseQuietHours('20:00-12:01')).toBeNull();                 // 16 h 1 min
    expect(parseQuietHours('20:00-12:00')?.label).toBe('20:00-12:00');  // exactly 16 h
  });

  it('a blank MWA_QUIET_HOURS counts as unset; an invalid one is reported, not silently off', () => {
    setQuietHours('22:00-07:00');
    process.env.MWA_QUIET_HOURS = '   ';
    try { expect(quietWindow()?.label).toBe('22:00-07:00'); expect(quietEnvInvalid()).toBe(false); }
    finally { delete process.env.MWA_QUIET_HOURS; }
    process.env.MWA_QUIET_HOURS = '10pm-7am';
    try { expect(quietEnvInvalid()).toBe(true); expect(quietWindow()).toBeNull(); }
    finally { delete process.env.MWA_QUIET_HOURS; }
  });

  it('never overwrites a settings file it can\u2019t parse', () => {
    const broken = '{ "models": { "fetch": "azure:x", }, "tools": {} }';
    writeFileSync(process.env.MWA_CONFIG_PATH!, broken);
    expect(() => setQuietHours('22:00-07:00')).toThrow(/isn't valid JSON/);
    expect(readFileSync(process.env.MWA_CONFIG_PATH!, 'utf8')).toBe(broken);
  });
});

describe('BL-07 review, round 2: one bad chat never blocks the queue', () => {
  const fail = (msg: string) => { throw new Error(msg); };
  const tgFail = (e: unknown) => {
    const m = String((e as Error).message);
    const ra = /retry after (\d+)/i.exec(m);
    if (ra) return { action: 'stop' as const, retryAfterMs: Number(ra[1]) * 1000 };
    if (/bot was blocked|chat not found/i.test(m)) return { action: 'drop' as const };
    return { action: 'skip' as const };
  };

  it('a chat that blocked the bot is dropped and the next chat still gets its messages', async () => {
    holdPush({ chat: 'blocked', text: 'b1' }); holdPush({ chat: 'blocked', text: 'b2' }); holdPush({ chat: 'OK', text: 'ok1' });
    const sent: string[] = [];
    const r = await flushHeld(async (i) => { if (i.chat === 'blocked') fail('403 Forbidden: bot was blocked by the user'); sent.push(i.text); }, undefined, () => true, tgFail);
    expect(sent).toEqual(['ok1']);
    expect(r.sent).toBe(1);
    expect(heldPushes()).toEqual([]);
  });

  it('a passing failure skips that chat until the next flush; other chats still go out', async () => {
    holdPush({ chat: 'flaky', text: 'f1' }); holdPush({ chat: 'flaky', text: 'f2' }); holdPush({ chat: 'OK', text: 'ok1' });
    const sent: string[] = [];
    await flushHeld(async (i) => { if (i.chat === 'flaky') fail('502 Bad Gateway'); sent.push(i.text); }, undefined, () => true, tgFail);
    expect(sent).toEqual(['ok1']);
    expect(heldPushes().map((h) => h.text)).toEqual(['f1', 'f2']);
  });

  it('a rate limit stops the whole flush and says how long to wait', async () => {
    holdPush({ chat: 'A', text: 'a1' }); holdPush({ chat: 'B', text: 'b1' });
    const r = await flushHeld(async () => fail('429 Too Many Requests: retry after 17'), undefined, () => true, tgFail);
    expect(r).toEqual({ sent: 0, retryAfterMs: 17_000 });
    expect(heldPushes()).toHaveLength(2);
  });

  it('a result merged into an item while it is being sent is kept for the next flush', async () => {
    holdPush({ chat: 'A', text: '03:00 server down', key: 'job-1' });
    await flushHeld(async () => { holdPush({ chat: 'A', text: '07:00 server up', key: 'job-1' }); });
    expect(heldPushes().map((h) => h.text)).toEqual(['07:00 server up']);
  });

  it('delivers at most `limit` per call, so live messages can interleave', async () => {
    for (let i = 1; i <= 5; i++) holdPush({ chat: 'A', text: `m${i}` });
    expect((await flushHeld(async () => {}, undefined, () => true, undefined, 2)).sent).toBe(2);
    expect(heldPushes().map((h) => h.text)).toEqual(['m3', 'm4', 'm5']);
  });

  it('a blocked chat whose header fails is dropped too, not retried every poll', async () => {
    for (let i = 1; i <= 5; i++) holdPush({ chat: 'blocked', text: `b${i}` });
    holdPush({ chat: 'OK', text: 'ok1' });
    const sent: string[] = []; const logs: string[] = [];
    await flushHeld(async (i) => { sent.push(i.text); }, async (c) => { if (c === 'blocked') fail('Forbidden: bot was blocked by the user'); },
      () => true, tgFail, Infinity, (l) => logs.push(l));
    expect(sent).toEqual(['ok1']);
    expect(heldPushes()).toEqual([]);
    expect(logs.join()).toMatch(/dropped 5 held/);
  });

  it('an item that keeps failing for an unknown reason is dropped after five tries, and logged', async () => {
    holdPush({ chat: 'A', text: 'poison' }); holdPush({ chat: 'A', text: 'next' });
    const logs: string[] = []; const sent: string[] = [];
    const send = async (i: HeldPush) => { if (i.text === 'poison') fail('400 Bad Request: message text is empty'); sent.push(i.text); };
    for (let n = 0; n < 4; n++) await flushHeld(send, undefined, () => true, tgFail, Infinity, (l) => logs.push(l));
    expect(heldPushes().map((h) => [h.text, h.tries ?? 0])).toEqual([['poison', 4], ['next', 0]]);
    await flushHeld(send, undefined, () => true, tgFail, Infinity, (l) => logs.push(l));
    await flushHeld(send, undefined, () => true, tgFail, Infinity, (l) => logs.push(l));
    expect(sent).toEqual(['next']);
    expect(heldPushes()).toEqual([]);
    expect(logs.join()).toMatch(/after 5 failed tries/);
  });
});
