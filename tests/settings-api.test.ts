/**
 * Interface slice of the usability review (2026-10-25): the app's Settings lists saved logins (names only) with
 * Forget and sets quiet hours; approval cards carry when they were staged and scheduled jobs the conversation they
 * report to, so the app can show each inside the task that raised it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vaultSave, _resetVaultCache } from '../src/vault/vault.js';
import { vaultRows, forgetVaultEntry, quietState, setQuiet } from '../src/settings-api.js';
import { MwaMemory } from '../src/awm.js';
import { scheduleRows } from '../src/schedule-api.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mwa-settings-'));
  vi.stubEnv('MWA_VAULT_PATH', join(dir, 'vault.json'));
  vi.stubEnv('MWA_VAULT_KEY', '');
  vi.stubEnv('MWA_CONFIG_PATH', join(dir, 'mwa.config.json'));
  vi.stubEnv('MWA_QUIET_HOURS', '');
  writeFileSync(join(dir, 'mwa.config.json'), JSON.stringify({ tools: { access: { preset: 'assistant' } } }));
  _resetVaultCache();
});
afterEach(() => { vi.unstubAllEnvs(); _resetVaultCache(); rmSync(dir, { recursive: true, force: true }); });

describe('saved logins in Settings', () => {
  it('lists names, sites and field names, never a value, and forgets one', () => {
    vaultSave('Club portal', 'https://portal.example.org/login', { username: 'robin', password: 'S3cret-value!' });
    const rows = vaultRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'club-portal', site: 'portal.example.org', fields: ['username', 'password'] });
    expect(JSON.stringify(rows)).not.toContain('S3cret-value!');
    expect(JSON.stringify(rows)).not.toContain('robin');
    expect(forgetVaultEntry('club-portal').ok).toBe(true);
    expect(vaultRows()).toHaveLength(0);
    expect(forgetVaultEntry('club-portal').ok).toBe(false);
  });
});

describe('quiet hours in Settings', () => {
  it('sets a window, keeps the rest of the config, and turns it off', () => {
    expect(quietState().window).toBeNull();
    const r = setQuiet('21:00-07:00');
    expect(r.ok).toBe(true);
    expect(r.state.window).toBe('21:00-07:00');
    const cfg = JSON.parse(readFileSync(join(dir, 'mwa.config.json'), 'utf8'));
    expect(cfg.tools.access.preset).toBe('assistant');
    expect(setQuiet('nonsense').ok).toBe(false);
    expect(setQuiet('off').state.window).toBeNull();
  });
  it('refuses when the deployment fixes the window', () => {
    vi.stubEnv('MWA_QUIET_HOURS', '22:00-06:00');
    expect(setQuiet('21:00-07:00').ok).toBe(false);
    expect(quietState().fixed).toBe(true);
  });
});

describe('a scheduled job names the conversation it reports to', () => {
  it('carries session for a web chat and not for Telegram', async () => {
    const mem = new MwaMemory('settings', join(dir, 'm.db'));
    try {
      await mem.addScheduledTask('Remind me to call Harbour Works', Date.now() + 3_600_000, { person: 'p1', notify: 'web-abc123', kind: 'reminder' });
      await mem.addScheduledTask('Check the budget file', Date.now() + 3_600_000, { person: 'p1', notify: 'tg-42', recur: 'every:5' });
      const rows = await scheduleRows(mem, 'p1');
      expect(rows.find((r) => r.request.includes('Harbour'))?.session).toBe('web-abc123');
      expect(rows.find((r) => r.request.includes('budget'))?.session).toBeUndefined();
    } finally { mem.close(); }
  });
});
