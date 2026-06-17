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
  /** awm.workspace (OPT-IN): a shared workspace name. When set, all MWA surfaces (web, CLI,
   *  Telegram, mailbox) register into it and recall spans every agent in it — so a decision made
   *  on one surface/agent/CLI is recalled by another. Unset = isolated per-agent (the default). */
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
  // Both tiers are the gpt-5.x mini REASONING model (USEA-proven: 14/15, beat Sonnet 7/15 at
  // ~1/40th the cost). The router runs the cheap tier at minimal reasoning_effort (fast,
  // concise) and the strong tier at high (it actually reasons). Escalation = more effort on
  // the same proven model, not a swap to a pricier/weaker one.
  models: { fetch: 'azure:gpt-5-4-mini', reason: 'azure:gpt-5-4-mini' },
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

/** Config file path — env-overridable (MWA_CONFIG_PATH) for tests and pointing at a
 *  mounted volume. Read dynamically so the override takes effect at call time. */
export function configPath(): string { return process.env.MWA_CONFIG_PATH ?? CONFIG_PATH; }

export function loadConfig(path = configPath()): MwaConfig {
  const p = resolve(path);
  let raw: Partial<MwaConfig> = {};
  if (existsSync(p)) {
    try {
      raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<MwaConfig>;
    } catch (e) {
      // A malformed config silently falling back to defaults is a debugging trap — say so.
      console.error(`[config] ${path} is not valid JSON — ignoring it and using defaults. (${(e as Error).message.slice(0, 120)})`);
    }
  }
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
}
