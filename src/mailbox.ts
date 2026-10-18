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
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync, utimesSync } from 'node:fs';
import { resolve, join, extname, basename, dirname } from 'node:path';
import { setApprovalOwner, setApprovalStorePath } from './tools/approval.js';
import type { MwaConfig } from './config.js';
import { getProvider, type Provider } from './provider.js';
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
/** One finished inbox task — what the web app shows in the chat (BL-06). */
export interface InboxResult {
  id: string; instruction: string; reason: string; outcome?: string; summary: string;
  files: string[]; dir: string; steps: number; toolCalls: number; costUsd: number; durationMs: number;
}

/** A file must sit unchanged this long before it runs, so a slow copy (SMB/NFS) isn't run half-written. */
const SETTLE_MS = 2_000;
/** Claimed files are `.working-<run id>-<original name>`. */
const CLAIM = /^\.working-([a-z0-9]+-[a-z0-9]+)-(.+)$/;
/** A running task refreshes its claim this often; a claim silent for STALE_CLAIM_MS was abandoned. */
const HEARTBEAT_MS = 30_000;
const STALE_CLAIM_MS = 3 * 60_000;

/** A unique run id: the same name dropped twice never shares an outputs folder or a report (BL-06 review). */
function runId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function writeReport(dirs: MailboxDirs, id: string, lines: string[]): void {
  writeFileSync(join(dirs.outbox, `${id}.md`), lines.join('\n\n'), 'utf8');
}

/**
 * Claimed files left behind by a stop or a crash mid-task. They are never re-run — a task that may
 * have half-happened is for a person to drop again — but they are reported, archived and announced,
 * instead of sitting in the inbox forever (BL-06 review). Only a claim whose heartbeat has stopped
 * counts: a running task touches its claim every 30 s, so another watcher starting up never mistakes a
 * live task for an abandoned one (second review). Checked on every poll.
 */
export function recoverInterrupted(dirs: MailboxDirs, onDone?: (r: InboxResult) => void, staleMs = STALE_CLAIM_MS): number {
  let n = 0;
  for (const f of readdirSync(dirs.inbox)) {
    const m = CLAIM.exec(f);
    if (!m) continue;
    try { if (Date.now() - statSync(join(dirs.inbox, f)).mtimeMs < staleMs) continue; } catch { continue; }
    const [, rid, original] = m;
    const id = `${basename(original, extname(original))}-${rid}`;
    let instruction = '';
    try { instruction = readFileSync(join(dirs.inbox, f), 'utf8').trim(); } catch { /* */ }
    const summary = 'Interrupted: MWA stopped while this task was running, so it may be half done. Check its outputs folder, then drop the file in again if it still needs doing.';
    try {
      writeReport(dirs, id, [`# ${id}`, `**Instruction:** ${instruction}`, '**Status:** INTERRUPTED', `**Summary:** ${summary}`]);
      renameSync(join(dirs.inbox, f), join(dirs.done, `${id}${extname(original)}`));
    } catch { continue; }
    try { onDone?.({ id, instruction, reason: 'error', outcome: 'could-not', summary, files: [], dir: join(dirs.outputs, id), steps: 0, toolCalls: 0, costUsd: 0, durationMs: 0 }); } catch { /* */ }
    n++;
  }
  return n;
}

