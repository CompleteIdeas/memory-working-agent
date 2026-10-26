#!/usr/bin/env node
/**
 * `mwa` CLI — the entry point.
 *   mwa setup                              configure providers/AWM, write mwa.config.json
 *   mwa run "<instruction>" [opts]         run the live agent on a free-form instruction
 *     --dir <path>        working directory (default: cwd)
 *     --max-steps <n>     step budget (default 40)
 *     --max-min <m>       wall-clock budget in minutes (default 10)
 *     --db <path>         AWM db file (default ./data/agent.db — persists across runs)
 *
 * `mwa run` is the live runner: a cheap conductor + AWM memory + tools (built-ins +
 * any MCP servers in mwa.config.json), working toward the instruction until
 * done/stuck/budget, with progress streamed to the console.
 */
import { resolve, dirname } from 'node:path';
import { setApprovalOwner, setApprovalStorePath } from './tools/approval.js';
import { runSetup } from './setup.js';
import { loadConfig } from './config.js';
import { getProvider } from './provider.js';
import { RoutedProvider } from './model-router.js';
import { MwaMemory } from './awm.js';
import { buildRegistry } from './tools/build.js';
import { runAgent } from './agent.js';
import { watchInbox, mailboxDirs } from './mailbox.js';
import { runTelegram } from './connectors/telegram.js';
import { connectGmailGuided, connectOutlookGuided } from './connectors/setup-helper.js';
import { runWizard } from './wizard.js';
import { runServe } from './serve.js';
import { runIngest } from './ingest.js';
import { loadEnv } from './env.js';
import { logger } from './logger.js';
import { dbFile } from './paths.js';

