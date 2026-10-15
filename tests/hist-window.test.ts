/**
 * BL-09 — MWA_HIST_WINDOW overrides the history window (default 12), clamped to 4..200, for measuring
 * the no-compaction bet. It is read when the agent module loads, so each case runs in its own process.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

const windowWith = (value: string | undefined): number => {
  const env = { ...process.env };
  if (value === undefined) delete env.MWA_HIST_WINDOW; else env.MWA_HIST_WINDOW = value;
  const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', "import('./src/agent.ts').then((m) => { console.log('W=' + m.HIST_WINDOW); process.exit(0); })"], { env, encoding: 'utf8', timeout: 60_000 });
  return Number(/W=(\d+)/.exec(out)?.[1]);
};

describe('the history window', () => {
  it('defaults to 12, takes MWA_HIST_WINDOW, and is clamped to 4..200; junk falls back to 12', () => {
    expect(windowWith(undefined)).toBe(12);
    expect(windowWith('30')).toBe(30);
    expect(windowWith('1')).toBe(4);
    expect(windowWith('5000')).toBe(200);
    expect(windowWith('lots')).toBe(12);
  }, 120_000);
});
