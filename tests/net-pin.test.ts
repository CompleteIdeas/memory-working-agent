/**
 * BL-16c — the network guard is pinned to the connection, and the bundled fetch MCP server uses it.
 * - Addresses: private IPv4 hidden in IPv6 (mapped, NAT64, 6to4, Teredo) is refused; public is not.
 * - Names that mean this machine are refused before any lookup.
 * - DNS rebinding: whatever an earlier check saw, the connection's own resolution decides.
 * - Redirects are checked hop by hop, and a POST that is redirected becomes a GET.
 * - The bundled fetch MCP server refuses this machine itself, and MWA pre-checks every URL in any MCP
 *   call's arguments.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

const answers: Record<string, string[]> = {};
vi.mock('node:dns', async (orig) => {
  const real = await orig<typeof import('node:dns')>();
  const lookup = (host: string, opts: any, cb: any) => {
    const list = answers[host];
    if (!list) return real.lookup(host, opts, cb);
    const addr = list.length > 1 ? list.shift()! : list[0];
    const all = [{ address: addr, family: 4 }];
    return opts?.all ? cb(null, all) : cb(null, addr, 4);
  };
  return { ...real, default: { ...real, lookup }, lookup };
});

const { isBlockedAddress, hostRefusal, pinnedFetch } = await import('../mcp-servers/net-core.mjs');
const { urlsIn } = await import('../src/tools/net-guard.js');

describe('addresses', () => {
  it('refuses private IPv4 however IPv6 wraps it, and leaves public addresses alone', () => {
    const blocked = ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.0.8', '198.18.0.1', '::1', '::',
      '::ffff:7f00:1', '::ffff:10.0.0.1', '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', '2002:a00:1::5',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', 'fd00::1', 'fe80::1', 'ff02::1', 'fe80::1%eth0', 'not-an-ip'];
    const open = ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '64:ff9b::808:808', '2002:808:808::1', '::ffff:8.8.8.8'];
    expect(blocked.filter((a) => !isBlockedAddress(a))).toEqual([]);
    expect(open.filter((a) => isBlockedAddress(a))).toEqual([]);
  });
  it('names that mean this machine are refused before any lookup; odd spellings of 127.0.0.1 too', () => {
    for (const u of ['http://localhost./', 'http://LOCALHOST:7788/', 'http://app.localhost/', 'http://host.docker.internal/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::ffff:127.0.0.1]/'])
      expect([u, hostRefusal(new URL(u))]).toEqual([u, expect.stringMatching(/this machine|private network/)]);
    expect(hostRefusal(new URL('https://example.com/'))).toBeNull();
    expect(hostRefusal(new URL('ftp://example.com/'))).toMatch(/only http/);
  });
});

describe('pinned to the connection', () => {
  // A local server stands in for a public site: the tests' rule blocks only 127.0.0.2.
  const blocked = (ip: string) => ip === '127.0.0.2' || isBlockedAddress(ip) && ip !== '127.0.0.1';
  let site: Server; let inside: Server; let sitePort = 0; let insidePort = 0;
  const hits: string[] = [];
  beforeAll(async () => {
    site = createServer((req, res) => {
      hits.push(`site ${req.method} ${req.url}`);
      if (req.url === '/to-inside') { res.writeHead(302, { location: `http://127.0.0.2:${insidePort}/secret` }); return res.end(); }
      if (req.url === '/post-redirect') { res.writeHead(302, { location: '/landed' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'] }); res.end(`hello ${req.method}`);
    });
    inside = createServer((req, res) => { hits.push(`INSIDE ${req.method} ${req.url}`); res.end('secret'); });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => inside.listen(0, '127.0.0.2', r));
    sitePort = (site.address() as { port: number }).port; insidePort = (inside.address() as { port: number }).port;
  });
  afterAll(() => { site.close(); inside.close(); });
  beforeEach(() => { hits.length = 0; for (const k of Object.keys(answers)) delete answers[k]; });

  it('fetches an allowed site and returns a normal Response', async () => {
    answers['site.test'] = ['127.0.0.1'];
    const res = await pinnedFetch(`http://site.test:${sitePort}/page`, {}, 5, blocked);
    expect(typeof res).not.toBe('string');
    const r = res as Response;
    expect([r.status, await r.text(), r.headers.get('content-type')]).toEqual([200, 'hello GET', 'text/plain']);
  });

  it('DNS rebinding: a check that saw a public address does not let the connection reach a private one', async () => {
    // First answer: "public" (what a separate pre-check would see). Every later answer: private.
    answers['rebind.test'] = ['127.0.0.1', '127.0.0.2'];
    const { lookup } = await import('node:dns');
    const seenByCheck = await new Promise<string>((r) => lookup('rebind.test', {}, (_e: unknown, a: string) => r(a)));
    expect(blocked(seenByCheck)).toBe(false);
    const res = await pinnedFetch(`http://rebind.test:${insidePort}/secret`, {}, 5, blocked);
    expect(res).toMatch(/^\(refused: rebind\.test is on this machine or a private network/);
    expect(hits).toEqual([]); // nothing reached the private server
  });

  it('a redirect to a private address is refused at that hop; a redirected POST becomes a GET', async () => {
    answers['site.test'] = ['127.0.0.1'];
    expect(await pinnedFetch(`http://site.test:${sitePort}/to-inside`, {}, 5, blocked)).toMatch(/^\(refused: 127\.0\.0\.2 is on this machine/);
    expect(hits).toEqual(['site GET /to-inside']);
    hits.length = 0;
    const r = await pinnedFetch(`http://site.test:${sitePort}/post-redirect`, { method: 'POST', body: '{"x":1}' }, 5, blocked) as Response;
    expect([r.status, await r.text()]).toEqual([200, 'hello GET']);
    expect(hits).toEqual(['site POST /post-redirect', 'site GET /landed']);
  });
});

describe('MCP servers', () => {
  it('every URL in an MCP call’s arguments is found, at any depth and inside text', () => {
    expect(urlsIn({ url: 'http://127.0.0.1:7788/api', opts: { list: ['see https://a.example/x?y=1 now', 3] }, n: 'no url' }))
      .toEqual(['http://127.0.0.1:7788/api', 'https://a.example/x?y=1']);
  });

  it('the bundled fetch server refuses this machine and the private network itself', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    let reached = false;
    const local = createServer((_q, res) => { reached = true; res.end('approvals'); });
    await new Promise<void>((r) => local.listen(0, '127.0.0.1', r));
    const port = (local.address() as { port: number }).port;
    const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'mcp-servers', 'fetch.mjs')] }));
    try {
      for (const url of [`http://127.0.0.1:${port}/api/approvals`, `http://localhost:${port}/`, 'http://169.254.169.254/latest/meta-data/', `http://2130706433:${port}/`]) {
        const out = await client.callTool({ name: 'fetch_url', arguments: { url } }) as { content: { text: string }[]; isError?: boolean };
        expect([url, out.isError, out.content[0].text]).toEqual([url, true, expect.stringMatching(/^\(refused: /)]);
      }
      expect(reached).toBe(false);
    } finally { await client.close(); local.close(); }
  }, 30_000);
});
