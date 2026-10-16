/**
 * BL-16c — the network guard is pinned to the connection, and the bundled fetch MCP server uses it.
 * - Addresses: private IPv4 hidden in IPv6 (mapped, SIIT, NAT64, 6to4, Teredo) is refused; public is not.
 * - Names that mean this machine are refused before any lookup.
 * - DNS rebinding: the host is resolved once, by the connection; a second answer is never used.
 * - Redirects are checked hop by hop; a redirected POST becomes a GET; credentials don't cross origins.
 * - A site can't crash the process with an odd status; requests carry a user-agent and a length.
 * - The bundled fetch MCP server refuses this machine itself, and MWA checks the links in any MCP call.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { join } from 'node:path';

const answers: Record<string, string[]> = {};
const lookups: string[] = [];
vi.mock('node:dns', async (orig) => {
  const real = await orig<typeof import('node:dns')>();
  const lookup = (host: string, opts: any, cb: any) => {
    const list = answers[host];
    if (!list) return real.lookup(host, opts, cb);
    lookups.push(host);
    const addr = list.length > 1 ? list.shift()! : list[0];
    return opts?.all ? cb(null, [{ address: addr, family: 4 }]) : cb(null, addr, 4);
  };
  return { ...real, default: { ...real, lookup }, lookup };
});

const { isBlockedAddress, hostRefusal, pinnedFetch } = await import('../mcp-servers/net-core.mjs');
const { urlsIn, mcpUrlRefusal } = await import('../src/tools/net-guard.js');

describe('addresses', () => {
  it('refuses private IPv4 however IPv6 wraps it, and leaves public addresses alone', () => {
    const blocked = ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.0.8', '198.18.0.1', '255.255.255.255', '::1', '::',
      '::ffff:7f00:1', '::ffff:10.0.0.1', '::127.0.0.1', '::ffff:0:127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', '2002:a00:1::5',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', 'fd00::1', 'fe80::1', 'fec0::1', '100::1', 'ff02::1', 'fe80::1%eth0', 'not-an-ip'];
    const open = ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '64:ff9b::808:808', '2002:808:808::1', '::ffff:8.8.8.8'];
    expect(blocked.filter((a) => !isBlockedAddress(a))).toEqual([]);
    expect(open.filter((a) => isBlockedAddress(a))).toEqual([]);
  });
  it('names that mean this machine are refused before any lookup; odd spellings of 127.0.0.1 too', () => {
    for (const u of ['http://localhost./', 'http://LOCALHOST:7788/', 'http://app.localhost/', 'http://host.docker.internal/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::ffff:127.0.0.1]/', 'http://127.0.0.1./'])
      expect([u, hostRefusal(new URL(u))]).toEqual([u, expect.stringMatching(/this machine or a private network/)]);
    expect(hostRefusal(new URL('https://example.com/'))).toBeNull();
    expect(hostRefusal(new URL('ftp://example.com/'))).toMatch(/only http/);
  });
});

// 127.0.0.2 is loopback on Linux and Windows; macOS binds only 127.0.0.1 unless configured.
describe.skipIf(process.platform === 'darwin')('pinned to the connection', () => {
  // A local server stands in for a public site: the tests' rule allows 127.0.0.1 and blocks 127.0.0.2.
  const blocked = (ip: string) => ip !== '127.0.0.1' && isBlockedAddress(ip);
  let site: Server; let inside: Server; let port = 0;
  const hits: string[] = []; let lastHeaders: IncomingHttpHeaders = {};
  const handler = (who: string) => (req: any, res: any) => {
    hits.push(`${who} ${req.method} ${req.url}`); lastHeaders = req.headers;
    if (who === 'INSIDE') return res.end('secret');
    if (req.url === '/to-inside') { res.writeHead(302, { location: `http://127.0.0.2:${port}/secret` }); return res.end(); }
    if (req.url === '/post-redirect') { res.writeHead(302, { location: '/landed' }); return res.end(); }
    if (req.url === '/elsewhere') { res.writeHead(307, { location: `http://other.test:${port}/landed` }); return res.end(); }
    if (req.url === '/odd') { res.writeHead(600); return res.end('x'); }
    if (req.url === '/not-modified') { res.writeHead(304, { location: '/landed' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'] }); res.end(`hello ${req.method}`);
  };
  beforeAll(async () => {
    // The same port on two addresses: whichever address a connection uses decides which server answers.
    site = createServer(handler('site'));
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    port = (site.address() as { port: number }).port;
    inside = createServer(handler('INSIDE'));
    await new Promise<void>((r) => inside.listen(port, '127.0.0.2', r));
  });
  afterAll(() => { site.close(); inside.close(); });
  beforeEach(() => { hits.length = 0; lookups.length = 0; for (const k of Object.keys(answers)) delete answers[k]; });

  it('fetches an allowed site, with a user-agent and no compression asked for', async () => {
    answers['site.test'] = ['127.0.0.1'];
    const r = await pinnedFetch(`http://site.test:${port}/page`, {}, 5, blocked) as Response;
    expect([r.status, await r.text(), r.headers.get('content-type')]).toEqual([200, 'hello GET', 'text/plain']);
    expect([lastHeaders['user-agent'], lastHeaders['accept-encoding']]).toEqual(['Mozilla/5.0 (MWA)', 'identity']);
  });

  it('DNS rebinding: the host is resolved once, by the connection, and a later answer is never used', async () => {
    // First answer allowed, every later one private. Check-then-connect would resolve twice and reach
    // the private server; the pinned fetch resolves once and reaches the site.
    answers['rebind.test'] = ['127.0.0.1', '127.0.0.2'];
    const r = await pinnedFetch(`http://rebind.test:${port}/page`, {}, 5, blocked) as Response;
    expect([r.status, await r.text()]).toEqual([200, 'hello GET']);
    expect(lookups).toEqual(['rebind.test']);
    expect(hits).toEqual(['site GET /page']);
    // And when the connection's own answer is private, it is refused before anything is sent.
    answers['rebind2.test'] = ['127.0.0.2'];
    expect(await pinnedFetch(`http://rebind2.test:${port}/secret`, {}, 5, blocked)).toMatch(/^\(refused: rebind2\.test is on this machine/);
    expect(hits.filter((h) => h.startsWith('INSIDE'))).toEqual([]);
  });

  it('a redirect to a private address is refused at that hop, after a GET or a POST; a redirected POST becomes a GET', async () => {
    answers['site.test'] = ['127.0.0.1'];
    expect(await pinnedFetch(`http://site.test:${port}/to-inside`, {}, 5, blocked)).toMatch(/^\(refused: 127\.0\.0\.2 is on this machine/);
    expect(await pinnedFetch(`http://site.test:${port}/to-inside`, { method: 'POST', body: '{}' }, 5, blocked)).toMatch(/^\(refused: /);
    expect(hits).toEqual(['site GET /to-inside', 'site POST /to-inside']);
    hits.length = 0;
    const r = await pinnedFetch(`http://site.test:${port}/post-redirect`, { method: 'POST', body: '{"x":1}' }, 5, blocked) as Response;
    expect([r.status, await r.text()]).toEqual([200, 'hello GET']);
    expect(hits).toEqual(['site POST /post-redirect', 'site GET /landed']);
  });

  it('a POST says how long it is; credentials don’t follow a redirect to another origin', async () => {
    answers['site.test'] = ['127.0.0.1']; answers['other.test'] = ['127.0.0.1'];
    await (await pinnedFetch(`http://site.test:${port}/page`, { method: 'POST', body: 'héllo', headers: [['x-a', '1']] }, 5, blocked) as Response).text();
    expect([lastHeaders['content-length'], lastHeaders['x-a']]).toEqual(['6', '1']);
    const r = await pinnedFetch(`http://site.test:${port}/elsewhere`, { headers: { authorization: 'Bearer s3cret', cookie: 'k=v', 'x-keep': 'yes' } }, 5, blocked) as Response;
    await r.text();
    expect(hits.at(-1)).toBe('site GET /landed');
    expect([lastHeaders.authorization, lastHeaders.cookie, lastHeaders['x-keep']]).toEqual([undefined, undefined, 'yes']);
  });

  it('a site answering with a status outside 200–599 is an error, not a crash', async () => {
    answers['site.test'] = ['127.0.0.1'];
    await expect(pinnedFetch(`http://site.test:${port}/odd`, {}, 5, blocked)).rejects.toThrow(/status 600/);
  });

  it('a site that answers 101 with upgrade headers is an error, not a request that never ends', async () => {
    const raw = createTcpServer((sock) => sock.once('data', () => sock.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', '', ''].join('\r\n'))));
    await new Promise<void>((r) => raw.listen(0, '127.0.0.1', r));
    try {
      answers['upgrade.test'] = ['127.0.0.1'];
      const p = pinnedFetch(`http://upgrade.test:${(raw.address() as { port: number }).port}/`, {}, 5, blocked);
      const outcome = await Promise.race([p.then(() => 'settled', (e: Error) => `rejected: ${e.message}`), new Promise((r) => setTimeout(() => r('HUNG'), 3000))]);
      expect(outcome).toMatch(/^rejected: .*switch protocols/);
    } finally { raw.close(); }
  });

  it('a 304 is not followed; a POST turned into a GET drops its content type', async () => {
    answers['site.test'] = ['127.0.0.1'];
    expect((await pinnedFetch(`http://site.test:${port}/not-modified`, {}, 5, blocked) as Response).status).toBe(304);
    expect(hits).toEqual(['site GET /not-modified']);
    await (await pinnedFetch(`http://site.test:${port}/post-redirect`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }, 5, blocked) as Response).text();
    expect([hits.at(-1), lastHeaders['content-type'], lastHeaders['content-length']]).toEqual(['site GET /landed', undefined, undefined]);
  });
});

describe('MCP calls', () => {
  it('finds every link, at any depth, inside text, with odd slashes, without trailing punctuation', () => {
    const bs = '\\';
    expect(urlsIn({ url: 'http://127.0.0.1:7788/api', opts: { list: [`see https://a.example/x?y=1, and http:${bs}${bs}10.0.0.1/z.`, 3] }, v6: '(http://[::1]:7788/q)' }))
      .toEqual({ urls: ['http://127.0.0.1:7788/api', 'https://a.example/x?y=1', `http:${bs}${bs}10.0.0.1/z`, 'http://[::1]:7788/q'], truncated: false });
    expect(urlsIn({ links: Array.from({ length: 51 }, (_, i) => `https://e${i}.example/`) }).truncated).toBe(true);
    // Repeats count once: sixty copies of one link are one link.
    expect(urlsIn({ links: Array.from({ length: 60 }, () => 'https://same.example/') })).toEqual({ urls: ['https://same.example/'], truncated: false });
    let deep: unknown = 'http://127.0.0.1/';
    for (let i = 0; i < 20; i++) deep = { d: deep };
    expect(urlsIn(deep).truncated).toBe(true);
  });

  it('refuses a call that links to this machine, or carries too many links to check; an ordinary email still goes', async () => {
    const bs = '\\';
    expect(await mcpUrlRefusal({ body: `please open http:${bs}${bs}127.0.0.1:7788/api/approvals` })).toMatch(/this machine or a private network/);
    expect(await mcpUrlRefusal({ to: 'a@b.c', body: 'Agenda: https://nonexistent.invalid/agenda, and [notes](https://also-missing.invalid/n).' })).toBeNull();
    expect(await mcpUrlRefusal({ links: Array.from({ length: 51 }, (_, i) => `https://e${i}.invalid/`) })).toMatch(/more than 50 links/);
    // The URL parser drops tabs and newlines, so a link split by them still reaches its host.
    for (const body of ['http://example.com\t@127.0.0.1:7788/', 'http:\t//127.0.0.1:7788/', 'h\nttp://127.0.0.1:7788/'])
      expect([body, await mcpUrlRefusal({ body })]).toEqual([body, expect.stringMatching(/this machine or a private network/)]);
    // Keys are read, and ws(s)/ftp links get the same host rules.
    expect(await mcpUrlRefusal({ headers: { 'ws://127.0.0.1:7788/socket': 'x' } })).toMatch(/this machine/);
    expect(await mcpUrlRefusal({ target: 'ftp://10.0.0.5/file' })).toMatch(/private network/);
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
