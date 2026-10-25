/**
 * Browser in the back end (review 2026-10-25, F06). An unattended run never types a saved login after reading outside
 * content and never clicks a control that signs in, submits or pays — so "every day, sign in and tell me…" was accepted
 * at scheduling time and failed every morning with an unexplained refusal. A job may now carry an ALLOWANCE the person
 * gives when they set it up, in a clean conversation: named saved logins and up to two named controls on named sites.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../src/agent.js';
import { MwaMemory } from '../src/awm.js';
import { parseAllow, allowText, vaultAllowed, clickAllowed, NEEDS_ALLOW } from '../src/tools/browser.js';
import { vaultSave, _resetVaultCache } from '../src/vault/vault.js';

const SIGNIN = 'Sign in to https://the-internet.herokuapp.com/login with the saved login and tell me what the secure area says';

describe('the allowance itself', () => {
  it('parses saved-login names and "site: control" pairs, and refuses what it cannot check', () => {
    expect(parseAllow('fox-run, usea-portal', undefined, ['fox-run', 'usea-portal']).allow).toEqual({ vault: ['fox-run', 'usea-portal'] });
    expect(parseAllow('fox-run', undefined, []).error).toMatch(/No saved login is named "fox-run"/);
    expect(parseAllow(undefined, 'the-internet.herokuapp.com: Login', []).allow).toEqual({ click: [{ host: 'the-internet.herokuapp.com', label: 'Login' }] });
    expect(parseAllow(undefined, 'https://www.useventing.com/entries: Submit entry; usef.org: Pay', []).allow?.click).toEqual([{ host: 'www.useventing.com', label: 'Submit entry' }, { host: 'usef.org', label: 'Pay' }]);
    expect(parseAllow(undefined, 'Login', []).error).toMatch(/site: control text/);
    expect(parseAllow(undefined, 'a.com: x; b.com: y; c.com: z', []).error).toMatch(/at most two/);
    expect(parseAllow('', '', []).error).toMatch(/give at least one/);
  });
  it('says what a job may do, and checks a page and a control against it', () => {
    const allow = { vault: ['fox-run'], click: [{ host: 'foxrunfarm.example', label: 'Submit entry' }] };
    expect(allowText(allow)).toBe('use the saved login "fox-run" on its own site; click "Submit entry" on foxrunfarm.example');
    expect(vaultAllowed(allow, 'user {{vault:fox-run.password}}')).toBe(true);
    expect(vaultAllowed(allow, '{{vault:other.password}}')).toBe(false);
    expect(vaultAllowed(allow, 'plain text')).toBe(false);
    expect(clickAllowed(allow, 'https://entries.foxrunfarm.example/form', 'Submit entry submit')).toBe(true); // a subdomain, the control's fuller label
    expect(clickAllowed(allow, 'https://foxrunfarm.example.evil.net/form', 'Submit entry')).toBe(false);
    expect(clickAllowed(allow, 'https://foxrunfarm.example/form', 'Delete entry')).toBe(false);
    expect(clickAllowed(undefined, 'https://foxrunfarm.example/form', 'Submit entry')).toBe(false);
  });
  it('knows an instruction that needs one', () => {
    for (const s of [SIGNIN, 'Log in to the portal and download the statement', 'Submit the entry form tomorrow at 9', 'Buy the tickets when they go on sale']) expect([s, NEEDS_ALLOW.test(s)]).toEqual([s, true]);
    for (const s of ['Check the price page every morning', 'Tell me if the title changes', 'Summarize my inbox']) expect([s, NEEDS_ALLOW.test(s)]).toEqual([s, false]);
  });
});

describe('the schedule action', () => {
  let cfgDir = '';
  beforeAll(() => {
    cfgDir = mkdtempSync(join(tmpdir(), 'mwa-allow-'));
    vi.stubEnv('MWA_VAULT_PATH', join(cfgDir, 'vault.json'));
    _resetVaultCache();
    vaultSave('the-internet', 'the-internet.herokuapp.com', { username: 'tomsmith', password: 'SuperSecretPassword!' });
  });
  afterAll(() => { vi.unstubAllEnvs(); _resetVaultCache(); rmSync(cfgDir, { recursive: true, force: true }); });

  const scripted = (actions: Record<string, unknown>[]) => {
    let i = 0;
    return { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: { system?: string }) => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      return { text: JSON.stringify(actions[Math.min(i++, actions.length - 1)]), usage: { input: 1, output: 1 } };
    } };
  };
  const withRun = async <T>(fn: (dir: string, mem: MwaMemory) => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-allow-run-'));
    const mem = new MwaMemory('allow', join(dir, 'm.db'));
    vi.stubEnv('MWA_FAST_CHAT', '0');
    try { return await fn(dir, mem); } finally { mem.close(); rmSync(dir, { recursive: true, force: true }); }
  };
  const run = (dir: string, mem: MwaMemory, actions: Record<string, unknown>[], interactive = true) => runAgent({
    instruction: 'Every day at 9, sign in and tell me what the secure area says.', userMessage: 'Every day at 9, sign in and tell me what the secure area says.', dir, memory: mem, brain: scripted(actions), worker: scripted(actions),
    interactive, plan: false, budget: { maxSteps: 8, maxWallMs: 30_000 },
  });

  it('a job that signs in is sent back once without an allowance; resent unchanged, it is scheduled as it is', async () => {
    await withRun(async (dir, mem) => {
      const r = await run(dir, mem, [{ action: 'schedule', instruction: SIGNIN, daily_at: '09:00' }, { action: 'schedule', instruction: SIGNIN, daily_at: '09:00' }, { action: 'done', summary: 'set' }]);
      expect(r.history.join('\n')).toMatch(/schedule held once: the job signs in, submits or pays, and no allowance was given/);
      const jobs = await mem.pendingScheduled();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].allow).toBeUndefined();
    });
  }, 60_000);

  it('with the person present, allow_vault and allow_click are kept on the job and shown in its words', async () => {
    await withRun(async (dir, mem) => {
      const r = await run(dir, mem, [{ action: 'schedule', instruction: SIGNIN, daily_at: '09:00', allow_vault: 'the-internet', allow_click: 'the-internet.herokuapp.com: Login' }, { action: 'done', summary: 'set' }]);
      expect(r.reason).toBe('done');
      const jobs = await mem.pendingScheduled();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].allow).toEqual({ vault: ['the-internet'], click: [{ host: 'the-internet.herokuapp.com', label: 'Login' }] });
      expect(r.history.join('\n')).not.toMatch(/schedule held once/);
    });
  }, 60_000);

  it('a saved login that does not exist is refused by name', async () => {
    await withRun(async (dir, mem) => {
      const r = await run(dir, mem, [{ action: 'schedule', instruction: SIGNIN, daily_at: '09:00', allow_vault: 'nope' }, { action: 'done', summary: 'could not' }]);
      expect(r.history.join('\n')).toMatch(/No saved login is named "nope"/);
      expect(await mem.pendingScheduled()).toHaveLength(0);
    });
  }, 60_000);

  it('an unattended run cannot give an allowance', async () => {
    await withRun(async (dir, mem) => {
      const r = await run(dir, mem, [{ action: 'schedule', instruction: SIGNIN, daily_at: '09:00', allow_vault: 'the-internet' }, { action: 'schedule', instruction: SIGNIN, daily_at: '09:00' }, { action: 'done', summary: 'set' }], false);
      expect(r.history.join('\n')).toMatch(/an allowance can only be given by the person/);
      const jobs = await mem.pendingScheduled();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].allow).toBeUndefined();
    });
  }, 60_000);

  it('a fired job hands its allowance to the tools, and the run is told what it may do', async () => {
    await withRun(async (dir, mem) => {
      const seen: unknown[] = []; const systems: string[] = [];
      const tools = { defs: () => [{ name: 'browser_open', description: 'x', parameters: { type: 'object', properties: {} } }], has: (n: string) => n === 'browser_open', callDetailed: async (_n: string, _a: unknown, ctx: { jobAllow?: unknown }) => { seen.push(ctx.jobAllow); return { text: 'Page: ok', failed: false }; }, call: async () => 'ok' } as never;
      const brain = { id: 'b', model: 'b', price: [0, 0] as [number, number], chat: async (input: { system?: string }) => {
        const sys = String(input.system ?? ''); if (!sys.includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
        systems.push(sys);
        return { text: JSON.stringify(systems.length === 1 ? { action: 'browser_open', url: 'https://the-internet.herokuapp.com/login' } : { action: 'done', summary: 'The secure area says welcome.', outcome: 'changed' }), usage: { input: 1, output: 1 } };
      } };
      const allow = { vault: ['the-internet'], click: [{ host: 'the-internet.herokuapp.com', label: 'Login' }] };
      await runAgent({ instruction: SIGNIN, dir, memory: mem, brain: brain as never, worker: brain as never, tools, interactive: false, plan: false, jobId: 'job-1', jobAllow: allow, budget: { maxSteps: 6, maxWallMs: 30_000 } } as never);
      expect(seen[0]).toEqual(allow);
      expect(systems[0]).toMatch(/THIS JOB MAY, WITH NOBODY WATCHING .*use the saved login "the-internet" on its own site; click "Login" on the-internet\.herokuapp\.com/);
    });
  }, 60_000);
});
