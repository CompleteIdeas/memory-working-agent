#!/usr/bin/env node
/**
 * Bundled web-search MCP server for MWA — exposes a `web_search` tool.
 * Keyless by default (DuckDuckGo HTML); auto-upgrades to Brave if BRAVE_API_KEY is set.
 * Wired in mwa.config.json under tools.mcpServers.search; the brain sees `search__web_search`.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ddgUrl, braveUrl, parseDdg, RECENCY } from './search-core.mjs';

async function braveSearch(q, count, recency) {
  const res = await fetch(braveUrl(q, count, recency), {
    headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`brave ${res.status}`);
  const j = await res.json();
  return (j.web?.results ?? []).slice(0, count).map((r) => `${r.title}
${r.url}
${r.description ?? ''}`);
}

async function ddgSearch(q, count, recency) {
  const res = await fetch(ddgUrl(q, recency), { headers: { 'user-agent': 'Mozilla/5.0' } });
  return parseDdg(res.status, await res.text(), count);
}

const server = new Server({ name: 'search', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'web_search',
    description: 'Search the web and return top results (title, url, snippet). Uses Brave if BRAVE_API_KEY is set, else DuckDuckGo (keyless). Pair with the http_request tool to read a result page.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'number', description: 'max results, default 5' },
      recency: { type: 'string', enum: RECENCY, description: 'only pages from the past day, week, month or year — use it for news and anything dated' } }, required: ['query'] },
    // A search reads; MWA classes its own web_search the same way. Without this every search counted
    // as an outward action and an unattended research job paused after three (BL-41).
    annotations: { readOnlyHint: true },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const q = String(req.params.arguments?.query ?? '');
  const count = Math.min(Number(req.params.arguments?.count ?? 5), 8);
  const recency = String(req.params.arguments?.recency ?? '');
  try {
    const results = process.env.BRAVE_API_KEY ? await braveSearch(q, count, recency) : await ddgSearch(q, count, recency);
    return { content: [{ type: 'text', text: results.length ? results.join('\n\n') : '(no results)' }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `search error: ${e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
