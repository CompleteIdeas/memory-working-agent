/**
 * MWA config — the single declarative file `mwa.config.json` that `mwa setup`
 * writes and the runtime reads. Keeps setup turnkey: pick model tiers, enabled
 * tools, AWM workspace, escalation threshold; sensible defaults if absent.
 *
 * `tools.mcpServers` is reserved for the Phase-2 MCP bridge (each entry becomes a
 * set of RegisteredTools) — declared now so the schema is stable.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** How MWA talks and how proactive it is — INDEPENDENT of the access preset (a developer can
 *  run with full access but still want concise replies, or vice-versa). 'guided' = explains in
 *  plain language, suggests next steps, takes initiative, learns about the user as it works
 *  (the Mom-test default). 'direct' = concise/technical, leads with the result, no suggested-
 *  follow-up padding unless asked. */
export type InteractionStyle = 'guided' | 'direct';
export const INTERACTION_STYLES: InteractionStyle[] = ['guided', 'direct'];

export interface MwaConfig {
  /** model tiers: fetch = cheap workhorse, reason = escalation ceiling, installer = the
   *  model that reviews/vets connectors from outside the curated library (defaults to reason) */
  models: { fetch: string; reason: string; installer?: string; image?: string; background?: string };
  /** interaction style (plain-language/proactive vs concise/technical). Default 'guided'. */
  style?: InteractionStyle;
  /** awm.workspace (OPT-IN): a shared workspace name. When set, all MWA surfaces (web, CLI,
   *  Telegram, mailbox) register into it and recall spans every agent in it — so a decision made
   *  on one surface/agent/CLI is recalled by another. Unset = isolated per-agent (the default). */
  awm: { workspace?: string };
  /** root for the mailbox I/O workspace (inbox/outputs/outbox/done). Default ./mwa-workspace */
  workspace?: string;
  /** delivery (BL-07): quietHours "22:00-07:00" holds pushes (Telegram) until the window ends. */
  notify?: { quietHours?: string };
  /** billing (2026-10-27): a monthly model-spend budget in dollars; 80% warns, 100% holds unattended jobs. */
  billing?: { monthlyUsd?: number };
  tools: {
    builtins: string[];
    /** MCP servers whose tools register into the same registry (namespaced <server>__<tool>) */
    mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
    /** how connectors get installed: curated-only (library only) | review-required (library
     *  auto + external needs the installation-model review + approval) | off (no installs) */
    installPolicy?: 'curated-only' | 'review-required' | 'off';
    /** local-machine access posture (chosen at setup) + folders the user granted. */
    access?: { preset?: 'locked-down' | 'assistant' | 'developer'; grantedRoots?: string[] };
    /** the agent browser's sites (pending list 2026-10-26, 4b): `deny` hosts it never reaches (any request); with a
     *  non-empty `allow`, only those hosts can be opened or landed on. A host matches itself and its subdomains;
     *  "*.example.com" only the subdomains. MWA_BROWSER_ALLOW / MWA_BROWSER_DENY (comma lists) add to these. */
    browser?: { allow?: string[]; deny?: string[] };
  };
  escalation: { maxFetchFailures: number };
}

export const DEFAULT_CONFIG: MwaConfig = {
  // BL-61: GPT-6.1 Sol through OpenRouter, US hosts only (Robert, 2026-10-20). It won the model bake-off
  // (docs/models.md): 0/32 planted instructions followed or repeated, every judgement question right, $0.10 and
  // 38 s a task — where azure:gpt-5-4-mini, the default before, scored lowest of nine at about the same cost.
  // Both tiers are the one model: the router runs the cheap tier at minimal reasoning effort and the strong tier at
  // high. azure:gpt-5-4-mini stays available (MWA_MODEL or models.fetch) for a deployment billed on Azure.
  models: { fetch: 'openrouter:openai/gpt-6.1-sol', reason: 'openrouter:openai/gpt-6.1-sol' },
  style: 'guided', // proactive, plain-language helper by default (the Mom test); switchable to 'direct'
  awm: {},
  workspace: './mwa-workspace',
  tools: {
    builtins: ['run_command', 'read_file', 'write_file', 'list_files', 'search_files', 'read_document', 'document_look'],
    mcpServers: { search: { command: 'node', args: ['mcp-servers/search.mjs'] } }, // keyless web search (Brave if BRAVE_API_KEY set)
    installPolicy: 'review-required', // curated installs are automatic; external needs review + approval
    access: { preset: 'assistant', grantedRoots: [] }, // least-privilege-ish default; pick at setup
  },
  escalation: { maxFetchFailures: 2 },
};

export const CONFIG_PATH = 'mwa.config.json';

