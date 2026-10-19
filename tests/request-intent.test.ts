/**
 * BL-52 — what the person's message asks for, read by a model (Clef, or any provider) instead of patterns.
 * Calibrated in docs/intent-calibration-2026-10-19.md. Here: the readers never throw, a weak or unreadable
 * answer is no answer, and the run uses the reading where the patterns were wrong — with the patterns still
 * deciding when there is no reading.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clefClassifier, providerClassifier, intentClassifier, CLEF_LATER_THRESHOLD, type RequestIntent } from '../src/request-intent.js';
import { asksForLater } from '../src/claim-check.js';

const prevTz = process.env.TZ;
afterEach(() => { if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz; });

const clefReply = (answers: Record<string, unknown>, ok = true) => (async () => ({ ok, json: async () => ({ success: ok, result: { answers } }) })) as unknown as typeof fetch;
const ANS = (p: number, cat = 'later', jobs = '2', rem = '2') => ({ later: { noul: p }, category: { choice: cat }, jobs: { choice: jobs }, reminders: { choice: rem } });

describe('Clef', () => {
  it('a confident "later" is a request with its counts', async () => {
    const c = clefClassifier({ token: 't', account: 'a', fetchImpl: clefReply(ANS(0.98)) });
    expect(await c('Set two reminders …')).toEqual({ later: true, category: 'later', jobs: 2, reminders: 2 });
  });
  it(`below ${CLEF_LATER_THRESHOLD} it is not, whatever the category pick says`, async () => {
    const c = clefClassifier({ token: 't', account: 'a', fetchImpl: clefReply(ANS(0.55)) });
    expect(await c('Tell me the moment it ships')).toEqual({ later: false, category: 'now', jobs: 0, reminders: 0 });
  });
  it('a job correction comes through as one', async () => {
    const c = clefClassifier({ token: 't', account: 'a', fetchImpl: clefReply(ANS(0.1, 'change_job', '0', '0')) });
    expect((await c('From now on keep the plan to 3 bullets'))?.category).toBe('change_job');
  });
  it('an error, a refusal or an unreadable answer is no answer', async () => {
    expect(await clefClassifier({ token: 't', account: 'a', fetchImpl: clefReply({}, false) })('x')).toBeNull();
    expect(await clefClassifier({ token: 't', account: 'a', fetchImpl: clefReply({ later: { noul: 'high' }, category: { choice: 'later' } }) })('x')).toBeNull();
    expect(await clefClassifier({ token: 't', account: 'a', fetchImpl: (async () => { throw new Error('offline'); }) as never })('x')).toBeNull();
  });
});

describe('a provider', () => {
  const prov = (text: string) => ({ id: 'p', model: 'p', price: [0, 0] as [number, number], chat: async () => ({ text, usage: { input: 1, output: 1 } }) });
  it('reads the last well-formed answer — an echoed example does not win', async () => {
    const c = providerClassifier(prov('e.g. {"category":"later","jobs":3,"reminders":3} … my answer: {"category":"now","jobs":0,"reminders":0}') as never);
    expect(await c('What do I have scheduled?')).toEqual({ later: false, category: 'now', jobs: 0, reminders: 0 });
  });
  it('clamps counts, and an answer with no category is no answer', async () => {
    expect(await providerClassifier(prov('{"category":"later","jobs":40,"reminders":99}') as never)('x')).toEqual({ later: true, category: 'later', jobs: 8, reminders: 8 });
    expect(await providerClassifier(prov('{"later":true}') as never)('x')).toBeNull();
  });
  it('off by default; clef without credentials is off', () => {
    expect(intentClassifier({})).toBeNull();
    expect(intentClassifier({ MWA_INTENT: 'off' })).toBeNull();
    expect(intentClassifier({ MWA_INTENT: 'clef' })).toBeNull();
    expect(typeof intentClassifier({ MWA_INTENT: 'clef', MWA_CLEF_TOKEN: 't', MWA_CLEF_ACCOUNT: 'a' })).toBe('function');
  });
});

describe('a run reads the request through the classifier', () => {
  const run = async (message: string, actions: Record<string, unknown>[], intent: RequestIntent | null, tools?: Record<string, string>) => {
    const { runAgent } = await import('../src/agent.js');
    const { MwaMemory } = await import('../src/awm.js');
    const dir = mkdtempSync(join(tmpdir(), 'mwa-bl52-'));
    const mem = new MwaMemory('bl52', join(dir, 'm.db'));
    const prompts: string[] = []; let i = 0;
    const brain = { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: any) => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      prompts.push(String(input.messages?.[0]?.content ?? ''));
      return { text: JSON.stringify(actions[Math.min(i++, actions.length - 1)]), usage: { input: 1, output: 1 } };
    } };
    const stub = tools ? { defs: () => Object.keys(tools).map((name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })), has: (x: string) => x in tools, call: async (n: string) => tools[n] } : undefined;
    const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
    try {
      const r = await runAgent({ instruction: message, userMessage: message, dir, memory: mem as any, brain, worker: brain, interactive: true, plan: false, tools: stub as any, intent: async () => intent, now: () => Date.UTC(2026, 10, 2, 14, 0), budget: { maxSteps: 8, maxWallMs: 20_000 } } as any);
      return { r, prompts, jobs: await mem.pendingScheduled() };
    } finally {
      if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev;
      mem.close(); rmSync(dir, { recursive: true, force: true });
    }
  };
  const LATER1: RequestIntent = { later: true, category: 'later', jobs: 1, reminders: 0 };
  const LIST = { schedule_list: '(nothing scheduled)' };
  const GAVE_UP = { action: 'done', summary: "I couldn't confirm the brief is set." };
  // BL-40's request the patterns miss since the BL-43 review ("a brief OF new emails").
  const MISSED = 'Morning—set me a weekday 8:00 AM brief of new emails that need me, ranked most important first.';

  it('a request the patterns miss is pushed to schedule when the classifier reads it as one', async () => {
    expect(asksForLater(MISSED)).toBe(false);
    const { r } = await run(MISSED, [{ action: 'schedule_list' }, GAVE_UP, { action: 'schedule', kind: 'task', instruction: 'Brief me on new emails', daily_at: '08:00', days: 'weekdays' }], LATER1, LIST);
    expect(r.history.join('\n')).toMatch(/nothing scheduled for a later request/);
  }, 60_000);

  it('without a reading the patterns decide, as before', async () => {
    const { r } = await run(MISSED, [{ action: 'schedule_list' }, GAVE_UP], null, LIST);
    expect(r.history.join('\n')).not.toMatch(/nothing scheduled for a later request/);
  }, 60_000);

  it("a classifier's count never ends a run early — only a count the person wrote does (BL-52 review)", async () => {
    process.env.TZ = 'America/New_York';
    const { prompts, jobs } = await run('Set a daily 7:00 AM check on the rose prices', [{ action: 'schedule', kind: 'task', instruction: 'Check rose prices', daily_at: '07:00' }, { action: 'done', summary: 'x' }], LATER1);
    expect(jobs).toHaveLength(1);
    expect(prompts).toHaveLength(2); // went on to the model's done
  }, 60_000);

  it('all reminders read, and the person said "remind": the kind is settled without asking', async () => {
    const { prompts, jobs } = await run('Remind me in 20 minutes to take the bread out', [{ action: 'schedule', instruction: 'Take the bread out', in_minutes: 20 }, { action: 'done', summary: 'ok' }], { later: true, category: 'later', jobs: 1, reminders: 1 });
    expect(jobs[0].kind).toBe('reminder');
    expect(prompts.join('\n')).not.toMatch(/Say which this is with kind/);
  }, 60_000);

  it('a reading the words do not back is asked about, and a done after the question is pushed to set the job', async () => {
    const { r, jobs } = await run('Ping me in 20 minutes to take the bread out', [{ action: 'schedule', instruction: 'Take the bread out', in_minutes: 20 }, { action: 'done', summary: 'ok' }, { action: 'schedule', kind: 'reminder', instruction: 'Take the bread out', in_minutes: 20 }, { action: 'done', summary: 'ok' }], { later: true, category: 'later', jobs: 1, reminders: 1 });
    expect(r.history.join('\n')).toMatch(/reminder or task\? asked once/);
    expect(r.history.join('\n')).toMatch(/the job was not set after the reminder-or-task question — asked again/);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].kind).toBe('reminder');
  }, 60_000);

  it('listing the schedule first does not stop a reminder (BL-52 review: the listing tainted the run)', async () => {
    const { jobs } = await run('Remind me tomorrow at 9am to call the bank', [{ action: 'schedule_list' }, { action: 'schedule', kind: 'reminder', instruction: 'Call the bank', at: '2026-11-03 09:00' }, { action: 'done', summary: 'ok' }], null, { schedule_list: '(nothing scheduled)' });
    expect(jobs[0].kind).toBe('reminder');
    expect(jobs[0].tainted).toBeUndefined();
  }, 60_000);
});
