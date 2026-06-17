/**
 * Connector Library — the curated catalog of MCP servers/services MWA can enable.
 *
 * Each entry is a vetted MCP server with a plain-language "what it can touch" line, the
 * spawn spec, and any secrets/config it needs (prompted, stored in .env, referenced from
 * the spec as ${VAR} so secret VALUES never live in mwa.config.json). Enabling/disabling
 * just edits config.tools.mcpServers — the registry rebuilds it on the next message.
 *
 * Trust tiers gate how something gets installed (see installPolicy in config):
 *   curated   — vetted here; safe to enable (the agent may enable these itself).
 *   known     — a known source (e.g. official npm scope); needs the installation-model
 *               review + explicit user approval (Phase 2).
 *   arbitrary — a random repo/URL; deep scan + strong warnings + typed confirm (Phase 3).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { configPath } from '../config.js';
import type { McpServerSpec } from '../tools/mcp.js';

export type TrustTier = 'curated' | 'known' | 'arbitrary';

export interface SecretReq {
  env: string;          // env var name (also used as a ${VAR} ref in the spec)
  label: string;        // what to ask the user for
  help?: string;        // hint / where to get it
  optional?: boolean;   // not required to enable
}

export interface ConnectorEntry {
  id: string;
  name: string;
  category: string;
  description: string;  // plain language — what it does for you
  access: string;       // plain language — what it can touch (the honesty line)
  tier: TrustTier;
  spec: McpServerSpec;  // command/args/env; args+env values may use ${VAR} refs
  secrets?: SecretReq[];
  source?: string;      // homepage / repo, for the "view source" link
}

// The curated library. The two bundled servers ship with MWA (local code, no network
// install → always start). npm entries are VERSION-PINNED (verified on the npm registry
// 2026-06-15) so they're reproducible and "known to start". Keep "access" honest and in
// plain language. Deprecated official servers (puppeteer/postgres/gdrive/slack) are
// deliberately excluded.
export const CONNECTOR_LIBRARY: ConnectorEntry[] = [
  {
    id: 'search', name: 'Web search', category: 'Web', tier: 'curated',
    description: 'Search the web for current information.',
    access: 'Sends search queries to the web. No account, no files.',
    spec: { command: 'node', args: ['mcp-servers/search.mjs'], env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' } },
    secrets: [{ env: 'BRAVE_API_KEY', label: 'Brave Search API key', help: 'Optional — better results; without it, a keyless fallback is used.', optional: true }],
  },
  {
    id: 'fetch', name: 'Read web pages', category: 'Web', tier: 'curated',
    description: 'Open a link and read its text.',
    access: 'Fetches the specific URLs named. No account, no files.',
    spec: { command: 'node', args: ['mcp-servers/fetch.mjs'] },
  },
  {
    id: 'filesystem', name: 'Files in a folder you choose', category: 'Files', tier: 'curated',
    description: 'Read and write files inside one folder you allow.',
    access: 'Read/write ONLY inside the folder you specify — nothing else on your computer.',
    spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@2026.1.14', '${MWA_FS_ROOT}'] },
    secrets: [{ env: 'MWA_FS_ROOT', label: 'Folder to allow', help: 'e.g. C:\\Users\\you\\Documents — the agent can only touch files here.' }],
    source: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'thinking', name: 'Step-by-step reasoning', category: 'Thinking', tier: 'curated',
    description: 'A scratchpad that helps the agent work through hard problems in steps.',
    access: 'A private reasoning scratchpad. No accounts, no internet, no files.',
    spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking@2025.12.18'] },
    source: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'docs', name: 'Library & framework docs', category: 'Dev', tier: 'curated',
    description: 'Look up current documentation for code libraries and frameworks.',
    access: 'Reads public documentation from the web. No account required.',
    spec: { command: 'npx', args: ['-y', '@upstash/context7-mcp@3.2.1'], env: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' } },
    secrets: [{ env: 'CONTEXT7_API_KEY', label: 'Context7 API key', help: 'Optional — only for higher rate limits (context7.com).', optional: true }],
    source: 'https://github.com/upstash/context7',
  },
  {
    id: 'browser', name: 'Web browser (automation)', category: 'Web', tier: 'curated',
    description: 'Open web pages, click, fill forms, and read what a real browser sees.',
    access: 'Drives a headless browser to sites you point it at. Downloads a browser on first use. No account.',
    spec: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.76'] },
    source: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    id: 'github', name: 'GitHub', category: 'Dev', tier: 'curated',
    description: 'Read and write repositories, issues, and pull requests.',
    access: 'Your GitHub, scoped to the personal access token you provide.',
    spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github@2025.4.8'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' } },
    secrets: [{ env: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub personal access token', help: 'Create one at github.com/settings/tokens (scope it to what you want the agent to do).' }],
    source: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'notion', name: 'Notion', category: 'Productivity', tier: 'curated',
    description: 'Read and write your Notion pages and databases.',
    access: 'Only the Notion pages/databases you share with the integration.',
    spec: { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server@2.2.1'], env: { NOTION_TOKEN: '${NOTION_TOKEN}' } },
    secrets: [{ env: 'NOTION_TOKEN', label: 'Notion integration token', help: 'Create an internal integration at notion.so/my-integrations, then share the pages you want with it.' }],
    source: 'https://github.com/makenotion/notion-mcp-server',
  },
  {
    id: 'tavily', name: 'Web search (Tavily)', category: 'Web', tier: 'curated',
    description: 'Higher-quality web search and page extraction.',
    access: 'Sends search queries to Tavily (your account). No files.',
    spec: { command: 'npx', args: ['-y', 'tavily-mcp@0.2.20'], env: { TAVILY_API_KEY: '${TAVILY_API_KEY}' } },
    secrets: [{ env: 'TAVILY_API_KEY', label: 'Tavily API key', help: 'Free key at tavily.com.' }],
    source: 'https://github.com/tavily-ai/tavily-mcp',
  },
  {
    id: 'firecrawl', name: 'Website scraping', category: 'Web', tier: 'curated',
    description: 'Scrape and crawl websites into clean text.',
    access: 'Fetches and crawls the sites you point it at (your Firecrawl account).',
    spec: { command: 'npx', args: ['-y', 'firecrawl-mcp@3.20.4'], env: { FIRECRAWL_API_KEY: '${FIRECRAWL_API_KEY}' } },
    secrets: [{ env: 'FIRECRAWL_API_KEY', label: 'Firecrawl API key', help: 'Key at firecrawl.dev.' }],
    source: 'https://github.com/mendableai/firecrawl-mcp-server',
  },
];

export function listConnectors(query?: string): ConnectorEntry[] {
  if (!query) return CONNECTOR_LIBRARY;
  const q = query.toLowerCase();
  return CONNECTOR_LIBRARY.filter((c) => `${c.id} ${c.name} ${c.category} ${c.description} ${c.access}`.toLowerCase().includes(q));
}

export function getConnector(id: string): ConnectorEntry | undefined {
  return CONNECTOR_LIBRARY.find((c) => c.id === id);
}

/** Required secrets (env vars) for an entry that aren't set yet. */
export function missingSecrets(entry: ConnectorEntry): SecretReq[] {
  return (entry.secrets ?? []).filter((s) => !s.optional && !process.env[s.env]);
}

