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
import { CONSEQUENTIAL, GO_AHEAD, AGENT_BROWSER_HEADER, browserTools, closeBrowsers } from '../src/tools/browser.js';

// The guard refuses nothing in Developer mode (the local test server needs that), so a path stands in for a private
// address: any URL whose path starts with /private is refused, as 127.0.0.1 would be in Assistant mode.
vi.mock('../src/tools/net-guard.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/tools/net-guard.js')>();
  return { ...m, urlRefusal: async (u: string) => (/\/private(\/|$)/.test(String(u)) ? 'that address is on this machine or a private network (test)' : m.urlRefusal(u)) };
});

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
  const hits: Record<string, number> = {}; let lastHeaders: Record<string, unknown> = {};
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
        const path = String(req.url ?? '/').split('?')[0];
        hits[path] = (hits[path] ?? 0) + 1; lastHeaders = req.headers;
        if (req.method === 'POST') posted.push(body);
        if (path === '/go') { res.writeHead(302, { location: `${base}/private/health` }); res.end(); return; } // a public page's redirect
        if (path.startsWith('/private')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"secret":"MWA control API"}'); return; }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<html><head><title>Entries</title></head><body><h1>Fox Run entries close Nov 13</h1>
          <form method="post" action="/done"><input name="user" placeholder="Username"><input name="pw" type="password" placeholder="Password">
          <button type="submit">Submit entry</button></form><a href="/next">Next page</a>
          <select name="level"><option>Novice</option><option>Training</option><option>Preliminary</option></select>
          <div style="height:3000px"></div><p>Bottom of the page: stabling closes Nov 10.</p></body></html>`);
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

  // Review 2026-10-25, F01: a public page's redirect reached MWA's own API on 127.0.0.1, because Chromium follows a
  // redirect without asking the route again. The hop is now paused and checked inside Chromium.
  it('a redirect to a refused address is stopped on the hop, and the private page is never fetched', async () => {
    setPreset('developer');
    hits['/private/health'] = 0;
    const r = await tool('browser_open').handler({ url: `${base}/go` }, ctx({ session: 'redirect-test' }));
    expect(r).toMatch(/refused: .*address this assistant may not reach|refused: the page led to/);
    expect(r).not.toMatch(/MWA control API/);
    expect(hits['/private/health']).toBe(0);
  }, 60_000);

  it('every request the agent browser makes says so, which MWA\'s own server refuses', async () => {
    setPreset('developer');
    await tool('browser_open').handler({ url: `${base}/` }, ctx({ session: 'header-test' }));
    expect(lastHeaders[AGENT_BROWSER_HEADER]).toBe('1');
  }, 60_000);

  // F02 / F04: one page per conversation, kept between turns; another conversation never sees it.
  it('a conversation keeps its page and what was typed; another conversation has no page', async () => {
    setPreset('developer');
    await tool('browser_open').handler({ url: `${base}/` }, ctx({ session: 'conv-a' }));
    await tool('browser_type').handler({ ref: 1, text: 'jordan' }, ctx({ session: 'conv-a' }));
    const again = await tool('browser_page').handler({}, ctx({ session: 'conv-a', runId: 'a-later-turn' }));
    expect(again).toMatch(/\[1\] textbox "jordan"/); // not reloaded: the typed name is still there
    await expect(tool('browser_page').handler({}, ctx({ session: 'conv-b' }))).rejects.toThrow(/no page is open in this conversation/);
  }, 60_000);

  // F05 / F14: dropdowns and long pages.
  it('chooses a dropdown option, and scrolls to read further down', async () => {
    setPreset('developer');
    const page = await tool('browser_open').handler({ url: `${base}/` }, ctx({ session: 'conv-c' }));
    expect(page).toMatch(/\[5\] dropdown "Novice" options: "Novice", "Training", "Preliminary"/);
    expect(page).toMatch(/more below — browser_scroll/);
    expect(await tool('browser_select').handler({ ref: 5, option: 'Training' }, ctx({ session: 'conv-c' }))).toBe('Chose "Training" in [5].');
    const down = await tool('browser_scroll').handler({ direction: 'down' }, ctx({ session: 'conv-c' }));
    expect(down).toMatch(/scrolled \d+px down the page/);
    expect(down).toMatch(/Bottom of the page/);
  }, 60_000);
});
