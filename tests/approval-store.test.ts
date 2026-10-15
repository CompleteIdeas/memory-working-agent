/**
 * BL-18 — one approval store both channels share, that survives a restart.
 *
 * Pending approvals used to be closures in a per-process Map: the web app and the Telegram connector
 * (separate processes, each with a scheduler) never saw each other's, and a restart dropped
 * everything waiting. Now they live in a SQLite file as DATA (tool, arguments, staged context) and run
 * through an executor each process registers by tool name. A "restart" here is closing the store and
 * reopening the same file; "another process" is a confirm with no closure from the staging side.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  setApprovalStorePath, requireApproval, stageAction, registerExecutor, confirmPending, pendingCount, approvalStatus,
  claimOffer, releaseOffer, unofferedFor, approvalTools, listPendingActions, setApprovalOwner, runApproved, setOfferMessage, recentApprovalOutcomes,
} from '../src/tools/approval.js';
import { builtinTools } from '../src/tools/builtins.js';
import { handleApprovalCallback, approversFromEnv } from '../src/connectors/telegram.js';
import type { RegisteredTool, ToolContext } from '../src/tools/registry.js';

let dir = '';
let file = '';
const prevCfg = process.env.MWA_CONFIG_PATH;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mwa-approvals-'));
  process.env.MWA_CONFIG_PATH = join(dir, 'mwa.config.json');
  writeFileSync(process.env.MWA_CONFIG_PATH, JSON.stringify({ tools: { access: { preset: 'assistant', grantedRoots: [] } } }));
});
beforeEach(() => { file = join(dir, `approvals-${Math.random().toString(36).slice(2)}.db`); setApprovalStorePath(file); });
afterAll(() => {
  setApprovalStorePath(null);
  if (prevCfg === undefined) delete process.env.MWA_CONFIG_PATH; else process.env.MWA_CONFIG_PATH = prevCfg;
  rmSync(dir, { recursive: true, force: true });
});
const restart = () => setApprovalStorePath(file);
function counter(name: string): { tool: RegisteredTool; calls: ToolContext[] } {
  const calls: ToolContext[] = [];
  return { calls, tool: { def: { name, description: 'd', parameters: { type: 'object', properties: {}, required: [] } }, handler: async (_a, ctx) => { calls.push(ctx); return 'written'; } } };
}

describe('the store', () => {
  it('survives a restart, and the action runs from its stored data, in the context it was staged in', async () => {
    const c = counter('store_write_a');
    const out = await requireApproval(c.tool).handler({ row: 7 }, { sandboxDir: '/staged/here', interactive: true, personId: 'robert' });
    const id = /confirmation_id: (\S+)/.exec(out)![1];
    restart();
    expect(pendingCount()).toBe(1);
    expect(await confirmPending(id, { sandboxDir: '/approver', interactive: true })).toContain('[CONFIRMED store_write_a]');
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0].sandboxDir).toBe('/staged/here');
    expect(approvalStatus(id)?.status).toBe('done');
  });

  it('a process without the executor refuses and leaves it pending; one with it runs it', async () => {
    const id = stageAction({ tool: 'only_elsewhere', summary: 's', args: { n: 1 }, ctx: { sandboxDir: '.' } });
    expect(await confirmPending(id, { sandboxDir: '.', interactive: true })).toMatch(/can't run "only_elsewhere"/);
    expect(approvalStatus(id)?.status).toBe('pending');
    let got: Record<string, unknown> = {};
    registerExecutor('only_elsewhere', async (args) => { got = args; return 'ran'; });
    expect(await confirmPending(id, { sandboxDir: '.', interactive: true })).toContain('[CONFIRMED only_elsewhere]');
    expect(got).toEqual({ n: 1 });
  });

  it('two confirms at once run it exactly once', async () => {
    let runs = 0;
    registerExecutor('slow_once', async () => { runs++; await new Promise((r) => setTimeout(r, 50)); return 'ok'; });
    const id = stageAction({ tool: 'slow_once', summary: 's', ctx: { sandboxDir: '.' } });
    const [a, b] = await Promise.all([confirmPending(id, { sandboxDir: '.', interactive: true }), confirmPending(id, { sandboxDir: '.', interactive: true })]);
    expect(runs).toBe(1);
    expect([a, b].filter((x) => x.startsWith('[CONFIRMED'))).toHaveLength(1);
  });

  it('expiry is checked in the claim itself', async () => {
    registerExecutor('late', async () => 'ran');
    const id = stageAction({ tool: 'late', summary: 's', ctx: { sandboxDir: '.' }, ttlMs: 0 });
    expect(await confirmPending(id, { sandboxDir: '.', interactive: true })).toMatch(/expired/);
    expect(approvalStatus(id)?.status).toBe('expired');
  });

  it('a failure is recorded, not lost', async () => {
    registerExecutor('boom', async () => { throw new Error('disk full'); });
    const id = stageAction({ tool: 'boom', summary: 's', ctx: { sandboxDir: '.' } });
    expect(await confirmPending(id, { sandboxDir: '.', interactive: true })).toMatch(/failed: disk full/);
    expect(approvalStatus(id)).toEqual({ status: 'failed', result: 'disk full' });
  });

  it('an action a crash left half-run is marked interrupted, never replayed', async () => {
    const id = stageAction({ tool: 'x', summary: 's', ctx: { sandboxDir: '.' } });
    const raw = new Database(file);
    raw.prepare(`UPDATE approvals SET status = 'executing', updated_at = ? WHERE id = ?`).run(Date.now() - 20 * 60_000, id);
    raw.close();
    pendingCount(); // any read sweeps
    expect(approvalStatus(id)?.status).toBe('failed');
    expect(approvalStatus(id)?.result).toMatch(/interrupted/);
  });

  it('a staged command (run_command) runs from the store after a restart', async () => {
    const [run] = builtinTools(['run_command']);
    const work = mkdtempSync(join(tmpdir(), 'mwa-approvals-cmd-'));
    try {
      const out = await run.handler({ command: `node -e "require('fs').writeFileSync('made.txt','x')"` }, { sandboxDir: work, interactive: true });
      const id = /confirmation_id: (\S+)/.exec(out)![1];
      restart();
      expect(await confirmPending(id, { sandboxDir: '.', interactive: true })).toContain('[CONFIRMED run_command]');
      expect(existsSync(join(work, 'made.txt'))).toBe(true);
    } finally { rmSync(work, { recursive: true, force: true }); }
  }, 30_000);
});

describe('channels', () => {
  it('an action is offered once, by whichever process claims it first; a failed send releases it', () => {
    const id = stageAction({ tool: 'x', summary: 's', ctx: { sandboxDir: '.', session: 'tg-111' } });
    expect(unofferedFor(['tg-111'])).toContain(id);
    expect(unofferedFor(['tg-999'])).not.toContain(id);
    expect(claimOffer(id, '111')).toBe(true);
    expect(claimOffer(id, '111')).toBe(false);
    expect(unofferedFor(['tg-111'])).not.toContain(id);
    releaseOffer(id);
    expect(unofferedFor(['tg-111'])).toContain(id);
  });

  it('a Telegram tap is honored only from someone allowed individually', async () => {
    registerExecutor('tap_x', async () => 'ok');
    const id = stageAction({ tool: 'tap_x', summary: 's', ctx: { sandboxDir: '.' } });
    claimOffer(id, '-100500'); // a group chat
    const approvers = approversFromEnv({ TELEGRAM_ALLOWED_CHATS: '-100500', TELEGRAM_ALLOWED_USERS: '42' });
    expect(await handleApprovalCallback(`ap:${id}`, '-100500', '.', undefined, { userId: 7, approvers })).toMatch(/not allowed to approve/);
    expect(await handleApprovalCallback(`ap:${id}`, '-100500', '.', undefined, { userId: 42, approvers })).toContain('[CONFIRMED tap_x]');
  });

  it('the model lists and cancels only its own conversation’s actions; the app lists all', async () => {
    const mine = stageAction({ tool: 'x', summary: 'mine', ctx: { sandboxDir: '.', session: 'web-a' } });
    const theirs = stageAction({ tool: 'x', summary: 'theirs', ctx: { sandboxDir: '.', session: 'tg-222' } });
    const [cancel, list] = approvalTools();
    const listed = await list.handler({}, { sandboxDir: '.', session: 'web-a' });
    expect(listed).toContain(mine);
    expect(listed).not.toContain(theirs);
    expect(await cancel.handler({ confirmation_id: theirs }, { sandboxDir: '.', session: 'web-a' })).toMatch(/no pending action/);
    expect(listPendingActions().map((a) => a.id)).toEqual(expect.arrayContaining([mine, theirs]));
  });
});

describe('BL-18 review fixes', () => {
  const raw = (sql: string, ...args: unknown[]) => { const d = new Database(file); try { d.prepare(sql).run(...args); } finally { d.close(); } };

  it('an approval for another process’s action is recorded, then runs in THAT process (its memory), not the approver’s', async () => {
    let ranIn = '';
    setApprovalOwner('mwa-agent');           // the Telegram process stages it
    registerExecutor('owned_write', async () => { ranIn = 'the owner'; return 'saved'; });
    const id = stageAction({ tool: 'owned_write', summary: 's', ctx: { sandboxDir: '.', session: 'tg-111' } });
    setApprovalOwner('mwa-serve');           // the web app approves it
    expect(await confirmPending(id, { sandboxDir: '.', interactive: true })).toMatch(/\[APPROVED owned_write\] It runs in Telegram/);
    expect(ranIn).toBe('');
    expect(approvalStatus(id)?.status).toBe('approved');
    expect(await runApproved()).toEqual([]);  // the web app never runs another identity's action
    setApprovalOwner('mwa-agent');           // the owner's next sweep
    const done = await runApproved();
    expect(done.map((d) => [d.id, d.ok, d.session])).toEqual([[id, true, 'tg-111']]);
    expect(ranIn).toBe('the owner');
    expect(approvalStatus(id)?.status).toBe('done');
    setApprovalOwner('local');
  });

  it('an approval the owner never picks up fails after a day instead of waiting forever', () => {
    setApprovalOwner('mwa-agent');
    const id = stageAction({ tool: 'x', summary: 's', ctx: { sandboxDir: '.' } });
    setApprovalOwner('local');
    raw(`UPDATE approvals SET status = 'approved', updated_at = ? WHERE id = ?`, Date.now() - 25 * 3_600_000, id);
    expect(approvalStatus(id)?.status).toBe('failed');
  });

  it('a finished action’s arguments are blanked at once, and the row is gone after a week', async () => {
    registerExecutor('secretive', async () => 'ok');
    const id = stageAction({ tool: 'secretive', summary: 's', args: { token: 'sk-secret' }, ctx: { sandboxDir: '.' } });
    await confirmPending(id, { sandboxDir: '.', interactive: true });
    const d = new Database(file); const args = (d.prepare('SELECT args FROM approvals WHERE id = ?').get(id) as { args: string }).args; d.close();
    expect(args).toBe('{}');
    raw('UPDATE approvals SET updated_at = ? WHERE id = ?', Date.now() - 8 * 24 * 3_600_000, id);
    expect(approvalStatus(id)).toBeNull();
  });

  it('a run with neither a session nor a person sees and cancels nothing', async () => {
    const id = stageAction({ tool: 'x', summary: 's', ctx: { sandboxDir: '.' } }); // a mailbox-style row
    const [cancel, list] = approvalTools();
    expect(await list.handler({}, { sandboxDir: '.' })).toBe('(no pending actions)');
    expect(await cancel.handler({ confirmation_id: id }, { sandboxDir: '.' })).toMatch(/no pending action/);
  });

  it('a card claimed but never sent (a crash) can be offered again after two minutes', () => {
    const id = stageAction({ tool: 'x', summary: 's', ctx: { sandboxDir: '.', session: 'tg-111' } });
    expect(claimOffer(id, '111')).toBe(true);
    expect(unofferedFor(['tg-111'])).not.toContain(id);
    raw('UPDATE approvals SET updated_at = ? WHERE id = ?', Date.now() - 3 * 60_000, id);
    expect(unofferedFor(['tg-111'])).toContain(id);
    expect(claimOffer(id, '111')).toBe(true);
    setOfferMessage(id, 5);
    raw('UPDATE approvals SET updated_at = ? WHERE id = ?', Date.now() - 3 * 60_000, id);
    expect(claimOffer(id, '111')).toBe(false); // sent: never re-claimed
  });

  it('a staged command approved after a switch to Locked-down does not run', async () => {
    const [run] = builtinTools(['run_command']);
    const work = mkdtempSync(join(tmpdir(), 'mwa-approvals-lock-'));
    try {
      const out = await run.handler({ command: `node -e "require('fs').writeFileSync('made.txt','x')"` }, { sandboxDir: work, interactive: true });
      const id = /confirmation_id: (\S+)/.exec(out)![1];
      writeFileSync(process.env.MWA_CONFIG_PATH!, JSON.stringify({ tools: { access: { preset: 'locked-down', grantedRoots: [] } } }));
      expect(await confirmPending(id, { sandboxDir: '.', interactive: true })).toMatch(/failed: running commands is off in Locked-down/);
      expect(existsSync(join(work, 'made.txt'))).toBe(false);
    } finally {
      writeFileSync(process.env.MWA_CONFIG_PATH!, JSON.stringify({ tools: { access: { preset: 'assistant', grantedRoots: [] } } }));
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('BL-18 second review', () => {
  const raw = (sql: string, ...args: unknown[]) => { const d = new Database(file); try { d.prepare(sql).run(...args); } finally { d.close(); } };

  it('an approval its owner picks up too late is expired, not run (no surprise command a day later)', async () => {
    let runs = 0;
    registerExecutor('late_cmd', async () => { runs++; return 'ran'; });
    setApprovalOwner('mwa-agent');
    const id = stageAction({ tool: 'late_cmd', summary: 's', ctx: { sandboxDir: '.' } }); // 10-minute life
    setApprovalOwner('mwa-serve');
    await confirmPending(id, { sandboxDir: '.', interactive: true });       // approved on the web
    raw('UPDATE approvals SET updated_at = ?, expires_at = ? WHERE id = ?', Date.now() - 20 * 3_600_000, Date.now() - 19 * 3_600_000, id);
    setApprovalOwner('mwa-agent');                                          // Telegram comes back hours later
    expect(await runApproved()).toEqual([]);
    expect(runs).toBe(0);
    expect(approvalStatus(id)?.status).toBe('expired');
    setApprovalOwner('local');
  });

  it('the app lists what it approved for another app, and what failed, so "[APPROVED]" isn\u2019t the last word', async () => {
    setApprovalOwner('mwa-agent');
    const id = stageAction({ tool: 'waiting_tool', summary: 's', ctx: { sandboxDir: '.' } });
    setApprovalOwner('mwa-serve');
    await confirmPending(id, { sandboxDir: '.', interactive: true });
    const r = recentApprovalOutcomes().find((x) => x.id === id);
    expect(r).toMatchObject({ status: 'approved', tool: 'waiting_tool', owner: 'Telegram or the mailbox' });
    setApprovalOwner('local');
  });

  it('what a finished action said is cleared after a day', async () => {
    registerExecutor('noisy', async () => 'token=sk-123');
    const id = stageAction({ tool: 'noisy', summary: 'curl -H "Authorization: Bearer sk-123"', ctx: { sandboxDir: '.' } });
    await confirmPending(id, { sandboxDir: '.', interactive: true });
    raw('UPDATE approvals SET updated_at = ? WHERE id = ?', Date.now() - 25 * 3_600_000, id);
    pendingCount();
    const d = new Database(file); const row = d.prepare('SELECT summary, result FROM approvals WHERE id = ?').get(id) as { summary: string; result: string | null }; d.close();
    expect(row).toEqual({ summary: '(cleared)', result: null });
  });
});

