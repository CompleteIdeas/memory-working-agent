// v2 A10 review, H1: what the helper did reaches Today. The agent logs each side-effecting tool call through
// logToolAction (src/v2/actions.ts): the Glass Box history in a REAL AWM store (MwaMemory) and one app.db row. The
// review found Today saw none of it — AWM slugs the tool name (draft_email → draft-email) and merges similar entries
// into one memory — so Today now counts the app.db rows. A staged send is not logged as sent; the approval that runs
// it is.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MwaMemory } from '../src/awm.js';
import { resetAppDb } from '../src/v2/db.js';
import { logToolAction, actionsBetween, toolKey, stagedOnly } from '../src/v2/actions.js';
import { setTodayDeps, buildToday } from '../src/v2/today.js';
import { setCalendarSyncDeps } from '../src/sync/calendar.js';
import { setMailProviders } from '../src/sync/mail.js';
import { setApprovalStorePath, requireApproval, confirmPending } from '../src/tools/approval.js';
import type { RegisteredTool } from '../src/tools/registry.js';

let dir = '';
let memory: MwaMemory;
const prevCfg = process.env.MWA_CONFIG_PATH;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mwa-a10-actions-'));
  process.env.MWA_RUNLOG = join(dir, 'runs.jsonl');
  process.env.MWA_TOKEN_LOG = join(dir, 'tokens.jsonl');
  process.env.MWA_TRANSCRIPTS_DIR = join(dir, 'transcripts');
  process.env.MWA_CONFIG_PATH = join(dir, 'mwa.config.json');
  writeFileSync(process.env.MWA_CONFIG_PATH, JSON.stringify({ tools: { access: { preset: 'assistant', grantedRoots: [] } } }));
  memory = new MwaMemory('mwa-serve', join(dir, 'agent.db'));
  setCalendarSyncDeps({ connected: () => false });
  setMailProviders(() => []);
});
afterAll(() => {
  try { memory.close(); } catch { /* closed */ }
  setTodayDeps(null); setCalendarSyncDeps(null); setMailProviders(null); setApprovalStorePath(null);
  for (const k of ['MWA_RUNLOG', 'MWA_TOKEN_LOG', 'MWA_TRANSCRIPTS_DIR']) delete process.env[k];
  if (prevCfg === undefined) delete process.env.MWA_CONFIG_PATH; else process.env.MWA_CONFIG_PATH = prevCfg;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the AWM store still closing on Windows */ }
});
beforeEach(() => {
  resetAppDb(':memory:');
  setApprovalStorePath(join(dir, `approvals-${Math.random().toString(36).slice(2)}.db`));
  setTodayDeps({ now: () => Date.now(), tz: () => 'America/New_York', pendingApprovals: () => [], greetingName: () => null, month: () => ({ usedUsd: 0, limitUsd: null, state: 'none' }) });
});

// exactly what agent.ts logs for a draft_email call (its verb, effect and result text)
const drafted = (to: string, subject: string) => ({ verb: 'drafted an email', tool: 'draft_email', effect: 'local' as const, result: `Draft saved in Gmail (not sent). To: ${to}. Subject: ${subject}. Open it in Drafts to review and send.` });

describe('H1: the action log reaches Today', () => {
  it('three drafts → three Done-for-you lines and a count of 3, through a real AWM store', async () => {
    for (const [to, subj] of [['dana@example.com', 'Re: Thursday lesson'], ['sam@example.com', 'Re: lunch Friday'], ['ellen@example.com', 'Re: the invoice for October']]) {
      expect(await logToolAction(memory, { ...drafted(to, subj), session: 'web-1' })).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
    }
    // the AWM history keeps its own (slugged, merge-prone) shape — which is why Today does not count from it
    const awm = await memory.recentActions(300);
    expect(awm.length).toBeGreaterThanOrEqual(1);
    expect(awm.every((a) => a.tool === 'draft-email')).toBe(true);
    const t = await buildToday('session');
    expect(t.doneForYou.map((d) => d.kind)).toEqual(['reply-drafted', 'reply-drafted', 'reply-drafted']);
    expect(t.doneForYou[0].text).toBe('I drafted an email for you to check. Nothing was sent.');
    expect(t.weekLine.counts.repliesDrafted).toBe(3);
    expect(t.weekLine.text).toBe('In the last 7 days: 3 replies drafted.');
  }, 180_000);

  it('either spelling of a tool is the same tool', () => {
    expect(toolKey('draft-email')).toBe('draft_email');
    expect(toolKey(' Draft_Email ')).toBe('draft_email');
  });

  it('another person\'s run (a Telegram contact) is not the owner\'s "done for you"', async () => {
    await logToolAction(memory, { ...drafted('x@example.com', 'Re: hi'), person: 'tg-12345' });
    await logToolAction(memory, { ...drafted('y@example.com', 'Re: yo'), person: 'web-robert' });
    const t = await buildToday('session');
    expect(t.weekLine.counts.repliesDrafted).toBe(1);
    expect(actionsBetween(0, Date.now() + 1000)).toHaveLength(2); // both recorded, each with whom it was for
  }, 60_000);

  it('a staged send is not logged as sent; the approval that runs it is', async () => {
    let sent = 0;
    const sendTool: RegisteredTool = {
      def: { name: 'send_email', description: 'send', parameters: { type: 'object', properties: {}, required: [] } },
      handler: async () => { sent++; return 'Sent to dana@example.com.'; },
    };
    const staged = await requireApproval(sendTool).handler({ to: 'dana@example.com' }, { sandboxDir: dir, interactive: true, personId: 'web-robert', session: 'web-1' });
    expect(stagedOnly(staged)).toBe(true);
    expect(await logToolAction(memory, { verb: 'sent an email', tool: 'send_email', effect: 'external', result: staged, person: 'web-robert', session: 'web-1' })).toBe(false);
    expect(actionsBetween(0, Date.now() + 1000)).toEqual([]);
    expect((await memory.recentActions(300)).some((a) => a.tool === 'send-email')).toBe(false);
    let t = await buildToday('session');
    expect(t.doneForYou.some((d) => d.kind === 'email-sent')).toBe(false);
    // the person approves it: now it happened, and Today says so
    const id = /confirmation_id: (\S+)/.exec(staged)![1];
    expect(await confirmPending(id, { sandboxDir: dir, interactive: true })).toContain('[CONFIRMED send_email]');
    expect(sent).toBe(1);
    const rows = actionsBetween(0, Date.now() + 1000);
    expect(rows.map((r) => [r.tool, r.via, r.person])).toEqual([['send_email', 'approval', 'web-robert']]);
    t = await buildToday('session');
    expect(t.doneForYou.map((d) => [d.kind, d.text])).toEqual([['email-sent', 'I sent the email you approved.']]);
  }, 60_000);
});