const VALID_PRESETS = ['locked-down', 'assistant', 'developer'];
/** Structural validation of a raw config — returns human-readable warnings (does not throw;
 *  the merge still applies safe defaults). Hand-rolled to keep MWA dependency-light. */
export function validateConfig(raw: Partial<MwaConfig>): string[] {
  const w: string[] = [];
  const isModelSpec = (s: unknown) => typeof s === 'string' && /^[a-z0-9_.-]+:.+/i.test(s);
  if (raw.models) {
    if (raw.models.fetch !== undefined && !isModelSpec(raw.models.fetch)) w.push(`models.fetch "${raw.models.fetch}" should be "provider:model" (e.g. azure:gpt-5-4-mini)`);
    if (raw.models.reason !== undefined && !isModelSpec(raw.models.reason)) w.push(`models.reason "${raw.models.reason}" should be "provider:model"`);
  }
  if (raw.tools?.builtins !== undefined && !Array.isArray(raw.tools.builtins)) w.push('tools.builtins should be an array of tool names');
  for (const k of ['allow', 'deny'] as const) {
    const v = (raw.tools?.browser as Record<string, unknown> | undefined)?.[k];
    if (v !== undefined && !(Array.isArray(v) && v.every((s) => typeof s === 'string'))) w.push(`tools.browser.${k} should be an array of host names`);
  }
  const preset = raw.tools?.access?.preset;
  if (preset !== undefined && !VALID_PRESETS.includes(preset)) w.push(`tools.access.preset "${preset}" is not one of ${VALID_PRESETS.join(' | ')}`);
  if (raw.style !== undefined && !INTERACTION_STYLES.includes(raw.style)) w.push(`style "${raw.style}" is not one of ${INTERACTION_STYLES.join(' | ')}`);
  if (raw.tools?.mcpServers) {
    for (const [name, spec] of Object.entries(raw.tools.mcpServers)) {
      if (!spec || typeof (spec as { command?: unknown }).command !== 'string') w.push(`tools.mcpServers.${name} needs a "command" string`);
    }
  }
  return w;
}

/** Config file path — env-overridable (MWA_CONFIG_PATH) for tests and pointing at a
 *  mounted volume. Read dynamically so the override takes effect at call time. */
export function configPath(): string { return process.env.MWA_CONFIG_PATH ?? CONFIG_PATH; }

/** Persist the interaction style to mwa.config.json (defaults invalid input to 'guided'). */
export function setStyle(style: InteractionStyle): InteractionStyle {
  const chosen: InteractionStyle = INTERACTION_STYLES.includes(style) ? style : 'guided';
  let raw: any = {};
  try { if (existsSync(configPath())) raw = JSON.parse(readFileSync(configPath(), 'utf8')); } catch { /* */ }
  raw.style = chosen;
  writeFileSync(configPath(), JSON.stringify(raw, null, 2) + '\n');
  return chosen;
}

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
    for (const warning of validateConfig(raw)) console.error(`[config] ${warning}`);
  }
  const cfg: MwaConfig = {
    models: { ...DEFAULT_CONFIG.models, ...raw.models },
    style: raw.style && INTERACTION_STYLES.includes(raw.style) ? raw.style : DEFAULT_CONFIG.style,
    awm: { ...DEFAULT_CONFIG.awm, ...raw.awm },
    tools: { ...DEFAULT_CONFIG.tools, ...raw.tools },
    escalation: { ...DEFAULT_CONFIG.escalation, ...raw.escalation },
    workspace: raw.workspace ?? DEFAULT_CONFIG.workspace,
    ...(raw.notify ? { notify: { ...raw.notify } } : {}),
  };
  // Container/env override (point everything at a mounted volume).
  if (process.env.MWA_WORKSPACE) cfg.workspace = process.env.MWA_WORKSPACE;
  // Cloud / 12-factor model override: set the brain from the environment so a container can come
  // up ready-to-chat with NO config file on a fresh volume. MWA_MODEL=<provider:model> sets both
  // fetch + reason; MWA_MODEL_IMAGE sets the image model. (Railway/Azure deploys use this.)
  if (process.env.MWA_MODEL) { cfg.models.fetch = process.env.MWA_MODEL; cfg.models.reason = process.env.MWA_MODEL; }
  if (process.env.MWA_MODEL_IMAGE) cfg.models.image = process.env.MWA_MODEL_IMAGE;
  // Cost (2026-10-23): work nobody waits on (scheduled jobs, hand-offs, thinking time) on its own model, both tiers.
  if (process.env.MWA_BACKGROUND_MODEL) cfg.models.background = process.env.MWA_BACKGROUND_MODEL;
  return cfg;
}
