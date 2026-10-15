/**
 * BL-03 — approval the model can't give itself.
 *
 * Measured 2026-10-14 in Docker: the model staged a write and called confirm_action on it in the
 * SAME turn, with no human. The decision (call 3 of the 2026-10-14 decision review): approve only
 * through channels the model cannot call — the app's approvals panel and a Telegram Approve button
 * the connector handles — and refuse a confirm from the run that staged the action, product-wide.
 *
 *   1. The model's tools can decline and look, never approve.
 *   2. The measured self-approval no longer runs anything; the run reports `blocked` and hands
 *      the staged id back to its channel.
 *   3. Second guard: confirmPending refuses the staging run's own runId.
 *   4. An approved action runs in the context it was STAGED in, not the approver's.
 *   5. Telegram: a tap is honored only from the chat the button was offered to, once.
 *   6. Ids are unguessable; a tainted staging is flagged to the person.
 *   7. A scheduled fire that staged an approval reaches the person even under deliver=never.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../src/agent.js';
import { tickScheduler } from '../src/scheduler.js';
import { MwaMemory } from '../src/awm.js';
import { ToolRegistry, type RegisteredTool, type ToolContext } from '../src/tools/registry.js';
import { requireApproval, approvalTools, confirmPending, stageAction, listPendingActions, pendingMeta } from '../src/tools/approval.js';
import { handleApprovalCallback, approvalCardText } from '../src/connectors/telegram.js';
import { claimOffer } from '../src/tools/approval.js';
import type { Provider, ChatResult, ChatInput } from '../src/provider.js';

function scripted(script: Record<string, unknown>[]) {
  let n = 0;
  const brain: Provider = {
    id: 'stub', model: 'stub', price: [0, 0],
    chat: async (input: ChatInput): Promise<ChatResult> => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      return { text: JSON.stringify(script[n++] ?? { action: 'done', summary: 'Done.' }), usage: { input: 1, output: 1 } };
    },
  };
  return { brain };
}
async function withMemory<T>(fn: (dir: string, mem: MwaMemory) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mwa-appr-'));
  const mem = new MwaMemory('appr-test', join(dir, 'a.db'));
  try { return await fn(dir, mem); } finally { mem.close(); rmSync(dir, { recursive: true, force: true }); }
}
function spy(): { tool: RegisteredTool; calls: ToolContext[] } {
  const calls: ToolContext[] = [];
  return {
    calls,
    tool: {
      def: { name: 'danger_write', description: 'writes something lasting', parameters: { type: 'object', properties: {}, required: [] } },
      handler: async (_a, ctx) => { calls.push(ctx); return 'written'; },
    },
  };
}
const prev = process.env.MWA_FAST_CHAT;
beforeAll(() => { process.env.MWA_FAST_CHAT = '0'; });
afterAll(() => { if (prev === undefined) delete process.env.MWA_FAST_CHAT; else process.env.MWA_FAST_CHAT = prev; });

describe('the model cannot approve', () => {
  it('its approval tools are decline and look, nothing that approves', () => {
    expect(approvalTools().map((t) => t.def.name).sort()).toEqual(['approval_results', 'cancel_action', 'list_pending']); // look, decline, read outcomes — never approve
  });

  it('the measured self-approval (stage, then confirm in the same turn) runs nothing, and the run is blocked', async () => {
    const s = spy();
    const tools = new ToolRegistry();
    tools.registerAll([requireApproval(s.tool), ...approvalTools()]);
    const { brain } = scripted([
      { action: 'danger_write' },
      { action: 'confirm_action' }, // the exact move measured on 2026-10-14 — no longer a tool
      { action: 'done', summary: 'Saved it.', outcome: 'changed' },
    ]);
    const r = await withMemory((dir, mem) => runAgent({ instruction: 'save this', dir, memory: mem, brain, worker: brain, interactive: true, tools, budget: { maxSteps: 5, maxWallMs: 20_000 } }));
    expect(s.calls).toHaveLength(0);              // nothing ran
    expect(r.outcome).toBe('blocked');            // the claim "changed" doesn't stand: it waits on a person
    expect(r.staged).toHaveLength(1);             // handed back for the channel to offer
    expect(pendingMeta(r.staged![0])?.tool).toBe('danger_write');
  }, 30_000);
});

describe('confirmPending: the second guard and the staged context', () => {
  it('refuses a confirm carrying the runId that staged the action; a person (no runId) can approve', async () => {
    const s = spy();
    const id = stageAction({ tool: 'danger_write', summary: 'write', ctx: { sandboxDir: '/staged', interactive: true, runId: 'run-1' }, execute: (c) => s.tool.handler({}, c) });
    expect(await confirmPending(id, { sandboxDir: '.', interactive: true, runId: 'run-1' })).toMatch(/cannot be approved by the run that staged it/);
    expect(s.calls).toHaveLength(0);
    expect(await confirmPending(id, { sandboxDir: '.', interactive: true })).toContain('[CONFIRMED danger_write]');
    expect(s.calls).toHaveLength(1);
  });

  it('runs in the context it was staged in — its folder and person — as interactive and untainted', async () => {
    const s = spy();
    const id = stageAction({ tool: 'danger_write', summary: 'write', ctx: { sandboxDir: '/chat-folder', interactive: false, personId: 'p1', tainted: true, runId: 'r2' }, execute: (c) => s.tool.handler({}, c) });
    await confirmPending(id, { sandboxDir: '/approver', interactive: true });
    expect(s.calls[0].sandboxDir).toBe('/chat-folder');
    expect(s.calls[0].personId).toBe('p1');
    expect(s.calls[0].interactive).toBe(true);
    expect(s.calls[0].tainted).toBe(false);
  });

  it('ids are unguessable, and a staging by a tainted run is flagged for the person', () => {
    const a = stageAction({ tool: 'x', summary: 's', ctx: { sandboxDir: '.', tainted: true }, execute: async () => '' });
    const b = stageAction({ tool: 'x', summary: 's', ctx: { sandboxDir: '.' }, execute: async () => '' });
    expect(a).toMatch(/^act_[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    const view = listPendingActions();
    expect(view.find((v) => v.id === a)?.tainted).toBe(true);
    expect(view.find((v) => v.id === b)?.tainted).toBe(false);
    expect(approvalCardText(a)).toContain('read outside content');
  });
});

describe('Telegram Approve button', () => {
  it('honors a tap only from the chat it was offered to, once', async () => {
    const s = spy();
    const id = stageAction({ tool: 'danger_write', summary: 'write', ctx: { sandboxDir: '.', interactive: true }, execute: (c) => s.tool.handler({}, c) });
    expect(claimOffer(id, '111')).toBe(true);
    expect(await handleApprovalCallback(`ap:${id}`, '222', '.', undefined, { userId: '111', approvers: new Set(['111']) })).toMatch(/not offered in this chat/);
    expect(await handleApprovalCallback('ap:act_nothex', '111', '.', undefined, { userId: '111', approvers: new Set(['111']) })).toMatch(/not an approval button/);
    expect(s.calls).toHaveLength(0);
    expect(await handleApprovalCallback(`ap:${id}`, '111', '.', undefined, { userId: '111', approvers: new Set(['111']) })).toContain('[CONFIRMED danger_write]');
    expect(s.calls).toHaveLength(1);
    expect(await handleApprovalCallback(`ap:${id}`, '111', '.', undefined, { userId: '111', approvers: new Set(['111']) })).toMatch(/already done/); // replay
    expect(s.calls).toHaveLength(1);
  });

  it('Cancel discards it without running', async () => {
    const s = spy();
    const id = stageAction({ tool: 'danger_write', summary: 'write', ctx: { sandboxDir: '.' }, execute: (c) => s.tool.handler({}, c) });
    claimOffer(id, '111');
    expect(await handleApprovalCallback(`cx:${id}`, '111', '.', undefined, { userId: '111', approvers: new Set(['111']) })).toMatch(/cancelled/);
    expect(pendingMeta(id)).toBeUndefined();
    expect(s.calls).toHaveLength(0);
  });
});

describe('a scheduled fire that staged an approval', () => {
  it('reaches the person even under deliver=never, carrying the staged id', async () => {
    const outRoot = mkdtempSync(join(tmpdir(), 'mwa-appr-sched-'));
    const fired: Record<string, unknown>[] = [];
    const memory = {
      async pendingScheduled() { return [{ id: 'job11111', instruction: 'Tidy my notes', due: 1, recur: 'every:60', deliver: 'never' }]; },
      async completeScheduled() { /* */ }, async rescheduleTask() { /* */ }, async setScheduledSignature() { /* */ }, async setPendingComplete() { /* */ },
    } as never;
    try {
      await tickScheduler({
        memory, brain: {} as never, worker: {} as never, outRoot, now: () => 10_000,
        onFire: async (_t, r) => { fired.push(r as unknown as Record<string, unknown>); },
        runAgent: (async () => ({ summary: 'Staged a change for you.', reason: 'done', outcome: 'blocked', staged: ['act_0123456789abcdef'], steps: 2, toolCalls: 1, costUsd: 0, durationMs: 1 })) as never,
      });
    } finally { rmSync(outRoot, { recursive: true, force: true }); }
    expect(fired).toHaveLength(1);
    expect(fired[0].staged).toEqual(['act_0123456789abcdef']);
  });
});

describe('approving after the turn has ended (the serve lifecycle)', () => {
  it('a captured preference approved after the turn closed its memory is still saved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-appr-life-'));
    try {
      const db = join(dir, 'a.db');
      const turnMemory = new MwaMemory('appr-life', db);
      const { brain } = scripted([]);
      const r = await runAgent({
        instruction: 'standing preference: always answer in plain words', userMessage: 'standing preference: always answer in plain words',
        dir, memory: turnMemory, brain, worker: brain, interactive: true, budget: { maxSteps: 3, maxWallMs: 20_000 },
      });
      turnMemory.close(); // serve closes the turn's memory as soon as the turn ends
      const id = (r.staged ?? []).find((x) => pendingMeta(x)?.summary.includes('plain words'));
      expect(id).toBeDefined();
      const out = await confirmPending(id!, { sandboxDir: dir, interactive: true });
      expect(out).toContain('standing preference saved'); // was "(not saved — the memory filter declined it)"
      turnMemory.close();
      const check = new MwaMemory('appr-life', db);
      try { expect((await check.listPolicies()).join(' ')).toContain('plain words'); } finally { check.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