export async function processInbox(opts: {
  config: MwaConfig;
  dbPath?: string;
  maxSteps?: number;
  maxMin?: number;
  onLog?: (msg: string) => void;
  /** whose memory and approvals: `mwa-agent` for `mwa watch`; the web app passes its own (BL-06). */
  agentId?: string;
  /** called after each task, with its report written — the web app posts it to the chat. */
  onDone?: (r: InboxResult) => void;
  /** the models (tests inject stubs; otherwise from the configured providers). */
  brain?: Provider; worker?: Provider;
  /** a watcher's memory of each file's size and time at the last poll: a file must look the same on
   *  two polls in a row, which also catches copies that keep the source's timestamp (robocopy). */
  lastSeen?: Map<string, string>;
}): Promise<number> {
  const log = opts.onLog ?? ((m: string) => console.log(m));
  const dirs = mailboxDirs(opts.config.workspace ?? './mwa-workspace');
  const now = Date.now();
  const items = readdirSync(dirs.inbox)
    // Dotfiles include `.working-…`: a task another watcher has claimed.
    .filter((f) => !f.startsWith('.') && ['.md', '.txt'].includes(extname(f).toLowerCase()))
    // Still being written (a slow network copy): wait for it to settle.
    .filter((f) => {
      try {
        const st = statSync(join(dirs.inbox, f));
        if (!st.isFile() || now - st.mtimeMs < SETTLE_MS) return false;
        if (!opts.lastSeen) return true;
        const sig = `${st.size}:${st.mtimeMs}`;
        const same = opts.lastSeen.get(f) === sig;
        opts.lastSeen.set(f, sig);
        return same;
      } catch { return false; }
    })
    .sort();
  if (!items.length) return 0;

  const brain = opts.brain ?? new RoutedProvider(getProvider('brain'), getProvider('high')); // conductor escalates on struggle/filter
  const worker = opts.worker ?? new RoutedProvider(getProvider('brain'), getProvider('high'));
  const agentId = opts.agentId ?? 'mwa-agent';
  const memory = new MwaMemory(agentId, opts.dbPath ?? './data/agent.db', opts.config.awm.workspace);
  // Approvals this process stages belong to its memory identity, in the store beside its DB (BL-18).
  setApprovalOwner(agentId);
  if (!process.env.MWA_APPROVALS_DB) setApprovalStorePath(resolve(dirname(opts.dbPath ?? './data/agent.db'), 'approvals.db'));
  let processed = 0;
  let close: (() => Promise<void>) | undefined;
  try {
    const built = await buildRegistry(opts.config, memory); // inside the try: a failure still closes memory
    close = built.close;
    const registry = built.registry;
    for (const file of items) {
      opts.lastSeen?.delete(file);
      // CLAIM it first, under a name unique to this run: if `mwa watch` and the web app both watch this
      // folder only one rename succeeds, and the same name dropped again can't overwrite a claim.
      const rid = runId();
      const id = `${basename(file, extname(file))}-${rid}`;
      const claimed = join(dirs.inbox, `.working-${rid}-${file}`);
      try { renameSync(join(dirs.inbox, file), claimed); } catch { continue; }
      const archive = () => { try { renameSync(claimed, join(dirs.done, `${id}${extname(file)}`)); } catch { /* */ } };
      const workDir = join(dirs.outputs, id);
      let instruction = '';
      try {
        instruction = readFileSync(claimed, 'utf8').trim();
        if (!instruction) {
          const summary = 'The file was empty, so there was nothing to do.';
          writeReport(dirs, id, [`# ${id}`, '**Status:** EMPTY', `**Summary:** ${summary}`]);
          archive();
          opts.onDone?.({ id, instruction, reason: 'done', outcome: 'no-change', summary, files: [], dir: workDir, steps: 0, toolCalls: 0, costUsd: 0, durationMs: 0 });
          processed++;
          continue;
        }
        mkdirSync(workDir, { recursive: true });
        log(`▶ ${id}: ${instruction.slice(0, 80)}`);

        // Heartbeat: keep the claim fresh so no other watcher takes this live task for an abandoned one.
        const beat = setInterval(() => { try { const t = new Date(); utimesSync(claimed, t, t); } catch { /* */ } }, HEARTBEAT_MS);
        const r = await runAgent({
          instruction: `${instruction}\n\n(Write any deliverable files into your working directory — they are collected as this task's outputs.)`,
          // The person's own words, without MWA's line above — which asks for files, and would make every
          // inbox task read as a request to write (BL-36 review 3).
          userMessage: instruction,
          dir: workDir, memory, brain, worker, tools: registry,
          workspace: opts.config.awm.workspace,
          session: `task-${id}`,
          // A file dropped in the inbox is unattended in every sense. It was left UNSET, and the shared
          // approval gate only refuses on an explicit false - so an unattended write was confirmable.
          interactive: false,
          budget: { maxSteps: opts.maxSteps ?? 40, maxWallMs: (opts.maxMin ?? 10) * 60_000, consolidateEvery: 10 },
        }).finally(() => clearInterval(beat));

        const files = listFilesRec(workDir);
        writeReport(dirs, id, [
          `# ${id}`,
          `**Instruction:** ${instruction}`,
          `**Status:** ${r.reason.toUpperCase()}${r.outcome ? ` (${r.outcome})` : ''}`,
          `**Summary:** ${r.summary}`,
          `**Stats:** steps=${r.steps} dispatches=${r.dispatches} tools=${r.toolCalls} reRecalls=${r.reRecalls} supersedes=${r.supersedes} sleeps=${r.consolidations} duration=${Math.round(r.durationMs / 1000)}s cost=$${r.costUsd.toFixed(4)}`,
          `**Output files (outputs/${id}/):**`,
          files.length ? files.map((f) => `- ${f}`).join('\n') : '- (none)',
          `**Trace (last 20):**`,
          r.history.slice(-20).map((h) => `- ${h.slice(0, 160).replace(/\n/g, ' ')}`).join('\n'),
          '',
        ]);
        archive();
        log(`■ ${id}: ${r.reason} (${r.steps} steps, ${files.length} files) → outbox/${id}.md`);
        try {
          opts.onDone?.({ id, instruction, reason: r.reason, outcome: r.outcome, summary: r.summary, files, dir: workDir,
            steps: r.steps, toolCalls: r.toolCalls, costUsd: r.costUsd, durationMs: r.durationMs });
        } catch { /* a display hook must never stop the inbox */ }
        processed++;
      } catch (e) {
        // Anything that breaks one task is reported for that task, and the next one still runs.
        const summary = `This task failed before it finished: ${(e as Error).message.slice(0, 200)}`;
        try { writeReport(dirs, id, [`# ${id}`, `**Instruction:** ${instruction}`, '**Status:** ERROR', `**Summary:** ${summary}`]); } catch { /* */ }
        archive();
        log(`✖ ${id}: ${summary}`);
        try { opts.onDone?.({ id, instruction, reason: 'error', outcome: 'could-not', summary, files: [], dir: workDir, steps: 0, toolCalls: 0, costUsd: 0, durationMs: 0 }); } catch { /* */ }
        processed++;
      }
    }
  } finally {
    try { await close?.(); } catch { /* */ }
    memory.close();
  }
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
  agentId?: string;
  onDone?: (r: InboxResult) => void;
}): Promise<void> {
  const log = opts.onLog ?? ((m: string) => console.log(m));
  const dirs = mailboxDirs(opts.config.workspace ?? './mwa-workspace');
  log(`mwa watch — inbox: ${dirs.inbox}`);
  const recover = () => {
    const n = recoverInterrupted(dirs, opts.onDone);
    if (n) log(`${n} task(s) were interrupted (their app stopped mid-task) — reported in outbox/, not re-run`);
  };
  recover();
  if (opts.once) { const n = await processInbox(opts); log(n ? `processed ${n}` : 'inbox empty'); return; }
  const lastSeen = new Map<string, string>();
  // poll loop — the same error is logged at most every 10 minutes (no model configured would
  // otherwise write a line every 5 seconds forever)
  let lastErr = ''; let lastErrAt = 0;
  for (;;) {
    try { recover(); await processInbox({ ...opts, lastSeen }); lastErr = ''; }
    catch (e) {
      const msg = (e as Error).message.slice(0, 120);
      if (msg !== lastErr || Date.now() - lastErrAt > 10 * 60_000) { log(`watch error: ${msg}`); lastErr = msg; lastErrAt = Date.now(); }
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 5_000));
  }
}
