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
import { CONFIG_PATH } from '../config.js';
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
// install → always start). npm entries are vetted during curation; version pinning +
// integrity is the Phase-3 hardening. Keep "access" honest and in plain language.
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
    spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '${MWA_FS_ROOT}'] },
    secrets: [{ env: 'MWA_FS_ROOT', label: 'Folder to allow', help: 'e.g. C:\\Users\\you\\Documents — the agent can only touch files here.' }],
    source: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'github', name: 'GitHub', category: 'Dev', tier: 'curated',
    description: 'Read repositories, issues, and pull requests (and write, if your token allows).',
    access: 'Your GitHub, scoped to the personal access token you provide.',
    spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' } },
    secrets: [{ env: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub personal access token', help: 'Create one at github.com/settings/tokens (scope it to what you want the agent to do).' }],
    source: 'https://github.com/modelcontextprotocol/servers',
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
  try { if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { /* */ }
  return {};
}
function writeConfigRaw(raw: any): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n');
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
