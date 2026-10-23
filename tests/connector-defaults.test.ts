/** Turning a library connector on keeps the default web search (src/connectors/registry.ts). */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enabledConnectorIds, enableConnector, disableConnector } from '../src/connectors/registry.js';
import { loadConfig } from '../src/config.js';

describe('the default web search', () => {
  let dir = '';
  afterEach(() => { vi.unstubAllEnvs(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  const at = (raw?: object) => { dir = mkdtempSync(join(tmpdir(), 'mwa-conn-')); const p = join(dir, 'mwa.config.json'); if (raw) writeFileSync(p, JSON.stringify(raw)); vi.stubEnv('MWA_CONFIG_PATH', p); return p; };

  it('reads as on with no config file, and stays on when another connector is turned on', () => {
    const p = at();
    expect(enabledConnectorIds()).toEqual(['search']);
    expect(enableConnector('fetch').ok).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(p, 'utf8')).tools.mcpServers).sort()).toEqual(['fetch', 'search']);
    expect(Object.keys(loadConfig().tools.mcpServers ?? {}).sort()).toEqual(['fetch', 'search']);
  });
  it('can be turned off, and stays off', () => {
    at({ style: 'direct' });
    disableConnector('search');
    expect(enabledConnectorIds()).toEqual([]);
    expect(Object.keys(loadConfig().tools.mcpServers ?? {})).toEqual([]);
  });
  it('a config that names its own servers is left as it is', () => {
    at({ tools: { mcpServers: { thinking: { command: 'npx', args: ['x'] } } } });
    expect(enabledConnectorIds()).toEqual(['thinking']);
  });
});
