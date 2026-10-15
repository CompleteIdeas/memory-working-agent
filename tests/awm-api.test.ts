/**
 * BL-11 (H-7) — AWM's internals are reached through ONE file, src/awm-api.ts. An AWM upgrade that moves
 * an internal then breaks that file and nothing else. This guard fails if any other source file reaches
 * into `agent-working-memory/dist/**` (type declarations for those modules, *.d.ts, are allowed), and
 * checks that everything the façade exposes really resolves against the pinned AWM.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as api from '../src/awm-api.js';

const srcFiles = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? srcFiles(p) : /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(f) && !f.endsWith('.d.ts') ? [p] : [];
});
const FACADE = join('src', 'awm-api.ts');

describe('AWM internals go through src/awm-api.ts only', () => {
  it('no other source file imports agent-working-memory/dist', () => {
    // Any string that STARTS with the package path (a static, dynamic, template, computed or package.json
    // specifier), or the package name joined to more ('…' + …, join('…', 'dist')). Prose doesn't start a
    // string with the package name, and a vendor folder path like resolve('vendor', 'agent-working-memory') isn't a specifier.
    const reaches = (text: string) => /['"`]agent-working-memory\//.test(text) || /['"`]agent-working-memory['"`]\s*(\+|,\s*['"`]dist)/.test(text);
    const offenders = srcFiles('src').filter((p) => p !== FACADE && reaches(readFileSync(p, 'utf8')))
      .map((p) => relative('.', p));
    expect(offenders).toEqual([]);
  });

  it('everything the façade exposes resolves against the pinned AWM', async () => {
    const eng = await api.loadEngines();
    for (const name of ['ActivationEngine', 'ConnectionEngine', 'ConsolidationEngine', 'performWrite', 'initCoordinationTables'] as const) {
      expect([name, typeof eng[name]]).toEqual([name, 'function']);
    }
    expect(typeof (await api.loadPGliteStore())).toBe('function');
    expect(typeof (await api.loadPostgresStore())).toBe('function');
    expect(Array.isArray(api.INTERVIEW_QUESTIONS) && api.INTERVIEW_QUESTIONS.length > 0).toBe(true);
    expect(typeof (await api.loadSqliteStore())).toBe('function');
    expect(typeof (await api.loadEmbeddings()).embed).toBe('function');
    expect(api.awmCliPath()).toMatch(/cli\.js$/);
    expect((await api.loadEmbeddings()).cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
  }, 60_000);

  it('importing the façade is light: no engine, no model runtime', () => {
    // Its only static import is the onboarding questions; everything else is behind a loader.
    const text = readFileSync(FACADE, 'utf8');
    // Runtime imports only (type-only ones load nothing): `import … from`, `export … from`, and side-effect `import '…'`.
    const staticImports = [
      ...[...text.matchAll(/^(?:import(?!\s+type\b)|export(?!\s+(?:type|interface)\b))[^;\n]*\bfrom\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]),
      ...[...text.matchAll(/^import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    ];
    expect(staticImports.sort()).toEqual(['agent-working-memory/dist/onboard/index.js', 'node:module']);
  });
});
