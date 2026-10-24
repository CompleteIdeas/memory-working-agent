/**
 * F16 (usability review 2026-10-24): every runtime file defaulted to `./data/…` against the current directory, each
 * behind its own env var, and `MWA_ROOT`/`MWA_HOME` from the docs were read by nothing — a server started from the
 * repo folder wrote its logs into the repo's `data/`. One setting now places them all; the per-file vars still win.
 */
import { describe, it, expect } from 'vitest';
import { resolve, join } from 'node:path';
import { dataDir, dbFile, runLogPath, notifyPath, mwaLogPath, installLogPath, vaultPath, browserDir } from '../src/paths.js';

describe('runtime data paths', () => {
  it('default to ./data against the current directory, as before', () => {
    expect(dataDir({})).toBe(resolve('./data'));
    expect(dbFile({})).toBe(resolve('./data/agent.db'));
    expect(runLogPath({})).toBe(resolve('./data/runs.jsonl'));
    expect(notifyPath({})).toBe(resolve('./data/notifications.jsonl'));
    expect(mwaLogPath({})).toBe(resolve('./data/mwa.log'));
    expect(installLogPath({})).toBe(resolve('./data/installs.jsonl'));
    expect(vaultPath({})).toBe(resolve('./data/vault.json'));
    expect(browserDir({})).toBe(resolve('./data/browser'));
  });
  it('MWA_DATA_DIR places every file; MWA_ROOT or MWA_HOME places them under <home>/data', () => {
    const env = { MWA_DATA_DIR: '/srv/mwa-data' };
    const d = resolve('/srv/mwa-data');
    expect(dataDir(env)).toBe(d);
    for (const f of [dbFile, runLogPath, notifyPath, mwaLogPath, installLogPath, vaultPath, browserDir]) expect(f(env).startsWith(d + '/') || f(env).startsWith(d + '\\')).toBe(true);
    expect(dataDir({ MWA_ROOT: '/home/me/.mwa' })).toBe(resolve('/home/me/.mwa', 'data'));
    expect(dataDir({ MWA_HOME: '/home/me/.mwa' })).toBe(resolve('/home/me/.mwa', 'data'));
    expect(dataDir({ MWA_DATA_DIR: '/x', MWA_ROOT: '/y' })).toBe(resolve('/x'));
  });
  it('a per-file var still wins (Docker and the desktop app set them)', () => {
    expect(dbFile({ MWA_DATA_DIR: '/x', MWA_DB: '/data/agent.db' })).toBe('/data/agent.db');
    expect(runLogPath({ MWA_DATA_DIR: '/x', MWA_RUNLOG: '/data/runs.jsonl' })).toBe('/data/runs.jsonl');
    expect(mwaLogPath({ MWA_DATA_DIR: '/x', MWA_LOG: '/data/mwa.log' })).toBe('/data/mwa.log');
    expect(notifyPath({ MWA_DATA_DIR: '/x', MWA_NOTIFY: '/n.jsonl' })).toBe('/n.jsonl');
    expect(dbFile({ MWA_DATA_DIR: '/x' })).toBe(join(resolve('/x'), 'agent.db'));
  });
});
