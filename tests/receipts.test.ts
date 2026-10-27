/**
 * BL-13 — delivery receipts. A finished run is not a delivered result: each channel records what
 * happened to each fire's result, so "did my report reach me?" has an answer, and a job whose
 * results reach no one for several fires in a row says so in schedule_list.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordReceipt, readReceipts, jobDeliveries, deliveryLine, setReceiptProducer } from '../src/receipts.js';
import { holdPush, flushHeld, heldPushes, firesOf } from '../src/quiet.js';
import { tickScheduler } from '../src/scheduler.js';
import { MwaMemory } from '../src/awm.js';
import { workTools } from '../src/tools/work.js';

let dir = '';
const saved = { r: process.env.MWA_RECEIPTS_DIR, h: process.env.MWA_HELD };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mwa-receipts-'));
  process.env.MWA_RECEIPTS_DIR = dir;
  process.env.MWA_HELD = join(dir, 'held.jsonl');
  setReceiptProducer('test');
});
afterEach(() => {
  for (const [k, v] of [['MWA_RECEIPTS_DIR', saved.r], ['MWA_HELD', saved.h]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  setReceiptProducer('mwa');
  rmSync(dir, { recursive: true, force: true });
});

describe('the receipts log', () => {
  it('one file per process; readers merge them; the latest status per channel wins', () => {
    setReceiptProducer('serve');
    recordReceipt({ job: 'j1', fire: 'f1', channel: 'app', status: 'stored', ts: 1000 });
    setReceiptProducer('telegram');
    recordReceipt({ job: 'j1', fire: 'f1', channel: 'telegram', status: 'held', detail: 'quiet hours', ts: 1001 });
    recordReceipt({ job: 'j1', fire: 'f1', channel: 'telegram', status: 'sent', ts: 1002 });
    setReceiptProducer('serve');
    recordReceipt({ job: 'j1', fire: 'f1', channel: 'app', status: 'served', ts: 1003 });
    expect(readdirSync(dir).sort()).toEqual(['deliveries-serve.jsonl', 'deliveries-telegram.jsonl']);
    const [f] = jobDeliveries('j1');
    expect([f.channels.app.status, f.channels.telegram.status, f.reached]).toEqual(['served', 'sent', true]);
  });

  it('says what is known and no more: stored is not shown, served is not read', () => {
    recordReceipt({ job: 'j', fire: 'f', channel: 'app', status: 'stored' });
    expect(deliveryLine('j')).toMatch(/saved in the app, not yet shown in an open tab/);
    recordReceipt({ job: 'j', fire: 'f', channel: 'app', status: 'served' });
    expect(deliveryLine('j')).toMatch(/shown in an open app tab .*\(not proof it was read\)/);
  });

  it('a resumed run lands on its job: receipts key by the id prefix a resume carries', () => {
    const full = '1d069a3b-0000-4000-8000-000000000001';
    recordReceipt({ job: full.slice(0, 8), fire: 'r1', channel: 'telegram', status: 'sent' }); // a resume knows only the prefix
    expect(deliveryLine(full)).toMatch(/sent to Telegram/);
  });

  it('a job with no channel at all is a failure, and three in a row are flagged', () => {
    for (let i = 0; i < 3; i++) recordReceipt({ job: 'nochat', fire: `n${i}`, channel: 'none', status: 'failed', detail: 'no chat to send it to', ts: 5000 + i });
    expect(deliveryLine('nochat')).toMatch(/\): nothing could send it: no chat to send it to — ⚠ the last 3 results reached no one/);
  });

  // 4000 real appends (each a stat, a 1-byte read and an append) is ~2 s alone, but on Windows under the full suite,
  // with every other file writing beside it, it has run past 60 s on every run since 2026-10-26. The cap logic is
  // what these test, not the speed of the disk, so they get room.
  const BULK_MS = 240_000;
  it('a busy job never pushes a quiet job\u2019s only receipts out of the capped file', () => {
    recordReceipt({ job: 'daily', fire: 'd1', channel: 'telegram', status: 'sent', ts: 1 });
    const big = 'x'.repeat(190);
    for (let i = 0; i < 4000; i++) recordReceipt({ job: 'minutely', fire: `m${i}`, channel: 'none', status: 'not-sent', detail: big });
    expect(deliveryLine('daily')).toMatch(/sent to Telegram/);
  }, BULK_MS);

  it('the time carries the date when it is not today', () => {
    recordReceipt({ job: 'old', fire: 'o', channel: 'telegram', status: 'sent', ts: Date.now() - 3 * 86_400_000 });
    expect(deliveryLine('old')).toMatch(/last result \([A-Z][a-z]{2} \d{1,2} \d\d:\d\d\)/);
  });

  it('warns when the last three results reached no one — but not for a job kept quiet on purpose, or an app nobody opened yet', () => {
    for (const [i, s] of (['failed', 'dropped', 'failed'] as const).entries()) recordReceipt({ job: 'lost', fire: `f${i}`, channel: 'telegram', status: s, detail: 'Forbidden: bot was blocked', ts: 1000 + i });
    expect(deliveryLine('lost')).toMatch(/⚠ the last 3 results reached no one/);
    for (let i = 0; i < 3; i++) recordReceipt({ job: 'quiet', fire: `q${i}`, channel: 'none', status: 'not-sent', detail: 'nothing changed', ts: 2000 + i });
    expect(deliveryLine('quiet')).not.toMatch(/⚠/);
    for (let i = 0; i < 3; i++) recordReceipt({ job: 'app', fire: `a${i}`, channel: 'app', status: 'stored', ts: 3000 + i });
    expect(deliveryLine('app')).not.toMatch(/⚠/);
    recordReceipt({ job: 'lost', fire: 'f3', channel: 'telegram', status: 'sent', ts: 1010 }); // one gets through: no warning
    expect(deliveryLine('lost')).not.toMatch(/⚠/);
  });

  it('a torn line is skipped, and a file past its cap keeps its newest lines', () => {
    writeFileSync(join(dir, 'deliveries-test.jsonl'), '{"job":"j","fire":"f","channel":"app","status":"stored","ts":1,"by":"test"}\n{"job":"j","fi');
    recordReceipt({ job: 'j2', fire: 'g', channel: 'app', status: 'stored' });
    expect(readReceipts().map((r) => r.job)).toEqual(['j', 'j2']); // the torn tail is skipped; the next receipt starts its own line
    const big = 'x'.repeat(190); // ~300 bytes a line: past 1 MB well within 4000 receipts
    for (let i = 0; i < 4000; i++) recordReceipt({ job: 'bulk', fire: `b${i}`, channel: 'app', status: 'stored', detail: big });
    expect(statSync(join(dir, 'deliveries-test.jsonl')).size).toBeLessThan(1_000_000);
    expect(readReceipts().some((r) => r.fire === 'b3999')).toBe(true); // the newest survive the cap
  }, BULK_MS);
});

describe('the scheduler and the channels record receipts', () => {
  let mem: MwaMemory; let fired: { job?: string; fire?: string }[] = [];
  beforeEach(() => { mem = new MwaMemory('receipts-test', join(dir, 'a.db')); fired = []; });
  afterEach(() => { mem.close(); });
  const deps = (outcome: string) => ({
    memory: mem, brain: {} as never, worker: {} as never, outRoot: join(dir, 'out'), checksAllowed: false,
    runAgent: (async () => ({ summary: 'ok', reason: 'done', outcome, steps: 1, toolCalls: 0, costUsd: 0, durationMs: 1 })) as never,
    onFire: async (_t: unknown, r: { job?: string; fire?: string }) => { fired.push({ job: r.job, fire: r.fire }); },
  });

  it('a result kept quiet by the job\u2019s own setting is recorded as not sent, with why', async () => {
    const id = (await mem.addScheduledTask('watch', Date.now() - 1000, { deliver: 'changed' }))!;
    await tickScheduler(deps('no-change'));
    expect(fired).toEqual([]);
    expect(deliveryLine(id)).toMatch(/not sent \(told only when something changes; this run: no-change\)/);
  });

  it('a delivered result carries the job and a fire id to every channel', async () => {
    const id = (await mem.addScheduledTask('report', Date.now() - 1000, {}))!;
    await tickScheduler(deps('changed'));
    expect(fired[0].job).toBe(id);
    expect(fired[0].fire).toMatch(new RegExp(`^${id.slice(0, 8)}-\\d+$`));
  });

  it('a held Telegram result that can never arrive says so: dropped, or failed after five tries', async () => {
    holdPush({ chat: 'blocked', text: 'r1', job: 'jb', fire: 'fb' });
    holdPush({ chat: 'flaky', text: 'r2', job: 'jf', fire: 'ff' });
    const give: string[] = [];
    const classify = (e: unknown) => (/blocked/.test(String((e as Error).message)) ? { action: 'drop' as const } : { action: 'skip' as const });
    for (let n = 0; n < 5; n++) {
      await flushHeld(async (i) => { throw new Error(i.chat === 'blocked' ? 'Forbidden: bot was blocked by the user' : '502 Bad Gateway'); },
        undefined, () => true, classify, Infinity, () => {},
        (items, why, status) => { for (const i of items) { give.push(`${i.fire}:${status}`); recordReceipt({ job: i.job!, fire: i.fire!, channel: 'telegram', status, detail: why }); } });
    }
    expect(give).toEqual(['fb:dropped', 'ff:failed']);
    expect(deliveryLine('jb')).toMatch(/Telegram dropped it: Forbidden: bot was blocked/);
    expect(deliveryLine('jf')).toMatch(/Telegram failed: gave up after 5 tries/);
  });

  it('results merged while held keep every fire: the newest owns the item, the earlier ones are replaced', () => {
    holdPush({ chat: 'A', text: 'F1', key: 'k', job: 'jm', fire: 'F1' });
    holdPush({ chat: 'A', text: 'F2', key: 'k', job: 'jm', fire: 'F2' });
    holdPush({ chat: 'A', text: 'F3', key: 'k', job: 'jm', fire: 'F3' });
    const [h] = heldPushes();
    expect([h.text, h.fire, h.replaced, h.count]).toEqual(['F3', 'F3', ['F1', 'F2'], 3]);
    expect(firesOf(h)).toEqual(['F1', 'F2', 'F3']);
  });

  it('a result merged in while the item was being sent does not un-deliver the one that went out', async () => {
    holdPush({ chat: 'A', text: 'M1', key: 'k', job: 'jx', fire: 'M1' });
    await flushHeld(async () => { holdPush({ chat: 'A', text: 'M2', key: 'k', job: 'jx', fire: 'M2' }); });
    const [h] = heldPushes();
    expect([h.fire, h.replaced]).toEqual(['M2', []]); // M1 went out; M2 waits, owning nothing it didn't carry
  });

  it('merged results that can never arrive are ALL recorded as lost, and flagged', async () => {
    for (const f of ['G1', 'G2', 'G3']) holdPush({ chat: 'blocked', text: f, key: 'k', job: 'jg', fire: f });
    await flushHeld(async () => { throw new Error('Forbidden: bot was blocked by the user'); }, undefined, () => true, () => ({ action: 'drop' as const }), Infinity, () => {},
      (items, why, status) => { for (const i of items) for (const f of firesOf(i)) recordReceipt({ job: i.job!, fire: f, channel: 'telegram', status, detail: why }); });
    expect(jobDeliveries('jg').map((d) => d.channels.telegram.status)).toEqual(['dropped', 'dropped', 'dropped']);
    expect(deliveryLine('jg')).toMatch(/⚠ the last 3 results reached no one/);
  });

  it('schedule_list shows each job\u2019s last result and whether it reached the person', async () => {
    const id = (await mem.addScheduledTask('daily report', Date.now() + 60_000, { recur: 'daily:08:00', person: 'robert' }))!;
    recordReceipt({ job: id, fire: 'x1', channel: 'telegram', status: 'sent' });
    const out = await workTools(mem).find((t) => t.def.name === 'schedule_list')!.handler({}, { sandboxDir: '.', personId: 'robert' } as never);
    expect(out).toMatch(/last result \(\d\d:\d\d\): sent to Telegram/);
  });
});
