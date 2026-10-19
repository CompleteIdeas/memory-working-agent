/**
 * BL-50 — a list of what needs the person. Measured in BL-40: "What still needs my attention this coming
 * week?" was answered with MWA's own job schedule; the lease renewal, a new wedding inquiry and a day-off
 * swap its briefs had seen went unmentioned.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MwaMemory } from '../src/awm.js';
import { openItemTools } from '../src/tools/open-items.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { KNOWLEDGE_TOOLS } from '../src/memory-off.js';
import { jobContext } from '../src/agent.js';
import { classifyTool, outputSource } from '../src/tools/governance.js';

async function withTools<T>(fn: (reg: ToolRegistry, mem: MwaMemory) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mwa-bl50-'));
  const mem = new MwaMemory('bl50', join(dir, 'm.db'));
  try { const reg = new ToolRegistry(); reg.registerAll(openItemTools(mem)); return await fn(reg, mem); }
  finally { mem.close(); rmSync(dir, { recursive: true, force: true }); }
}
const maya = (over: Record<string, unknown> = {}) => ({ sandboxDir: '.', personId: 'maya', runId: 'run-1', ...over }) as never;

describe('open items', () => {
  it('a brief adds them, the same item again only refreshes it, and the list is soonest-due first', async () => {
    await withTools(async (reg, mem) => {
      expect(await reg.call('open_item_add', { what: 'Lease renewal decision', due: '2026-11-30', source: 'email from landlord' }, maya({ tainted: true }))).toMatch(/^added open item/);
      expect(await reg.call('open_item_add', { what: 'Reply to Carlos & Mei about their Sept 18 wedding', who: 'Carlos & Mei', due: '2026-11-12' }, maya({ tainted: true }))).toMatch(/^added/);
      expect(await reg.call('open_item_add', { what: 'reply to Carlos & Mei about their Sept 18 wedding.', due: '2026-11-11' }, maya({ runId: 'run-2', tainted: true }))).toMatch(/^refreshed/);
      expect(await reg.call('open_item_add', { what: "Leo's day-off swap request" }, maya({ tainted: true }))).toMatch(/^added/);
      const out = String(await reg.call('open_items', {}, maya()));
      const lines = out.split('\n').slice(1);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatch(/Reply to Carlos & Mei .* due 2026-11-11/); // refreshed due date
      expect(lines[1]).toMatch(/Lease renewal decision · due 2026-11-30/);
      expect(lines[2]).toMatch(/Leo's day-off swap request/); // undated last
      // Read from an inbox: stored untrusted.
      expect((await mem.listOpenItems('maya')).every((o) => o.trust === 'untrusted')).toBe(true);
    });
  });

  it('closing one takes it off the list; another person never sees them', async () => {
    await withTools(async (reg, mem) => {
      await reg.call('open_item_add', { what: 'Pay Ocean State Power $142.37', due: '2026-11-09' }, maya());
      const [item] = await mem.listOpenItems('maya');
      expect(await reg.call('open_item_close', { id: item.id.slice(0, 8), why: 'paid' }, maya())).toMatch(/^closed/);
      expect(await reg.call('open_items', {}, maya())).toBe('(no open items recorded)');
      expect((await mem.listOpenItems('maya', true))[0]).toMatchObject({ status: 'closed', closedWhy: 'paid' });
      await reg.call('open_item_add', { what: 'Maya only' }, maya());
      expect(await reg.call('open_items', {}, maya({ personId: 'sam' }))).toBe('(no open items recorded)');
    });
  });

  it('a bad due date or an empty item is refused; one run adds at most 12', async () => {
    await withTools(async (reg) => {
      expect(await reg.call('open_item_add', { what: 'x', due: 'Friday' }, maya())).toMatch(/say what the item is|due must be/);
      expect(await reg.call('open_item_add', { what: 'Something real', due: 'Friday' }, maya())).toMatch(/due must be YYYY-MM-DD/);
      for (let i = 0; i < 12; i++) await reg.call('open_item_add', { what: `Item number ${i}` }, maya({ runId: 'flood' }));
      expect(await reg.call('open_item_add', { what: 'Item thirteen' }, maya({ runId: 'flood' }))).toMatch(/refused: 12 items/);
    });
  });

  it('memory off has no list (it is memory); the list reads as outside content', () => {
    for (const t of ['open_item_add', 'open_item_close', 'open_items']) expect(KNOWLEDGE_TOOLS.has(t)).toBe(true);
    expect(classifyTool('open_items')).toBe('read');
    expect(outputSource('open_items')).toBe('external');
  });

  it('a fire is told to keep the list only when it has the tool', () => {
    expect(jobContext({ jobId: 'j', openItems: true }, Date.now(), (_l, t) => t).join('\n')).toMatch(/record it with open_item_add/);
    expect(jobContext({ jobId: 'j' }, Date.now(), (_l, t) => t).join('\n')).not.toMatch(/open_item_add/);
  });
});