// --- config mutation: enable/disable a connector in mwa.config.json tools.mcpServers ---
function readConfigRaw(): any {
  try { const p = configPath(); if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')); } catch { /* */ }
  return {};
}
function writeConfigRaw(raw: any): void {
  writeFileSync(configPath(), JSON.stringify(raw, null, 2) + '\n');
}

export function enabledConnectorIds(): string[] {
  const raw = readConfigRaw();
  return Object.keys(raw?.tools?.mcpServers ?? {});
}

/** Enable a curated connector (writes its spec into config.tools.mcpServers). */
export function enableConnector(id: string): { ok: boolean; message: string } {
  const entry = getConnector(id);
  if (!entry) return { ok: false, message: `No connector "${id}" in the library.` };
  const miss = missingSecrets(entry);
  if (miss.length) return { ok: false, message: `Needs ${miss.map((m) => m.label).join(', ')} first.` };
  const raw = readConfigRaw();
  raw.tools = raw.tools ?? {};
  raw.tools.mcpServers = raw.tools.mcpServers ?? {};
  raw.tools.mcpServers[id] = entry.spec;
  writeConfigRaw(raw);
  return { ok: true, message: `${entry.name} enabled — its tools are available on your next message.` };
}

export function disableConnector(id: string): void {
  const raw = readConfigRaw();
  if (raw?.tools?.mcpServers?.[id]) { delete raw.tools.mcpServers[id]; writeConfigRaw(raw); }
}

/** All MCP servers currently wired in config (curated, external, or hand-added). */
export function listMcpServers(): Record<string, McpServerSpec> {
  return (readConfigRaw()?.tools?.mcpServers ?? {}) as Record<string, McpServerSpec>;
}

/** Remove ANY MCP server (by config key) — connector id or hand-added name. */
export function removeMcpServer(name: string): boolean {
  const raw = readConfigRaw();
  if (raw?.tools?.mcpServers?.[name]) { delete raw.tools.mcpServers[name]; writeConfigRaw(raw); return true; }
  return false;
}

/** Add an arbitrary MCP server spec under `name` (used after approval). */
export function addMcpServer(name: string, spec: McpServerSpec): void {
  const raw = readConfigRaw();
  raw.tools = raw.tools ?? {};
  raw.tools.mcpServers = raw.tools.mcpServers ?? {};
  raw.tools.mcpServers[name] = spec;
  writeConfigRaw(raw);
}

/** Install an EXTERNAL npm package as an MCP server, version-PINNED (used only after the
 *  installation-model review + human approval). Returns the config id it was stored under. */
export function enableExternalNpm(name: string, version?: string): { ok: boolean; id: string } {
  const id = name.replace(/[^a-z0-9_-]/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'connector';
  const pkg = version ? `${name}@${version}` : name; // pin when we know the version
  const raw = readConfigRaw();
  raw.tools = raw.tools ?? {};
  raw.tools.mcpServers = raw.tools.mcpServers ?? {};
  raw.tools.mcpServers[id] = { command: 'npx', args: ['-y', pkg] };
  writeConfigRaw(raw);
  return { ok: true, id };
}
