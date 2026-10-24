/**
 * Approval cards that match what happened (usability review 2026-10-24, F02 and F03).
 *
 * Observed: one preference request produced one captured card and three identical policy_save cards, and approving
 * the first saved the model's shorter wording; a copy into the granted folder ran at once through write_file while
 * the shell copy's card still waited, so the chat said "Copied" and Decline changed nothing; an expired card vanished
 * with no trace. Now: one card per proposal, the person's fuller wording wins, a write outside the run's own folder
 * waits for approval, every ending stays visible for a day, and a reply never says done while its card waits.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setApprovalStorePath, stageAction, requireApproval, listPendingActions, recentApprovalOutcomes, cancelPending, confirmPending } from '../src/tools/approval.js';
import { BUILTIN_TOOLS } from '../src/tools/builtins.js';
import { runAgent } from '../src/agent.js';
import { MwaMemory } from '../src/awm.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { workTools } from '../src/tools/work.js';
import type { RegisteredTool } from '../src/tools/registry.js';

let dir = ''; let granted = ''; let sandbox = '';
const prevCfg = process.env.MWA_CONFIG_PATH;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mwa-cards-'));
  granted = mkdtempSync(join(tmpdir(), 'mwa-cards-granted-'));
  sandbox = mkdtempSync(join(tmpdir(), 'mwa-cards-sb-'));
  process.env.MWA_CONFIG_PATH = join(dir, 'mwa.config.json');
  writeFileSync(process.env.MWA_CONFIG_PATH, JSON.stringify({ tools: { access: { preset: 'assistant', grantedRoots: [granted] } } }));
});
beforeEach(() => { setApprovalStorePath(join(dir, `approvals-${Math.random().toString(36).slice(2)}.db`)); });
afterAll(() => {
  setApprovalStorePath(null);
  if (prevCfg === undefined) delete process.env.MWA_CONFIG_PATH; else process.env.MWA_CONFIG_PATH = prevCfg;
  for (const d of [dir, granted, sandbox]) try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
});

describe('one card per proposal', () => {
  it('the same tool with the same arguments, staged again by the same conversation, is the same card', async () => {
    const ctx = { sandboxDir: '.', interactive: true, session: 'web-a', runId: 'run-1' };
    const a = stageAction({ tool: 'policy_save', summary: 'Add a STANDING preference:\n  "Keep answers short."', args: { rule: 'Keep answers short.' }, ctx });
    const b = stageAction({ tool: 'policy_save', summary: 'Add a STANDING preference:\n  "Keep answers short."', args: { rule: 'Keep answers short.' }, ctx });
    const c = stageAction({ tool: 'policy_save', summary: 'Add a STANDING preference:\n  "Keep answers short."', args: { rule: 'Keep answers short.' }, ctx: { ...ctx, session: 'web-b', runId: 'run-2' } });
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(listPendingActions()).toHaveLength(2);
    const tool: RegisteredTool = { def: { name: 'copy_thing', description: 'd', parameters: { type: 'object', properties: {} } }, handler: async () => 'copied' };
    const gated = requireApproval(tool);
    const id1 = /confirmation_id: (\S+)/.exec(await gated.handler({ from: 'a', to: 'b' }, ctx))![1];
    const id2 = /confirmation_id: (\S+)/.exec(await gated.handler({ to: 'b', from: 'a' }, ctx))![1];
    expect(id2).toBe(id1);
  });

  it('every ending stays visible for a day: expired and declined cards keep their words', async () => {
    const ctx = { sandboxDir: '.', interactive: true, session: 'web-a', runId: 'run-1' };
    const gone = stageAction({ tool: 'rename_thing', summary: 'Rename supplier-list.txt to suppliers.txt', args: { n: 1 }, ctx, ttlMs: 1 });
    const declined = stageAction({ tool: 'copy_thing', summary: 'Copy supplier-list.txt to backup', args: { n: 2 }, ctx });
    await new Promise((r) => setTimeout(r, 10));
    cancelPending(declined);
    const recent = recentApprovalOutcomes();
    expect(recent.find((r) => r.id === gone)).toMatchObject({ status: 'expired', summary: 'Rename supplier-list.txt to suppliers.txt', session: 'web-a' });
    expect(recent.find((r) => r.id === declined)).toMatchObject({ status: 'cancelled', summary: 'Copy supplier-list.txt to backup' });
    expect(listPendingActions()).toHaveLength(0);
  });
});

describe('a write into a granted folder waits for approval', () => {
  it('the run\'s own folder is immediate; a granted folder stages a card, and approving it writes the file', async () => {
    const ctx = { sandboxDir: sandbox, interactive: true, session: 'web-a', runId: 'run-9' };
    expect(await BUILTIN_TOOLS.write_file.handler({ path: 'notes.txt', content: 'mine' }, ctx)).toMatch(/^wrote notes\.txt/);
    const target = join(granted, 'supplier-list-backup.txt');
    const out = await BUILTIN_TOOLS.write_file.handler({ path: target, content: 'Acme; Bolt' }, ctx);
    expect(out).toMatch(/^\[APPROVAL REQUIRED\]/);
    expect(out).toMatch(/has NOT been written/);
    expect(existsSync(target)).toBe(false);
    const id = /confirmation_id: (\S+)/.exec(out)![1];
    const card = listPendingActions().find((p) => p.id === id)!;
    expect(card.summary).toMatch(/^Create the file .*supplier-list-backup\.txt \(10 bytes\) in a folder you granted\./);
    expect(card.readLocal).toBe(false);
    expect(await confirmPending(id, { sandboxDir: resolve('.'), interactive: true })).toContain('[CONFIRMED write_file]');
    expect(readFileSync(target, 'utf8')).toBe('Acme; Bolt');
    // overwriting says so
    const again = await BUILTIN_TOOLS.write_file.handler({ path: target, content: 'x' }, ctx);
    expect(again).toMatch(/confirmation_id/);
    expect(listPendingActions().find((p) => p.summary.startsWith('Overwrite the file'))).toBeTruthy();
  });
});

const scripted = (actions: Record<string, unknown>[], side = '{}') => {
  let i = 0;
  return { id: 's', model: 's', price: [0, 0] as [number, number], chat: async (input: { system?: string }) => {
    if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: side, usage: { input: 1, output: 1 } };
    return { text: JSON.stringify(actions[Math.min(i++, actions.length - 1)]), usage: { input: 1, output: 1 } };
  } };
};
const withRun = async <T>(fn: (mem: MwaMemory, d: string) => Promise<T>): Promise<T> => {
  const d = mkdtempSync(join(tmpdir(), 'mwa-cards-run-'));
  const mem = new MwaMemory('cards', join(d, 'm.db'));
  const prev = process.env.MWA_FAST_CHAT; process.env.MWA_FAST_CHAT = '0';
  try { return await fn(mem, d); } finally {
    if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev;
    mem.close(); rmSync(d, { recursive: true, force: true });
  }
};

describe('in a run', () => {
  it('the person\'s fuller wording replaces the model\'s shorter card, and there is one card for the preference', async () => {
    await withRun(async (mem, d) => {
      const reg = new ToolRegistry(); reg.registerAll(workTools(mem));
      const msg = 'Remember a standing preference: always keep all answers under 120 words and use British spelling';
      const brain = scripted([
        { action: 'policy_save', rule: 'Keep all answers under 120 words.' },
        { action: 'policy_save', rule: 'Keep all answers under 120 words.' },
        { action: 'done', summary: 'Noted. I have proposed the preference for your approval.' },
      ]);
      const r = await runAgent({ instruction: msg, userMessage: msg, dir: d, memory: mem, brain, worker: brain, tools: reg, interactive: true, session: 'web-a', budget: { maxSteps: 8, maxWallMs: 30_000 } });
      expect(r.reason).toBe('done');
      const cards = listPendingActions();
      expect(cards).toHaveLength(1);
      expect(cards[0].kind).toBe('captured-policy');
      expect(cards[0].summary).toContain('British spelling');
      expect(r.history.join('\n')).toMatch(/replaced a shorter card for the same preference/);
    });
  }, 60_000);

  it('a reply that claims a staged effect is done opens with what is waiting instead', async () => {
    await withRun(async (mem, d) => {
      const copy: RegisteredTool = { def: { name: 'copy_thing', description: 'copy a file', parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } }, handler: async () => 'copied' };
      const reg = new ToolRegistry(); reg.register(requireApproval(copy, { preview: (a) => `Copy ${a.from} to ${a.to}` }));
      const brain = scripted([
        { action: 'copy_thing', from: 'supplier-list.txt', to: 'supplier-list-backup.txt' },
        { action: 'done', summary: 'Copied the supplier list to supplier-list-backup.txt.' },
      ]);
      const r = await runAgent({ instruction: 'Copy the supplier list to a backup.', userMessage: 'Copy the supplier list to a backup.', dir: d, memory: mem, brain, worker: brain, tools: reg, interactive: true, session: 'web-a', budget: { maxSteps: 6, maxWallMs: 30_000 } });
      expect(r.summary).toMatch(/^Waiting for your approval before anything changes: Copy supplier-list\.txt to supplier-list-backup\.txt\./);
      expect(r.summary).toContain('Copied the supplier list');
      expect(r.history.join('\n')).toMatch(/did not say an action was waiting for approval/);
    });
  }, 60_000);
});
