/**
 * MWA config — the single declarative file `mwa.config.json` that `mwa setup`
 * writes and the runtime reads. Keeps setup turnkey: pick model tiers, enabled
 * tools, AWM workspace, escalation threshold; sensible defaults if absent.
 *
 * `tools.mcpServers` is reserved for the Phase-2 MCP bridge (each entry becomes a
 * set of RegisteredTools) — declared now so the schema is stable.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface MwaConfig {
  /** model tiers: fetch = cheap workhorse, reason = escalation ceiling, installer = the
   *  model that reviews/vets connectors from outside the curated library (defaults to reason) */
  models: { fetch: string; reason: string; installer?: string };
  awm: { workspace?: string };
  /** root for the mailbox I/O workspace (inbox/outputs/outbox/done). Default ./mwa-workspace */
  workspace?: string;
  tools: {
    builtins: string[];
    /** MCP servers whose tools register into the same registry (namespaced <server>__<tool>) */
    mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
    /** how connectors get installed: curated-only (library only) | review-required (library
     *  auto + external needs the installation-model review + approval) | off (no installs) */
    installPolicy?: 'curated-only' | 'review-required' | 'off';
    /** local-machine access posture (chosen at setup) + folders the user granted. */
    access?: { preset?: 'locked-down' | 'assistant' | 'developer'; grantedRoots?: string[] };
  };
  escalation: { maxFetchFailures: number };
}

export const DEFAULT_CONFIG: MwaConfig = {
  models: { fetch: 'azure:gpt-5-4-mini', reason: 'anthropic:claude-sonnet-4-6' },
  awm: {},
  workspace: './mwa-workspace',
  tools: {
    builtins: ['run_command', 'read_file', 'write_file', 'list_files', 'read_document'],
    mcpServers: { search: { command: 'node', args: ['mcp-servers/search.mjs'] } }, // keyless web search (Brave if BRAVE_API_KEY set)
    installPolicy: 'review-required', // curated installs are automatic; external needs review + approval
    access: { preset: 'assistant', grantedRoots: [] }, // least-privilege-ish default; pick at setup
  },
  escalation: { maxFetchFailures: 2 },
};

export const CONFIG_PATH = 'mwa.config.json';

export function loadConfig(path = CONFIG_PATH): MwaConfig {
  try {
    const p = resolve(path);
    const raw = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Partial<MwaConfig>) : {};
    const cfg: MwaConfig = {
      models: { ...DEFAULT_CONFIG.models, ...raw.models },
      awm: { ...DEFAULT_CONFIG.awm, ...raw.awm },
      tools: { ...DEFAULT_CONFIG.tools, ...raw.tools },
      escalation: { ...DEFAULT_CONFIG.escalation, ...raw.escalation },
      workspace: raw.workspace ?? DEFAULT_CONFIG.workspace,
    };
    // Container/env override (point everything at a mounted volume).
    if (process.env.MWA_WORKSPACE) cfg.workspace = process.env.MWA_WORKSPACE;
    return cfg;
  } catch {
    return DEFAULT_CONFIG;
  }
}
