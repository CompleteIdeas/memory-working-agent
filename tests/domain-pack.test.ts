import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDomainPack, selectTopics, buildDomainContext } from '../src/domain-pack.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mwa-pack-'));
  writeFileSync(join(dir, 'AGENT.md'), '# Support Agent\nAlways verify a fact with a query before stating it. Sign off as -CC.');
  const td = join(dir, 'topics');
  mkdirSync(td);
  writeFileSync(join(td, 'db-schema.md'), '# Database schema\nThe member table tblMemberDetails has columns member_id, status. Use SQL SELECT to query it.');
  writeFileSync(join(td, 'freshdesk.md'), '# Freshdesk tickets\nTriage a support ticket: fetch the ticket, identify the requester, investigate.');
  writeFileSync(join(td, 'leaderboards.md'), '# Leaderboards\nPoints standings and area program rankings for the championship.');
});

afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

describe('domain pack', () => {
  it('loads AGENT.md + topics', () => {
    const pack = loadDomainPack(dir)!;
    expect(pack).not.toBeNull();
    expect(pack.agentMd).toContain('Sign off as -CC');
    expect(pack.topics.map((t) => t.name).sort()).toEqual(['db-schema', 'freshdesk', 'leaderboards']);
  });

  it('selects the SQL topic for a query-the-table task', () => {
    const pack = loadDomainPack(dir)!;
    const sel = selectTopics(pack, 'how do I query the member table in sql', 2);
    expect(sel[0].name).toBe('db-schema');
  });

  it('selects the freshdesk topic for a ticket task', () => {
    const pack = loadDomainPack(dir)!;
    const sel = selectTopics(pack, 'triage and investigate a support ticket for the requester', 2);
    expect(sel.map((t) => t.name)).toContain('freshdesk');
    expect(sel.map((t) => t.name)).not.toContain('leaderboards');
  });

  it('buildDomainContext includes AGENT.md + the relevant topic, and caps length', () => {
    const pack = loadDomainPack(dir)!;
    const ctx = buildDomainContext(pack, 'query the member table', { topN: 1, maxChars: 100000 });
    expect(ctx).toContain('# Domain knowledge');
    expect(ctx).toContain('Sign off as -CC'); // AGENT.md always
    expect(ctx).toContain('tblMemberDetails'); // selected topic
    const capped = buildDomainContext(pack, 'query the member table', { topN: 3, maxChars: 50 });
    expect(capped.length).toBeLessThanOrEqual('# Domain knowledge (loaded for this task — verify specifics before acting)\n\n'.length + 50);
  });

  it('empty query selects nothing', () => {
    const pack = loadDomainPack(dir)!;
    expect(selectTopics(pack, '', 3)).toEqual([]);
  });

  it('returns null for a non-existent pack dir', () => {
    expect(loadDomainPack(join(dir, 'does-not-exist'))).toBeNull();
  });
});
