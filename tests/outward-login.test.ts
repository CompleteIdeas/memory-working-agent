/**
 * Pending list 2026-10-26, 3e: an unattended run pauses before its fourth outward action (MAX_EXTERNAL = 3) and
 * browser_type counts, so a sign-in — two fields and a click — sat exactly at the limit, and a job allowed to sign in
 * could do nothing after. A saved login typed under the job's allowance is the person's own action: logged, not
 * counted. A login typed with no allowance, or by a run the person is watching, is unchanged.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../src/agent.js';
import { MwaMemory } from '../src/awm.js';
import { vaultSave, _resetVaultCache } from '../src/vault/vault.js';

describe('an allowed login and the outward-action limit', () => {
  let cfgDir = '';
  beforeAll(() => {
    cfgDir = mkdtempSync(join(tmpdir(), 'mwa-login-'));
    vi.stubEnv('MWA_VAULT_PATH', join(cfgDir, 'vault.json'));
    vi.stubEnv('MWA_FAST_CHAT', '0');
    _resetVaultCache();
    vaultSave('portal', 'portal.example', { username: 'tomsmith', password: 'SuperSecretPassword!' });
  });
  afterAll(() => { vi.unstubAllEnvs(); _resetVaultCache(); rmSync(cfgDir, { recursive: true, force: true }); });

  // fake browser tools: every call succeeds, nothing is opened
  const tools = () => {
    const calls: string[] = [];
    const names = ['browser_open', 'browser_type', 'browser_click'];
    return { calls, t: {
      defs: () => names.map((name) => ({ name, description: 'x', parameters: { type: 'object', properties: {} } })),
      has: (n: string) => names.includes(n),
      callDetailed: async (n: string) => { calls.push(n); return { text: n === 'browser_open' ? 'opened: Portal' : 'ok', failed: false }; },
      call: async (n: string) => { calls.push(n); return 'ok'; },
    } };
  };
  const SIGNIN = [
    { action: 'browser_open', url: 'https://portal.example/login' },
    { action: 'browser_type', ref: 1, text: '{{vault:portal.username}}' },
    { action: 'browser_type', ref: 2, text: '{{vault:portal.password}}' },
    { action: 'browser_click', ref: 3 },           // "Sign in": outward action 1
    { action: 'browser_click', ref: 4 },           // outward action 2
    { action: 'browser_click', ref: 5 },           // outward action 3
    { action: 'done', summary: 'The secure area says welcome.', outcome: 'changed' },
  ];
  const scripted = (actions: Record<string, unknown>[]) => {
    let i = 0;
    return { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: { system?: string }) => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      return { text: JSON.stringify(actions[Math.min(i++, actions.length - 1)]), usage: { input: 1, output: 1 } };
    } };
  };
  const run = async (jobAllow: { vault: string[] } | undefined, interactive = false) => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-login-run-'));
    const mem = new MwaMemory('login', join(dir, 'm.db'));
    const { calls, t } = tools();
    try {
      const r = await runAgent({ instruction: 'Sign in to the portal and read the secure area', dir, memory: mem, brain: scripted(SIGNIN) as never, worker: scripted(SIGNIN) as never, tools: t as never,
        interactive, plan: false, jobId: 'job-1', jobAllow, budget: { maxSteps: 10, maxWallMs: 30_000 } } as never);
      return { r, calls };
    } finally { mem.close(); rmSync(dir, { recursive: true, force: true }); }
  };

  it('a job allowed to use the saved login signs in and still has its three outward actions', async () => {
    const { r, calls } = await run({ vault: ['portal'] });
    expect(calls.filter((c) => c === 'browser_click')).toHaveLength(3);
    expect(r.reason).toBe('done');
  }, 60_000);

  it('without the allowance the two typed fields count, and the run pauses before its fourth outward action', async () => {
    const { r, calls } = await run(undefined);
    expect(calls.filter((c) => c === 'browser_click')).toHaveLength(1); // type, type, click = 3; the next click pauses
    expect(r.reason).toBe('paused');
    expect(r.summary).toMatch(/reached outside your machine 3 times/);
  }, 60_000);
});
