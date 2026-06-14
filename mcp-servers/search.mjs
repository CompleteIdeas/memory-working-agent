#!/usr/bin/env node
/**
 * Bundled web-search MCP server for MWA — exposes a `web_search` tool.
 * Keyless by default (DuckDuckGo HTML); auto-upgrades to Brave if BRAVE_API_KEY is set.
 * Wired in mwa.config.json under tools.mcpServers.search; the brain sees `search__web_search`.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

async function braveSearch(q, count) {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}`, {
    headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`brave ${res.status}`);
  const j = await res.json();
  return (j.web?.results ?? []).slice(0, count).map((r) => `${r.title}\n${r.url}\n${r.description ?? ''}`);
}

async function ddgSearch(q, count) {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { headers: { 'user-agent': 'Mozilla/5.0' } });
  const html = await res.text();
  const snips = [...html.matchAll(/result__snippet"[^>]*>(.*?)<\/a>/gs)].map((s) => s[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  const out = [];
  const rx = /result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs;
  let m, i = 0;
  while ((m = rx.exec(html)) && out.length < count) {
    const title = m[2].replace(/<[^>]+>/g, '').trim();
    let url = m[1];
    const u = url.match(/uddg=([^&]+)/);
    if (u) url = decodeURIComponent(u[1]);
    out.push(`${title}\n${url}\n${snips[i] ?? ''}`);
    i++;
  }
  return out;
}

const server = new Server({ name: 'search', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'web_search',
    description: 'Search the web and return top results (title, url, snippet). Uses Brave if BRAVE_API_KEY is set, else DuckDuckGo (keyless). Pair with the http_request tool to read a result page.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'number', description: 'max results, default 5' } }, required: ['query'] },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const q = String(req.params.arguments?.query ?? '');
  const count = Math.min(Number(req.params.arguments?.count ?? 5), 8);
  try {
    const results = process.env.BRAVE_API_KEY ? await braveSearch(q, count) : await ddgSearch(q, count);
    return { content: [{ type: 'text', text: results.length ? results.join('\n\n') : '(no results)' }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `search error: ${e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
