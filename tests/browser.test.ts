/**
 * BL-64 — the agent browser. The rules that must hold whatever a page says: no private addresses, a saved login only
 * on its own site, and nothing that sends, pays or deletes without the person saying so.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONSEQUENTIAL, GO_AHEAD, browserTools, closeBrowsers } from '../src/tools/browser.js';

describe('what counts as a consequential click, and as going ahead', () => {
  it('controls that send, pay, buy, delete or submit', () => {
    for (const l of ['Submit entry', 'Pay $135', 'Place order', 'Delete member', 'Send', 'Confirm transfer', 'Check out']) expect([l, CONSEQUENTIAL.test(l)]).toEqual([l, true]);
    for (const l of ['Next', 'Show results', 'Search', 'Sign in', 'Members', 'View invoice']) expect([l, CONSEQUENTIAL.test(l)]).toEqual([l, false]);
  });
  it('the person\'s go-ahead, in their own words', () => {
    for (const m of ['Yes, submit it', 'go ahead', 'Confirmed — pay it']) expect([m, GO_AHEAD.test(m)]).toEqual([m, true]);
    for (const m of ['Fill out the entry form for Tessa', 'What does the page say?']) expect([m, GO_AHEAD.test(m)]).toEqual([m, false]);
  });
});

const hasPlaywright = (() => { try { createRequire(import.meta.url).resolve('playwright-core'); return true; } catch { return false; } })();

describe.skipIf(!hasPlaywright)('in a real browser', () => {
  let server: Server; let base = ''; let cfgDir = ''; let posted: string[] = [];
  const tool = (n: string) => browserTools().find((t) => t.def.name === n)!;
  const ctx = (extra: Record<string, unknown> = {}) => ({ sandboxDir: cfgDir, interactive: true, personId: 'jordan', ...extra });
  const setPreset = (preset: string) => writeFileSync(join(cfgDir, 'mwa.config.json'), JSON.stringify({ tools: { access: { preset, grantedRoots: [] } } }));

  beforeAll(async () => {
    cfgDir = mkdtempSync(join(tmpdir(), 'mwa-browser-'));
    vi.stubEnv('MWA_CONFIG_PATH', join(cfgDir, 'mwa.config.json'));
    vi.stubEnv('MWA_BROWSER_DIR', join(cfgDir, 'profiles'));
    vi.stubEnv('MWA_VAULT_PATH', join(cfgDir, 'vault.json'));
    server = createServer((req, res) => {
      let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
        if (req.method === 'POST') posted.push(body);
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<html><head><title>Entries</title></head><body><h1>Fox Run entries close Nov 13</h1>
          <form method="post" action="/done"><input name="user" placeholder="Username"><input name="pw" type="password" placeholder="Password">
          <button type="submit">Submit entry</button></form><a href="/next">Next page</a></body></html>`);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => { await closeBrowsers(); server.close(); vi.unstubAllEnvs(); rmSync(cfgDir, { recursive: true, force: true }); });

  it('refuses this machine and private networks (MWA\'s own controls live there)', async () => {
    setPreset('assistant');
    await expect(tool('browser_open').handler({ url: `${base}/` }, ctx())).rejects.toThrow(/private network|this machine/);
  }, 60_000);

  it('reads a page with numbered controls; types; holds a submit until the person says go ahead', async () => {
    setPreset('developer'); // the local test server; the guard is tested above
    const page = await tool('browser_open').handler({ url: `${base}/` }, ctx());
    expect(page).toMatch(/Fox Run entries close Nov 13/);
    expect(page).toMatch(/\[1\] textbox "Username"/);
    expect(page).toMatch(/\[3\] button "Submit entry"/);
    expect(await tool('browser_type').handler({ ref: 1, text: 'jordan' }, ctx())).toMatch(/Typed into \[1\]/);
    await expect(tool('browser_click').handler({ ref: 3 }, ctx({ personMessage: 'Fill in the Fox Run entry form' }))).rejects.toThrow(/held: .*Submit entry/);
    await expect(tool('browser_click').handler({ ref: 3 }, ctx({ interactive: false }))).rejects.toThrow(/nobody is watching/);
    expect(posted).toEqual([]);
    await tool('browser_click').handler({ ref: 3 }, ctx({ personMessage: 'Yes, submit it' }));
    expect(posted).toEqual(['user=jordan&pw=']);
  }, 60_000);

  it('a saved login is typed only on its own site, and never echoed', async () => {
    setPreset('developer');
    const { vaultSave } = await import('../src/vault/vault.js');
    vaultSave('fox-run', 'foxrunfarm.example', { password: 'Gr8-horse-sport!' });
    await tool('browser_open').handler({ url: `${base}/` }, ctx());
    await expect(tool('browser_type').handler({ ref: 2, text: '{{vault:fox-run.password}}' }, ctx())).rejects.toThrow(/saved for foxrunfarm\.example/);
    vaultSave('local-test', '127.0.0.1', { password: 'Gr8-horse-sport!' });
    const r = await tool('browser_type').handler({ ref: 2, text: '{{vault:local-test.password}}' }, ctx());
    expect(r).toBe('Typed the saved value into [2] on 127.0.0.1.');
  }, 60_000);
});
