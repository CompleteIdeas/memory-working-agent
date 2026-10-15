/**
 * BL-15 — dependency upgrades. The suite never exercised the runtime libraries the advisories were
 * in (only src/ imports them), so a green suite after the lockfile bump proved nothing about them.
 * These smoke tests do: a real MCP stdio round trip through MWA's bridge, a MIME parse through
 * mailparser (the library MWA runs on attacker-written email), including the linkify-it DoS input,
 * and the IMAP client loads.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadMcpServers } from '../src/tools/mcp.js';

describe('MCP SDK (bridge round trip)', () => {
  it('connects to a stdio server, lists its tool and calls it', async () => {
    const h = await loadMcpServers({ echo: { command: process.execPath, args: [resolve('tests/fixtures/echo-mcp-server.mjs')] } });
    try {
      const t = h.tools.find((x) => x.def.name === 'echo__echo');
      expect(t).toBeDefined();
      expect(await t!.handler({ text: 'hello' }, { sandboxDir: '.' })).toBe('echo: hello');
    } finally { await h.close(); }
  }, 30_000);
});

describe('email libraries', () => {
  it('mailparser parses a multipart email with HTML and an attachment', async () => {
    const { simpleParser } = await import('mailparser');
    const raw = [
      'From: Jane <jane@example.com>', 'To: rob@example.com', 'Subject: Invoice 42', 'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"', '',
      '--b1', 'Content-Type: text/html; charset=utf-8', '', '<p>Please see <a href="https://example.com/i/42">invoice 42</a>.</p>',
      '--b1', 'Content-Type: text/plain; name="note.txt"', 'Content-Disposition: attachment; filename="note.txt"', 'Content-Transfer-Encoding: base64', '',
      Buffer.from('attached note').toString('base64'), '--b1--', '',
    ].join('\r\n');
    const m = await simpleParser(raw);
    expect(m.subject).toBe('Invoice 42');
    expect(m.from?.value[0].address).toBe('jane@example.com');
    expect(String(m.html)).toContain('invoice 42');
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0].content.toString()).toBe('attached note');
  });

  it('mailparser survives the linkify-it quadratic input (a long run of "mailto:" in plain text) quickly', async () => {
    // Measured by the BL-15 review: ~11 s on the vulnerable mailparser 3.9.10, ~35 ms on 3.9.39. The
    // first version of this test fed HTML, which never reaches linkify-it, and passed on both.
    const { simpleParser } = await import('mailparser');
    const start = Date.now();
    await simpleParser(`Subject: x
Content-Type: text/plain

${'mailto:'.repeat(40000)}`);
    expect(Date.now() - start).toBeLessThan(2000);
  }, 30_000);

  it('imapflow loads and constructs without a network (MWA’s Gmail IMAP connector)', async () => {
    const { ImapFlow } = await import('imapflow');
    const c = new ImapFlow({ host: 'imap.example.com', port: 993, secure: true, auth: { user: 'u', pass: 'p' }, logger: false });
    expect(typeof c.connect).toBe('function');
  });
});
