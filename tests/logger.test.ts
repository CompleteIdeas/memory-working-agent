import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log, readLogs } from '../src/logger.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mwa-log-'));
  process.env.MWA_LOG = join(dir, 'mwa.log');
});
afterEach(() => {
  delete process.env.MWA_LOG;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

describe('structured logger', () => {
  it('writes entries that readLogs returns newest-first', () => {
    log('info', 'mcp', 'connected');
    log('error', 'chat', 'boom', { session: 'web' });
    const logs = readLogs();
    expect(logs.length).toBe(2);
    expect(logs[0]).toMatchObject({ level: 'error', category: 'chat', msg: 'boom' });
    expect(logs[0].data).toEqual({ session: 'web' });
    expect(logs[1]).toMatchObject({ level: 'info', category: 'mcp' });
  });

  it('filters by level', () => {
    log('info', 'a', 'x');
    log('error', 'b', 'y');
    const errs = readLogs({ level: 'error' });
    expect(errs.length).toBe(1);
    expect(errs[0].category).toBe('b');
  });

  it('returns [] when there is no log file yet', () => {
    expect(readLogs()).toEqual([]);
  });
});
