import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSources } from '../src/onboard.js';
import { onboardTools } from '../src/tools/onboard.js';
import type { ToolContext } from '../src/tools/registry.js';

let box: string; // sandbox dir the "user" granted

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'mwa-onb-'));
  const docs = join(box, 'docs');
  mkdirSync(docs);
  writeFileSync(join(docs, 'architecture.md'),
    '# Architecture\nThe system uses a queue-based pipeline.\n\n' +
    '## Database schema\nThe member table tblMemberDetails has columns member_id and status. Query it with SQL SELECT.\n');
  writeFileSync(join(docs, 'notes.txt'),
    'The house style is to verify a fact with a query before stating it as true.\n\n' +
    'Deployments go out on Fridays after the smoke tests pass on staging.\n');
  writeFileSync(join(docs, 'roster.csv'),
    'name,role,team\nAda,lead,platform\nGrace,reviewer,platform\nLinus,ic,kernel\nMargaret,pm,apps\n');
});

afterAll(() => { try { rmSync(box, { recursive: true, force: true }); } catch { /* */ } });

const ctx = (dir: string) => ({ sandboxDir: dir }) as ToolContext;

describe('MWA onboard — scan', () => {
  it('extracts candidates from markdown headings, text paragraphs, and csv', async () => {
    const { candidates, filesScanned } = await scanSources(box, ['.']);
    expect(filesScanned).toBeGreaterThanOrEqual(3);
    const concepts = candidates.map((c) => c.concept);
    // markdown heading section
    expect(concepts).toContain('Database schema');
    // and the fact survives into content
    expect(candidates.some((c) => c.content.includes('tblMemberDetails'))).toBe(true);
    // paragraph-chunked text + csv contributed something
    expect(candidates.some((c) => c.content.includes('house style') || c.content.includes('Fridays'))).toBe(true);
    expect(candidates.some((c) => c.source === 'roster.csv')).toBe(true);
  });

  it('refuses paths outside the granted sandbox (no arbitrary disk read)', async () => {
    // A path that escapes the sandbox resolves to nothing allowed → no candidates.
    const { candidates, filesScanned } = await scanSources(box, ['../../../../etc']);
    expect(filesScanned).toBe(0);
    expect(candidates.length).toBe(0);
  });
});

describe('MWA onboard — tools', () => {
  it('registers onboard_scan + onboard_questions', () => {
    const names = onboardTools().map((t) => t.def.name);
    expect(names).toContain('onboard_scan');
    expect(names).toContain('onboard_questions');
  });

  it('onboard_scan returns candidate memories (not saved) for a granted folder', async () => {
    const scan = onboardTools().find((t) => t.def.name === 'onboard_scan')!;
    const out = await scan.handler({ paths: ['.'] }, ctx(box));
    expect(out).toContain('CANDIDATE memories');
    expect(out).toContain('not saved');
    expect(out).toContain('tblMemberDetails'); // real content, from the scan
  });

  it('onboard_questions returns the interview, anchored on the goal', async () => {
    const q = onboardTools().find((t) => t.def.name === 'onboard_questions')!;
    const out = await q.handler({}, ctx(box));
    expect(out.toLowerCase()).toContain('goal of this memory system');
  });

  it('onboard_scan on an ungranted path returns a helpful refusal, not contents', async () => {
    const scan = onboardTools().find((t) => t.def.name === 'onboard_scan')!;
    const out = await scan.handler({ paths: ['../../../../etc'] }, ctx(box));
    expect(out).not.toContain('CANDIDATE memories');
  });
});
