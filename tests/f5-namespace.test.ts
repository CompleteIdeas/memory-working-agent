import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MwaMemory } from '../src/awm.js';

/**
 * F5 (Soft Namespaces) — topic-scoped recall with NO cross-topic bleed. The same primitive serves
 * the consumer (rapid task-switching never drags in an unrelated task's facts) AND the harness
 * (scoped memory per agent/topic) — without any fleet UI. Global facts (no namespace) stay visible
 * across every topic, so user preferences aren't trapped in one scope.
 */
describe('F5 soft namespaces: topic-scoped recall, no cross-topic bleed', () => {
  let dir: string;
  let mem: MwaMemory;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mwa-ns-'));
    mem = new MwaMemory('ns-test', join(dir, 'ns.db'));
    await mem.write('atlas deadline', 'Project Atlas deadline is March 14', ['topic=t'], { canonical: true, provenance: 'user', namespace: 'project-atlas' });
    await mem.write('beacon deadline', 'Project Beacon deadline is July 9', ['topic=t'], { canonical: true, provenance: 'user', namespace: 'project-beacon' });
    await mem.write('summary pref', 'Robert prefers concise five-bullet summaries', ['topic=t'], { canonical: true, provenance: 'user' });
  });
  afterAll(() => { try { mem.close(); } catch { /* */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('recall scoped to project-atlas returns Atlas, NEVER Beacon (the no-bleed guarantee)', async () => {
    const c = (await mem.recall('what is the project deadline', { limit: 10, full: true, namespace: 'project-atlas' })).map((h) => h.content).join(' | ');
    expect(c).toContain('March 14');
    expect(c).not.toContain('July 9');
  }, 60_000);

  it('recall scoped to project-beacon returns Beacon, NEVER Atlas', async () => {
    const c = (await mem.recall('what is the project deadline', { limit: 10, full: true, namespace: 'project-beacon' })).map((h) => h.content).join(' | ');
    expect(c).toContain('July 9');
    expect(c).not.toContain('March 14');
  }, 60_000);

  it('UNSCOPED recall sees both topics (cross-topic on demand)', async () => {
    const c = (await mem.recall('what is the project deadline', { limit: 10, full: true })).map((h) => h.content).join(' | ');
    expect(c).toContain('March 14');
    expect(c).toContain('July 9');
  }, 60_000);

  it('a global (no-namespace) fact stays visible from inside any topic scope', async () => {
    const c = (await mem.recall('how does Robert like his summaries', { limit: 10, full: true, namespace: 'project-atlas' })).map((h) => h.content).join(' | ');
    expect(c).toContain('concise five-bullet summaries');
  }, 60_000);

  it('setNamespace scopes recall by default; a policy written via savePolicy stays GLOBAL', async () => {
    await mem.savePolicy('Always cc Robert on outgoing email'); // global helper → no ns tag
    mem.setNamespace('project-atlas');
    const atlas = (await mem.recall('what is the project deadline', { limit: 10, full: true })).map((h) => h.content).join(' | ');
    expect(atlas).toContain('March 14');   // instance default scopes to atlas
    expect(atlas).not.toContain('July 9'); // ...and excludes beacon, with no per-call namespace arg
    const policy = (await mem.recall('cc rule for outgoing email', { limit: 10, full: true })).map((h) => h.content).join(' | ');
    expect(policy).toContain('cc Robert'); // the policy is reachable from inside the atlas scope (global)
    mem.setNamespace(); // clear → cross-topic again
    const unscoped = (await mem.recall('what is the project deadline', { limit: 10, full: true })).map((h) => h.content).join(' | ');
    expect(unscoped).toContain('July 9');
  }, 60_000);
});