// Production safety net. A stray background rejection (scheduler tick, SSE stream,
// MCP child) must not silently take the process down. Log unhandled rejections and
// KEEP serving (other sessions/tasks are unaffected); on a genuinely uncaught
// exception the process state is unsafe — log and exit(1) so the supervisor
// (Docker restart policy / systemd) restarts us clean.
process.on('unhandledRejection', (reason) => {
  logger.error('process', 'unhandledRejection', { error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('process', 'uncaughtException', { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  process.exit(1);
});

function parseFlags(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[a.slice(2)] = next; i++; }
      else flags[a.slice(2)] = ''; // boolean flag (e.g. --once)
    } else positional.push(a);
  }
  return { flags, positional };
}

/** BL-23: say so when a configured model hasn't held against instructions planted in what it reads.
 *  .env first: MWA_MODEL may be set only there, and it decides the model the run actually uses. */
async function warnModels(): Promise<void> {
  try { loadEnv(); const { modelWarnings } = await import('./model-safety.js'); for (const w of modelWarnings(loadConfig().models)) console.log(`⚠ ${w}`); } catch { /* no config yet */ }
}

async function runCommand(args: string[]): Promise<void> {
  const { flags, positional } = parseFlags(args);
  const instruction = positional.join(' ').trim();
  if (!instruction) {
    console.error('usage: mwa run "<instruction>" [--dir .] [--max-steps 40] [--max-min 10] [--db ./data/agent.db]');
    process.exit(1);
  }
  await warnModels();
  const dir = resolve(flags.dir ?? process.cwd()); // absolute — tools/worker spawnSync need it on Windows
  const dbPath = flags.db ?? dbFile();
  const cfg = loadConfig();

  const brain = new RoutedProvider(getProvider('brain'), getProvider('high')); // conductor: cheap → escalate on struggle/filter
  const worker = new RoutedProvider(getProvider('brain'), getProvider('high')); // coder: cheap → escalate on failure
  const memory = new MwaMemory('mwa-agent', dbPath, cfg.awm.workspace);
  // Approvals this run stages belong to the `mwa-agent` identity, in the store beside its DB (BL-18).
  setApprovalOwner('mwa-agent');
  if (!process.env.MWA_APPROVALS_DB) setApprovalStorePath(resolve(dirname(dbPath), 'approvals.db'));
  const { registry, close } = await buildRegistry(cfg, memory);

  console.log(`\n▶ mwa run`);
  console.log(`  instruction: ${instruction}`);
  console.log(`  dir: ${dir}  | tools: ${registry.names().join(', ') || '(none)'}  | db: ${dbPath}\n`);

  const t0 = Date.now();
  const r = await runAgent({
    instruction, dir, memory, brain, worker, tools: registry,
    workspace: cfg.awm.workspace,
    interactive: true, // `mwa run` is a person at a terminal; the gates that need one can fire
    budget: { maxSteps: Number(flags['max-steps'] ?? 40), maxWallMs: Number(flags['max-min'] ?? 10) * 60_000, consolidateEvery: 10 },
    onEvent: (type, d) => {
      const t = `${Math.round((Date.now() - t0) / 1000)}s`;
      if (type === 'start') console.log(`  [${t}] recalled ${d.recalled} prior memories`);
      else if (type === 'recall') console.log(`  [${t}] recall: "${d.query}" (now ${d.total})`);
      else if (type === 'read') console.log(`  [${t}] read ${d.path}`);
      else if (type === 'remember') console.log(`  [${t}] 🧠 remember: ${d.concept}`);
      else if (type === 'tool') console.log(`  [${t}] tool ${d.name} → ${String(d.result).slice(0, 60)}`);
      else if (type === 'dispatch') console.log(`  [${t}] dispatch#${d.n} → ${(d.files as string[])?.join(', ') || '(no files)'}`);
      else if (type === 'sleep') console.log(`  [${t}] 💤 sleep #${d.cycle} (edges+${d.edgesStrengthened})`);
      else if (type === 'escalate') console.log(`  [${t}] ↑ escalated to reason tier`);
      else if (type === 'done') console.log(`  [${t}] done`);
    },
  });
  await close();
  memory.close();

  console.log(`\n■ ${r.reason.toUpperCase()} — ${r.summary}`);
  console.log(`  steps=${r.steps} dispatches=${r.dispatches} tools=${r.toolCalls} reRecalls=${r.reRecalls} supersedes=${r.supersedes} sleeps=${r.consolidations}`);
  console.log(`  duration=${Math.round(r.durationMs / 1000)}s  cost=$${r.costUsd.toFixed(4)}\n`);
  process.exit(r.reason === 'done' ? 0 : 1);
}

async function watchCommand(args: string[]): Promise<void> {
  await warnModels();
  const { flags } = parseFlags(args);
  const cfg = loadConfig();
  if (flags.root) cfg.workspace = flags.root;
  const dirs = mailboxDirs(cfg.workspace ?? './mwa-workspace');
  console.log(`\n▶ mwa watch`);
  console.log(`  drop instruction files (*.md/*.txt) in: ${dirs.inbox}`);
  console.log(`  results → ${dirs.outbox}   outputs → ${dirs.outputs}\n`);
  await watchInbox({
    config: cfg,
    dbPath: flags.db ?? dbFile(),
    once: 'once' in flags,
    intervalMs: flags.interval ? Number(flags.interval) * 1000 : undefined,
    maxSteps: flags['max-steps'] ? Number(flags['max-steps']) : undefined,
    maxMin: flags['max-min'] ? Number(flags['max-min']) : undefined,
    onLog: (m) => console.log(`  ${m}`),
  });
}

async function connectCommand(args: string[]): Promise<void> {
  const { flags, positional } = parseFlags(args);
  const channel = positional[0];
  const cfg = loadConfig();
  const common = { config: cfg, dbPath: flags.db ?? dbFile(), maxSteps: flags['max-steps'] ? Number(flags['max-steps']) : undefined, maxMin: flags['max-min'] ? Number(flags['max-min']) : undefined, onLog: (m: string) => console.log(`  ${m}`) };
  if (channel === 'telegram') { console.log('\n▶ mwa connect telegram'); await warnModels(); return runTelegram(common); }
  if (channel === 'gmail' || channel === 'google') { console.log('\n▶ mwa connect gmail'); loadEnv(); return connectGmailGuided((m) => console.log(m)); }
  if (channel === 'outlook' || channel === 'microsoft') { console.log('\n▶ mwa connect outlook'); loadEnv(); return connectOutlookGuided((m) => console.log(m)); }
  console.error('usage: mwa connect <gmail|outlook|telegram>');
  process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'serve') {
    const { flags } = parseFlags(rest);
    // F16: `mwa serve --data <dir>` puts every runtime file (the store, logs, notifications, transcripts) under one
    // folder, whatever the current directory is. Set before any module reads a path (they read at call time).
    if (flags.data) process.env.MWA_DATA_DIR = resolve(String(flags.data));
    return runServe(flags.port ? Number(flags.port) : undefined);
  }
  if (cmd === 'setup') return runSetup();
  if (cmd === 'check-runner') {
    // BL-14c: YOU run this; it is the only thing with Docker access. MWA gets a URL and a token.
    const { flags } = parseFlags(rest);
    const { startCheckRunner } = await import('./check-runner.js');
    return startCheckRunner({ allow: String(flags.allow ?? '').split(',').map((s) => s.trim()).filter(Boolean), from: flags.from || '.', listen: flags.listen || undefined });
  }
  if (cmd === 'wizard') return runWizard();
  if (cmd === 'run') return runCommand(rest);
  if (cmd === 'watch') return watchCommand(rest);
  if (cmd === 'connect') return connectCommand(rest);
  if (cmd === 'ingest') {
    const { flags } = parseFlags(rest); loadEnv();
    await runIngest({ days: flags.days ? Number(flags.days) : undefined, max: flags.max ? Number(flags.max) : undefined, dbPath: flags.db, onLog: (m) => console.log(`  ${m}`) });
    return;
  }
  if (cmd === 'consolidate') {
    // Maintenance: run AWM sleep-consolidation on demand (cluster overlapping memories, strengthen
    // edges, decay noise, sweep staging) — matures the store even when built from many SHORT
    // interactions that never hit the in-run consolidation. Safe to run anytime; good as a cron.
    loadEnv();
    const cfg = loadConfig();
    const { flags } = parseFlags(rest);
    const dbPath = flags.db ?? dbFile();
    for (const agent of ['mwa-agent', 'mwa-serve']) {
      const m = new MwaMemory(agent, dbPath, cfg.awm.workspace);
      const before = await m.memoryCount();
      const stats = await m.consolidate();
      console.log(`  ${agent}: ${before} memories | ${Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(' ') || '(no changes)'}`);
      m.close();
    }
    return;
  }
  if (cmd === 'migrate-v2') {
    // v2 (A3a): goals, scheduled tasks and job results become Jobs and Tries in app.db. Lossless and idempotent;
    // --dry-run does it in a transaction that is rolled back and prints the counts and orphans.
    loadEnv();
    const { flags } = parseFlags(rest);
    if (flags.data) process.env.MWA_DATA_DIR = resolve(String(flags.data));
    const { migrateV2, describeReport, migrationRecordedAt } = await import('./v2/migrate.js');
    const { runLogPath, notifyPath } = await import('./paths.js');
    const m = new MwaMemory(String(flags.agent ?? process.env.MWA_AGENT_ID ?? 'mwa-serve'), flags.db ?? dbFile(), loadConfig().awm.workspace);
    try {
      const dryRun = flags['dry-run'] !== undefined;
      // Review M1: once recorded (at the first start, or an earlier run), a real run needs --force; v2 has been
      // recording fires live since, and a re-run only adds what is missing — but it should be a decision.
      const at = migrationRecordedAt();
      if (at && !dryRun && flags.force === undefined) {
        console.log(`Already migrated on ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC. Run with --dry-run to see what a re-run would add, or --force to run it again.`);
        return;
      }
      const report = await migrateV2(m, { notifyFile: notifyPath(), runsFile: runLogPath(), dryRun });
      console.log(describeReport(report));
      // A5: the conversations kept before Projects, into General's thread (idempotent; the log is only read)
      const { migrateConversations, describeConversationsReport } = await import('./v2/migrate-conversations.js');
      const { conversationsPath } = await import('./conversations.js');
      console.log(describeConversationsReport(migrateConversations({ file: conversationsPath(), dryRun })));
    } finally { m.close(); }
    return;
  }
  console.error(`unknown command: ${cmd}\nusage: mwa serve | mwa run "<instruction>" | mwa watch [--once] | mwa connect <gmail|outlook|telegram> | mwa consolidate | mwa migrate-v2 [--dry-run] [--force] | mwa setup`);
  process.exit(1);
}

main().catch((e) => { console.error('mwa failed:', e); process.exit(1); });
