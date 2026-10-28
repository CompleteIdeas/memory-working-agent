/**
 * BL-63 — the vault: a person saves a login or key through a card; it is stored encrypted; the agent uses it by
 * reference, only on the entry's own site, and never sees it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vaultSave, vaultList, vaultForget, resolveVaultRefs, redactVault, _resetVaultCache } from '../src/vault/vault.js';
import { openVaultRequest, listSetupRequests, submitSetupRequest, _resetSetupRequests } from '../src/connect/setup.js';
import { connectTools } from '../src/tools/connect.js';
import { classifyTool, outputSource } from '../src/tools/governance.js';

const PW = 'Gr8-horse-sport!';
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mwa-vault-'));
  vi.stubEnv('MWA_VAULT_PATH', join(dir, 'vault.json'));
  vi.stubEnv('MWA_VAULT_KEY', '');
  _resetVaultCache(); _resetSetupRequests();
});
afterEach(() => { vi.unstubAllEnvs(); _resetVaultCache(); rmSync(dir, { recursive: true, force: true }); });
const tool = (name: string) => connectTools().find((t) => t.def.name === name)!;

describe('the vault', () => {
  it('stores values encrypted; a listing shows names, sites and fields only', () => {
    vaultSave('USEA Portal', 'https://portal.useventing.example/login', { username: 'jordan', password: PW });
    const raw = readFileSync(join(dir, 'vault.json'), 'utf8');
    expect(raw).not.toContain(PW);
    expect(raw).not.toContain('jordan');
    expect(vaultList()).toEqual([{ name: 'usea-portal', site: 'portal.useventing.example', fields: ['username', 'password'], savedAt: expect.any(Number) }]);
  });

  it('a reference is filled in only for its own site (or a subdomain of it); elsewhere nothing is sent', () => {
    vaultSave('usea-portal', 'useventing.example', { password: PW });
    expect(resolveVaultRefs('Bearer {{vault:usea-portal.password}}', 'https://api.useventing.example/v1')).toBe(`Bearer ${PW}`);
    expect(() => resolveVaultRefs('{{vault:usea-portal.password}}', 'https://useventing.example.evil.example/')).toThrow(/only ever sent to its own site/);
    expect(() => resolveVaultRefs('{{vault:usea-portal.password}}', 'https://attacker.example/collect')).toThrow(/saved for useventing\.example/);
    expect(() => resolveVaultRefs('{{vault:nope.password}}', 'https://useventing.example')).toThrow(/no vault entry/);
    expect(() => resolveVaultRefs('{{vault:usea-portal.pin}}', 'https://useventing.example')).toThrow(/no field "pin"/);
  });

  it('a saved value in any tool output is masked', () => {
    vaultSave('api', 'api.example', { key: 'sk-live-1234567890' });
    expect(redactVault('echo: Authorization: Bearer sk-live-1234567890 ok')).toBe('echo: Authorization: Bearer ‹vault:api.key› ok');
    vaultForget('api');
    expect(redactVault('sk-live-1234567890')).toBe('sk-live-1234567890'); // forgotten: nothing left to mask
  });

  it('a different key cannot open it', () => {
    vi.stubEnv('MWA_VAULT_KEY', 'a'.repeat(64));
    vaultSave('api', 'api.example', { key: 'sk-live-1234567890' });
    vi.stubEnv('MWA_VAULT_KEY', 'b'.repeat(64)); _resetVaultCache();
    expect(() => resolveVaultRefs('{{vault:api.key}}', 'https://api.example')).toThrow();
  });
});

describe('saving through a card', () => {
  it('the agent opens a card; the person fills it; the model only hears the reference', async () => {
    const said = await tool('vault_request').handler({ name: 'USEA portal', site: 'portal.useventing.example', fields: ['Username', 'Password'] }, { sandboxDir: '.', interactive: true });
    expect(said).toMatch(/\{\{vault:usea-portal\.username\}\}, \{\{vault:usea-portal\.password\}\}/);
    const card = openVaultRequest('usea-portal', 'portal.useventing.example', []); // the same waiting card
    expect(card.fields.map((f) => [f.env, f.secret])).toEqual([['username', false], ['password', true]]);
    const r = await submitSetupRequest(card.id, { username: 'jordan', password: PW });
    expect(r).toEqual({ ok: true, message: 'Saved to the vault as "usea-portal" for portal.useventing.example.' });
    expect(JSON.stringify(r)).not.toContain(PW);
    expect(await tool('vault_list').handler({}, { sandboxDir: '.' })).toBe('• usea-portal (for portal.useventing.example): {{vault:usea-portal.username}}, {{vault:usea-portal.password}}');
  });

  it('not from a scheduled run or a conversation steered by an email or page', async () => {
    expect(await tool('vault_request').handler({ name: 'x', site: 'x.example' }, { sandboxDir: '.', interactive: false })).toMatch(/^\(refused/);
    expect(await tool('vault_request').handler({ name: 'x', site: 'x.example' }, { sandboxDir: '.', interactive: true, tainted: true })).toMatch(/^\(refused/);
    expect(await tool('vault_forget').handler({ name: 'x' }, { sandboxDir: '.', interactive: true, tainted: true })).toMatch(/^\(refused/);
  });

  it('S6 review: a login with no site is refused (it could be sent to any website), and no card opens', async () => {
    const before = listSetupRequests().length;
    for (const site of [undefined, '', '   ']) {
      expect(await tool('vault_request').handler({ name: 'no-site', site }, { sandboxDir: '.', interactive: true })).toMatch(/^\(refused: say which website/);
    }
    expect(listSetupRequests().length).toBe(before);
  });

  it('is classified as local, and its output is MWA\'s own', () => {
    expect(['vault_list', 'vault_request', 'vault_forget'].map(classifyTool)).toEqual(['read', 'write-local', 'write-local']);
    expect(['vault_list', 'vault_request', 'vault_forget'].map(outputSource)).toEqual(['own', 'own', 'own']);
  });
});
