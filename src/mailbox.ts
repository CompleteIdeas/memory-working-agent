/**
 * Mailbox — the agent's I/O channel + output store. You communicate with the agent
 * by dropping instruction files in inbox/; it works each task in outputs/<id>/
 * (where its generated files land), writes a result report to outbox/<id>.md, and
 * archives the instruction to done/. AWM persists across tasks, so it gets sharper.
 *
 *   <root>/inbox/<id>.(md|txt)   → instruction in
 *   <root>/outputs/<id>/         → working dir + generated deliverables
 *   <root>/outbox/<id>.md        → result report out (status, summary, stats, files, trace)
 *   <root>/done/<id>.(md|txt)    → processed instruction, archived
 *
 * `mwa watch` loops this; `--once` processes the current inbox and exits.
 * (Hive-native richer channel — AWM coordination mailbox — is a future upgrade.)
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { resolve, join, extname, basename } from 'node:path';
import type { MwaConfig } from './config.js';
import { getProvider } from './provider.js';
import { RoutedProvider } from './model-router.js';
import { MwaMemory } from './awm.js';
import { buildRegistry } from './tools/build.js';
import { runAgent } from './agent.js';

export interface MailboxDirs { root: string; inbox: string; outputs: string; outbox: string; done: string }

export function mailboxDirs(root: string): MailboxDirs {
  const r = resolve(root);
  const d = { root: r, inbox: join(r, 'inbox'), outputs: join(r, 'outputs'), outbox: join(r, 'outbox'), done: join(r, 'done') };
  for (const p of [d.inbox, d.outputs, d.outbox, d.done]) mkdirSync(p, { recursive: true });
  return d;
}

function listFilesRec(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

/** Process every instruction currently in inbox/. Returns count processed. */
export async function processInbox(opts: {
  config: MwaConfig;
  dbPath?: string;
  maxSteps?: number;
  maxMin?: number;
  onLog?: (msg: string) => void;
}): Promise<number> {
  const log = opts.onLog ?? ((m: string) => console.log(m));
  const dirs = mailboxDirs(opts.config.workspace ?? './mwa-workspace');
  const items = readdirSync(dirs.inbox)
    .filter((f) => ['.md', '.txt'].includes(extname(f).toLowerCase()))
    .sort();
  if (!items.length) return 0;

  const brain = new RoutedProvider(getProvider('brain'), getProvider('high')); // conductor escalates on struggle/filter
  const worker = new RoutedProvider(getProvider('brain'), getProvider('high'));
  const memory = new MwaMemory('mwa-agent', opts.dbPath ?? './data/agent.db');
  const { registry, close } = await buildRegistry(opts.config);

  let processed = 0;
  for (const file of items) {
    const id = basename(file, extname(file));
    const instrPath = join(dirs.inbox, file);
    const instruction = readFileSync(instrPath, 'utf8').trim();
    if (!instruction) { renameSync(instrPath, join(dirs.done, file)); continue; }

    const workDir = join(dirs.outputs, id);
    mkdirSync(workDir, { recursive: true });
    log(`▶ ${id}: ${instruction.slice(0, 80)}`);

    const r = await runAgent({
      instruction: `${instruction}\n\n(Write any deliverable files into your working directory — they are collected as this task's outputs.)`,
      dir: workDir, memory, brain, worker, tools: registry,
      workspace: opts.config.awm.workspace,
      session: `task-${id}`,
      budget: { maxSteps: opts.maxSteps ?? 40, maxWallMs: (opts.maxMin ?? 10) * 60_000, consolidateEvery: 10 },
    });

    const files = listFilesRec(workDir);
    const report = [
      `# ${id}`,
      `**Instruction:** ${instruction}`,
      `**Status:** ${r.reason.toUpperCase()}`,
      `**Summary:** ${r.summary}`,
      `**Stats:** steps=${r.steps} dispatches=${r.dispatches} tools=${r.toolCalls} reRecalls=${r.reRecalls} supersedes=${r.supersedes} sleeps=${r.consolidations} duration=${Math.round(r.durationMs / 1000)}s cost=$${r.costUsd.toFixed(4)}`,
      `**Output files (outputs/${id}/):**`,
      files.length ? files.map((f) => `- ${f}`).join('\n') : '- (none)',
      `**Trace (last 20):**`,
      r.history.slice(-20).map((h) => `- ${h.slice(0, 160).replace(/\n/g, ' ')}`).join('\n'),
      '',
    ].join('\n\n');
    writeFileSync(join(dirs.outbox, `${id}.md`), report, 'utf8');
    renameSync(instrPath, join(dirs.done, file));
    log(`■ ${id}: ${r.reason} (${r.steps} steps, ${files.length} files) → outbox/${id}.md`);
    processed++;
  }

  await close();
  memory.close();
  return processed;
}

/** Watch the inbox forever (poll). Use processInbox once-through for tests. */
export async function watchInbox(opts: {
  config: MwaConfig;
  dbPath?: string;
  intervalMs?: number;
  once?: boolean;
  maxSteps?: number;
  maxMin?: number;
  onLog?: (msg: string) => void;
}): Promise<void> {
  const log = opts.onLog ?? ((m: string) => console.log(m));
  const dirs = mailboxDirs(opts.config.workspace ?? './mwa-workspace');
  log(`mwa watch — inbox: ${dirs.inbox}`);
  if (opts.once) { const n = await processInbox(opts); log(n ? `processed ${n}` : 'inbox empty'); return; }
  // poll loop
  for (;;) {
    try { await processInbox(opts); } catch (e) { log(`watch error: ${(e as Error).message.slice(0, 120)}`); }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 5_000));
  }
}
