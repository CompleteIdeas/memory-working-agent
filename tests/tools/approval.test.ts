import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { requireApproval, approvalTools, setApprovalAudit, pendingCount } from '../../src/tools/approval.js';
import type { RegisteredTool, ToolContext } from '../../src/tools/registry.js';

// A spy tool: records every real execution so we can prove the wrapper does NOT
// run it until confirmed.
function makeSpyTool(): { tool: RegisteredTool; runs: () => number } {
  let runs = 0;
  const tool: RegisteredTool = {
    def: { name: 'danger_write', description: 'mutate prod', parameters: { type: 'object', properties: {}, required: [] } },
    handler: async (args) => {
      runs += 1;
      return `executed with ${JSON.stringify(args)}`;
    },
  };
  return { tool, runs: () => runs };
}

const ctxInteractive: ToolContext = { sandboxDir: '.', interactive: true };
const ctxScheduled: ToolContext = { sandboxDir: '.', interactive: false };

function tools() {
  const map = new Map(approvalTools().map((t) => [t.def.name, t]));
  return {
    confirm: map.get('confirm_action')!,
    cancel: map.get('cancel_action')!,
    list: map.get('list_pending')!,
  };
}

// Extract "confirmation_id: act_xxx" from a dry-run message.
function idFrom(msg: string): string {
  const m = msg.match(/confirmation_id:\s*(\S+)/);
  if (!m) throw new Error(`no confirmation_id in: ${msg}`);
  return m[1];
}

describe('two-step write approval', () => {
  beforeEach(() => {
    delete process.env.MWA_APPROVAL_TTL_MS;
    delete process.env.MWA_ALLOW_UNATTENDED_WRITES;
    setApprovalAudit(null);
    // drain any leftover pending from prior tests by cancelling via list
  });
  afterEach(() => setApprovalAudit(null));

  it('wrapping a tool prevents direct execution; returns a confirmation id + preview', async () => {
    const { tool, runs } = makeSpyTool();
    const wrapped = requireApproval(tool, { preview: (a) => `WOULD WRITE: ${JSON.stringify(a)}` });
    const out = await wrapped.handler({ row: 1 }, ctxInteractive);
    expect(out).toContain('[APPROVAL REQUIRED]');
    expect(out).toContain('WOULD WRITE: {"row":1}');
    expect(out).toMatch(/confirmation_id:\s*act_/);
    expect(runs()).toBe(0); // the real handler did NOT run
  });

  it('confirm_action runs the action exactly once (single-use)', async () => {
    const { tool, runs } = makeSpyTool();
    const wrapped = requireApproval(tool);
    const id = idFrom(await wrapped.handler({ x: 'y' }, ctxInteractive));
    const { confirm } = tools();

    const r1 = await confirm.handler({ confirmation_id: id }, ctxInteractive);
    expect(r1).toContain('[CONFIRMED danger_write]');
    expect(r1).toContain('executed with {"x":"y"}');
    expect(runs()).toBe(1);

    // replay must fail — single-use
    const r2 = await confirm.handler({ confirmation_id: id }, ctxInteractive);
    expect(r2).toMatch(/no pending action/);
    expect(runs()).toBe(1);
  });

  it('refuses to confirm in a non-interactive (scheduled) run unless overridden', async () => {
    const { tool, runs } = makeSpyTool();
    const wrapped = requireApproval(tool);
    const id = idFrom(await wrapped.handler({}, ctxScheduled));
    const { confirm } = tools();

    const refused = await confirm.handler({ confirmation_id: id }, ctxScheduled);
    expect(refused).toMatch(/refused/);
    expect(runs()).toBe(0);

    // explicit override lets it through
    process.env.MWA_ALLOW_UNATTENDED_WRITES = '1';
    const ok = await confirm.handler({ confirmation_id: id }, ctxScheduled);
    expect(ok).toContain('[CONFIRMED');
    expect(runs()).toBe(1);
  });

  it('expired confirmations cannot run', async () => {
    process.env.MWA_APPROVAL_TTL_MS = '0'; // expires immediately
    const { tool, runs } = makeSpyTool();
    const wrapped = requireApproval(tool);
    const id = idFrom(await wrapped.handler({}, ctxInteractive));
    const { confirm } = tools();
    const r = await confirm.handler({ confirmation_id: id }, ctxInteractive);
    expect(r).toMatch(/expired/);
    expect(runs()).toBe(0);
  });

  it('cancel discards a pending action', async () => {
    const { tool, runs } = makeSpyTool();
    const wrapped = requireApproval(tool);
    const id = idFrom(await wrapped.handler({}, ctxInteractive));
    const { cancel, confirm } = tools();
    const c = await cancel.handler({ confirmation_id: id }, ctxInteractive);
    expect(c).toMatch(/cancelled/);
    const after = await confirm.handler({ confirmation_id: id }, ctxInteractive);
    expect(after).toMatch(/no pending action/);
    expect(runs()).toBe(0);
  });

  it('audit hook fires on dryrun and confirm', async () => {
    const events: string[] = [];
    setApprovalAudit((ev, a) => events.push(`${ev}:${a.tool}`));
    const { tool } = makeSpyTool();
    const wrapped = requireApproval(tool);
    const id = idFrom(await wrapped.handler({}, ctxInteractive));
    const { confirm } = tools();
    await confirm.handler({ confirmation_id: id }, ctxInteractive);
    expect(events).toContain('dryrun:danger_write');
    expect(events).toContain('confirm:danger_write');
  });
});
