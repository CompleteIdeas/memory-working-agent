#!/usr/bin/env node
/**
 * Bundled web-fetch MCP server for MWA — exposes a `fetch_url` tool that GETs a URL and
 * returns its readable text (HTML stripped). Pairs with web_search (search.mjs): search,
 * then read a result. Wired in mwa.config.json under tools.mcpServers.fetch; the brain
 * sees `fetch__fetch_url`.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
// The same guard as MWA's own fetch tools, pinned to each connection and redirect (BL-16c). Always on:
// in Developer mode the model has a shell, so this server never needs to reach this machine.
import { pinnedFetch } from './net-core.mjs';

const server = new Server({ name: 'fetch', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'fetch_url',
    description: 'Fetch a web page or API URL and return its readable text (HTML stripped). Use after web_search to read a result page.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, max_chars: { type: 'number', description: 'cap returned text, default 4000' } }, required: ['url'] },
    // A GET that only reads (like search.mjs): MWA classes it a read, so a background research job isn't paused
    // after three pages as if it had acted three times (hard test 2026-10-23). What it reads still taints the run.
    annotations: { readOnlyHint: true },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const url = String(req.params.arguments?.url ?? '');
  const max = Math.min(Number(req.params.arguments?.max_chars ?? 4000), 20000);
  try {
    const res = await pinnedFetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (MWA)' }, signal: AbortSignal.timeout(20_000) });
    if (typeof res === 'string') return { content: [{ type: 'text', text: res }], isError: true };
    const ct = res.headers.get('content-type') ?? '';
    let text = await res.text();
    if (ct.includes('html')) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    return { content: [{ type: 'text', text: `${res.status} ${url}\n\n${text.slice(0, max)}` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `fetch error: ${e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
