#!/usr/bin/env node
/**
 * `mwa setup` — turnkey, NON-interactive onboarding (mirrors AWM's `awm setup`).
 * Detects providers from the environment, verifies the AWM substrate is installed,
 * writes mwa.config.json (model tiers + enabled built-in tools + escalation), and
 * reports readiness. Idempotent and re-runnable. Publish target: npm bin `mwa`.
 *
 * Non-interactive by design (CI / headless friendly): it reads env + existing
 * config and writes sensible defaults — no prompts. Override by editing the file.
 */
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from './env.js';
import { DEFAULT_CONFIG, CONFIG_PATH, type MwaConfig } from './config.js';
import { BUILTIN_TOOLS } from './tools/builtins.js';

export async function runSetup(): Promise<void> {
  loadEnv();
  console.log('MWA setup\n=========');

  // 1) Providers
  const hasAzure = !!(process.env.AZURE_GPT_BASE_URL && process.env.AZURE_GPT_API_KEY);
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  console.log(`brain (fetch tier): ${hasAzure ? `Azure ${process.env.AZURE_GPT_DEPLOYMENT ?? 'gpt-5-4-mini'} (native tools) ✓` : hasAnthropic ? 'Haiku fallback (no AZURE_GPT_* set)' : '✗ MISSING'}`);
  console.log(`reason tier:        ${hasAnthropic ? 'Anthropic Sonnet ✓' : '✗ MISSING — set ANTHROPIC_API_KEY'}`);

  // 2) AWM substrate
  let awmOk = false;
  try { await import('agent-working-memory/dist/storage/sqlite.js'); awmOk = true; } catch { /* */ }
  console.log(`AWM substrate:      ${awmOk ? 'installed ✓' : '✗ MISSING — run: npm install agent-working-memory'}`);

  // 3) Write config (preserve existing tool/escalation choices if present)
  const cfgPath = resolve(CONFIG_PATH);
  let cfg: MwaConfig = DEFAULT_CONFIG;
  if (existsSync(cfgPath)) {
    try { cfg = { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(cfgPath, 'utf8')) as Partial<MwaConfig>) }; } catch { /* */ }
  }
  cfg.models = { fetch: process.env.AZURE_GPT_DEPLOYMENT ?? cfg.models.fetch ?? DEFAULT_CONFIG.models.fetch, reason: cfg.models.reason ?? DEFAULT_CONFIG.models.reason };
  cfg.tools = { ...DEFAULT_CONFIG.tools, ...cfg.tools };
  cfg.tools.builtins = (cfg.tools.builtins ?? DEFAULT_CONFIG.tools.builtins).filter((n) => BUILTIN_TOOLS[n]);
  cfg.escalation = { ...DEFAULT_CONFIG.escalation, ...cfg.escalation };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

  console.log(`\nwrote ${CONFIG_PATH}:`);
  console.log(`  models:     fetch=${cfg.models.fetch}  reason=${cfg.models.reason}`);
  console.log(`  tools:      ${cfg.tools.builtins.join(', ')}`);
  console.log(`              (available: ${Object.keys(BUILTIN_TOOLS).join(', ')}; add MCP servers under tools.mcpServers in Phase 2)`);
  console.log(`  escalation: maxFetchFailures=${cfg.escalation.maxFetchFailures}`);

  // 4) Readiness — minimum viable = AWM + a reason tier (Anthropic). Azure is the optional cheap brain.
  const ready = awmOk && hasAnthropic;
  console.log(`\n${ready ? '✅ MWA is ready.  Next: npm run ui   (or: npm run bench)' : '⚠  Resolve the ✗ items above, then re-run: npm run setup'}`);
}

const _entry = process.argv[1] ?? '';
if (_entry.endsWith('setup.ts') || _entry.endsWith('setup.js')) {
  runSetup().catch((e) => { console.error('setup failed:', e); process.exit(1); });
}
