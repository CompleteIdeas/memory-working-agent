/**
 * Built-in tools — the action capabilities a coding orchestrator needs beyond
 * codegen: run a command, inspect files, hit an HTTP endpoint. Each is a
 * RegisteredTool (ToolDef + handler). Selected by name from mwa.config.json.
 *
 * Safety: file/command tools are scoped to the sandbox dir (path-traversal
 * guarded), mirroring the worker. http_request is network egress — opt-in.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolveVaultRefs, hasVaultRef } from '../vault/vault.js';
import { resolve, join, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import { runCommand, runCommandAsync } from '../util.js';
import { resolveAllowed, runCommandAllowed, allowedRoots, accessPolicy, grantedFolders } from './access.js';
import { loadConfig } from '../config.js';
import { ToolRefusal, type RegisteredTool, type ToolContext } from './registry.js';
import { classifyCommand, scrubbedEnv, writeRefusal, insideReal } from './shell-gate.js';
import { guardedFetch, urlRefusal } from './net-guard.js';
import { insideRoot, listFiles } from '../files.js';
import { OTHER_FOLDER_MARK } from './governance.js';
import { stageAction, registerExecutor, pendingStagedBy, tryAutoApprove } from './approval.js';
import { secondOpinionForCommand, changedSinceReview, type Reviewed } from '../second-opinion.js';

/** A staged command, approved by a person, runs here — in whichever process confirms it (BL-18). */
registerExecutor('run_command_staged', async (args, ctx) => {
  // The access policy at RUN time wins: a switch after staging (Locked-down) still blocks it.
  const gate = runCommandAllowed(true);
  if (!gate.ok) throw new Error(gate.reason);
  // BL-24: a commit whose card carried a second opinion runs only on the change that was read.
  const reviewed = args.reviewed as Reviewed | undefined;
  if (reviewed && (!reviewed.top || await changedSinceReview(reviewed))) throw new Error('the change was edited after this card went out, so neither you nor the second opinion saw what would be committed. Nothing was committed: ask again.');
  // A person approved it, so it may take as long as a test suite does — without freezing this process.
  const r = await runCommandAsync(String(args.command ?? ''), resolve(ctx.sandboxDir), Number(process.env.MWA_APPROVED_COMMAND_TIMEOUT_MS ?? 15 * 60_000), scrubbedEnv());
  const out = `${r.stdout ?? ''}${r.stderr ? `\n[stderr] ${r.stderr}` : ''}`.trim();
  // The TAIL: a test runner's failure summary is at the end (BL-14a review).
  const text = `exit=${r.code}\n${out.length > CAP ? `…${out.slice(-CAP)}` : out || '(no output)'}`;
  // A non-zero exit is a FAILED run, so a later run's approval_results says "failed", not "done".
  if (r.code !== 0) throw new Error(text);
  return text;
});

const CAP = 4000;
const SHELL_HINT = process.platform === 'win32'
  ? 'OS shell is cmd.exe (Windows) — avoid bash-only syntax (heredocs, multi-line, &&-chains may differ); for writing files use the write_file tool, not shell redirection'
  : 'OS shell is sh';

// A file path is allowed if it lands inside the workspace OR a folder the user granted
// (access preset). Relative paths resolve against the workspace.
/** The refusal for a path outside the allowed roots. It has to tell the model how to RECOVER, not
 *  just that it failed. Measured 2026-10-14: a scheduled run asked to write a file "in the
 *  workspace" got this refusal three times (all 3 of its tool calls), then told the user "file-writing
 *  wasn't available in this run — please rerun with write access enabled". It had write access the
 *  whole time, to its OWN folder; the old text named no folder it could use, and its only advice —
 *  "grant its folder in settings" — is meaningless to an unattended run with nobody there. */
function outsideRefusal(ctx: ToolContext, p: string, what: 'file' | 'path' | 'folder'): string {
  const name = basename(String(p || '').replace(/[\\/]+$/, '')) || 'the-file.txt';
  const where = `Your working folder is ${ctx.sandboxDir} and you CAN read and write there: a plain name like "${name}" lands in it.`;
  return ctx.interactive === false
    ? `(refused: that ${what} is outside what this run may access. ${where} Nobody is present to grant other folders, so use the working folder and say in your summary where the result is.)`
    : `(refused: that ${what} is outside what this assistant may access. ${where} To use a different folder, the person can grant it in settings.)`;
}

function allowed(ctx: ToolContext, p: string): string | null {
  // ctx.extraRoots widens this for one run only — the scheduler passes the folder the task was
  // created in. Measured 2026-10-14: a scheduled run refused "write note-3.txt in
  // /data/mwa-workspace/serve/trial-…" outright, because that absolute path (baked into the
  // instruction at schedule time) is a DIFFERENT run's sandbox. The task could never succeed.
  const extra = (ctx.extraRoots ?? []).map((r) => resolve(r));
  if (!extra.length) return resolveAllowed(ctx.sandboxDir, p);
  return resolveAllowed(ctx.sandboxDir, p, [...allowedRoots(ctx.sandboxDir), ...extra]);
}

/** BL-71c: the person's workspace — every chat's folder, scheduled jobs' folders, the outbox. */
function personRoot(): string {
  return resolve(process.env.MWA_WORKSPACE ?? loadConfig().workspace ?? './mwa-workspace');
}

/** The folders that hold the web owner's work: their chats (serve/) and the jobs those chats set up
 *  (scheduled/). Not outputs/ — Telegram's chats, which may be other people (a group, a second allowed
 *  chat) — and not the inbox, outbox or the connector log at the root (BL-71c review). */
export const PERSON_FOLDERS = ['serve', 'scheduled'];


const topFolder = (rel: string) => rel.split(/[\\/]/)[0];
/** Whether this run is one of the web owner's (its folder under serve/ or scheduled/). */
function ownersRun(ctx: ToolContext): boolean {
  return PERSON_FOLDERS.includes(topFolder(relative(personRoot(), resolve(ctx.sandboxDir))));
}

/** A file the web owner already has in another chat's or job's folder, for READING only — or null.
 *  Measured 2026-10-22: a new chat knew from memory that the newsletter notes were in serve/web-l1fs27p,
 *  could not open them, and told the person to "grant access in Settings". Only for the owner's own runs.
 *  Takes an absolute path, or (not for the shell, which resolves against its own folder) one relative to
 *  the workspace as the Files tab shows it. insideRoot refuses dot-files and links out of the workspace. */
function personFile(ctx: ToolContext, p: string, absoluteOnly = false): string | null {
  if (!ownersRun(ctx) || (absoluteOnly && !isAbsolute(p))) return null;
  const root = personRoot();
  const rel = isAbsolute(p) ? relative(root, resolve(p)) : String(p).replace(/^\.?[\\/]+/, '');
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !PERSON_FOLDERS.includes(topFolder(rel))) return null;
  const abs = insideRoot(root, rel);
  return abs && existsSync(abs) ? abs : null;
}

/** Where a READ may go: the run's own folders first; failing that, a file the owner already has (`other`
 *  says which, for the mark). Writes keep using allowed(): a run writes only in its own folder. */
function readable(ctx: ToolContext, p: string, absoluteOnly = false): { path: string; other: boolean } | null {
  const own = allowed(ctx, p);
  // `downloads/` holds what a site handed the browser (browser.ts, 4d): outside content, marked as such, so a read
  // of it counts as reading outside content and is not laundered into the person's own words (audit 2026-10-26).
  if (own && existsSync(own)) return { path: own, other: /^downloads[\\/]/i.test(relative(resolve(ctx.sandboxDir), own)) };
  const pf = personFile(ctx, p, absoluteOnly);
  if (pf) return { path: pf, other: true };
  return own ? { path: own, other: false } : null;
}

/** The REAL path (short names expanded, links followed) lands inside an allowed folder's REAL path —
 *  both sides resolved, so a short-name temp folder (C:\Users\ROBERT~1) doesn't refuse ordinary writes. */
function realAllowed(ctx: ToolContext, full: string): boolean {
  return [ctx.sandboxDir, ...(ctx.extraRoots ?? []), ...allowedRoots(ctx.sandboxDir)].some((r) => insideReal(r, full));
}

/** The mailbox folders (<workspace>/inbox, outbox, done), compared by real path. */
function inMailbox(full: string): boolean {
  const ws = process.env.MWA_WORKSPACE ?? loadConfig().workspace ?? './mwa-workspace';
  return ['inbox', 'outbox', 'done'].some((d) => insideReal(join(ws, d), full));
}

/** Strip HTML to readable text — so read_document on a web page returns prose, not markup. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|br|tr|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const runCommandTool: RegisteredTool = {
  def: {
    name: 'run_command',
    description: `Run a shell command in the project sandbox and return its stdout/stderr. Simple read-only commands (ls, cat, grep, find, head, wc …) run at once; anything else — builds, installs, git, scripts, network — is staged for the person to approve, and you will not see its output this turn. (${SHELL_HINT}.)`,
    parameters: { type: 'object', properties: { command: { type: 'string', description: 'the shell command' } }, required: ['command'] },
  },
  handler: async (args, ctx) => {
    // Unattended in Assistant mode: nothing RUNS, but a command can still be STAGED for the person to
    // approve — otherwise a scheduled job could never ask for its checks to be run (BL-14a review).
    const stageOnly = ctx.interactive === false && accessPolicy().preset === 'assistant';
    const gate = runCommandAllowed(ctx.interactive);
    if (!gate.ok && !stageOnly) return `(refused: ${gate.reason})`;
    const command = String(args.command ?? '').trim();
    if (!command) return '(no command given)';
    const run = (dir: string, env?: NodeJS.ProcessEnv): string => {
      const r = runCommand(command, resolve(dir), 60_000, env); // absolute cwd — Windows spawnSync rejects relative
      const out = `${r.stdout ?? ''}${r.stderr ? `\n[stderr] ${r.stderr}` : ''}`.trim();
      return `exit=${r.code}\n${out.slice(0, CAP) || '(no output)'}`;
    };
    // Developer mode: the model has your shell, environment included (the docs say so plainly).
    if (accessPolicy().preset === 'developer') return run(ctx.sandboxDir);
    // Assistant mode (BL-04, folded into BL-03): a person watching a chat is not a person approving
    // each command. Read-only commands run; anything else is staged for approval — otherwise a
    // backgrounded `curl` to MWA's own approvals endpoint approves whatever the model just staged.
    // Read-only commands only read; another chat's file only by its full path (the shell resolves a relative
    // one against this run's folder). Their output is already outside content, so needs no mark.
    const verdict0 = classifyCommand(command, (p) => readable(ctx, p, true) !== null);
    // A parsed read-only command runs whether or not anyone is watching (Robert, 2026-10-23: "yes"). Unattended runs
    // used to stage even these, and the hard test's background jobs left ten approval cards for their own `tail` and
    // `ls`. The list is the same one a watched chat runs from: no shell features, every path inside what this run may
    // read, no secrets in the environment; the output still taints the run. Everything else still waits.
    if (verdict0.kind === 'read-only') return run(ctx.sandboxDir, scrubbedEnv());
    const verdict = verdict0;
    // BL-72: with the reviewer on, a command it passes runs now — with no secrets in its environment, as a
    // read-only command does — instead of waiting for the person. The fixed rules see the command itself.
    // A run nobody watches runs read-only commands (above) and nothing else without a person (BL-72 review, H4).
    const auto = stageOnly ? { ran: false as const, review: undefined }
      : await tryAutoApprove({ tool: 'run_command', ctx, command, summary: `Run this command in ${ctx.sandboxDir}:\n  ${command}\n(Needs approval because ${verdict.reason}.)`,
        run: async () => run(ctx.sandboxDir, scrubbedEnv()) });
    if (auto.ran) return auto.text;
    // A run nobody watches may stage only a few: a tainted job must not flood the approvals list.
    if (stageOnly && ctx.runId && pendingStagedBy(ctx.runId, 'tool').length >= 3) return '(refused: this run has already asked for 3 approvals — wait for the person, and say in your summary what is waiting)';
    // BL-24: a commit gets a second opinion on its change, at the top of the card (when configured).
    // Only within the folders this run may use (the job folder and those the person granted).
    const second = await secondOpinionForCommand(command, resolve(ctx.sandboxDir), (dir) => realAllowed(ctx, dir));
    const id = stageAction({
      tool: 'run_command', ctx,
      // The card is now the last defense for anything not read-only (second BL-03 review): show the
      // command in full and say plainly when it reaches the network or this machine's own MWA controls.
      // Warnings FIRST: a channel that cuts a long card (Telegram) must not cut them off.
      summary: [
        ...(second?.lines ?? []),
        /\b(curl|wget|fetch|https?|nc|ncat|telnet|ssh|scp|ftp|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|bitsadmin|certutil)\b/i.test(command) ? '⚠ It reaches the network.' : '',
        /localhost|127\.|0\.0\.0\.0|\[::|::1|0x7f|2130706433|\/api\/approvals/i.test(command) ? '⚠ It targets this machine, possibly MWA\'s own controls (including approvals). Do not approve it unless you wrote it.' : '',
        `Run this command in ${ctx.sandboxDir}:`, `  ${command}`, `(Needs approval because ${verdict.reason}.)`,
        // Say plainly what approving means (BL-14a review): it runs as the person, and a test or build
        // command runs whatever code is in that folder — including code MWA wrote.
        'Approving runs it as you, with your files and network. If it runs tests or a build, it runs the code in that folder, including any MWA wrote: look at the change first.',
      ].filter(Boolean).join('\n'),
      executor: 'run_command_staged', args: { command, ...(second?.reviewed ? { reviewed: second.reviewed } : {}) }, reviewed: auto.review,
      ...(ctx.interactive === false ? { ttlMs: 24 * 60 * 60_000 } : {}),
    });
    return (
      `[APPROVAL REQUIRED] This command needs the person's approval because ${verdict.reason}. It has NOT run.\n` +
      `confirmation_id: ${id}\n` +
      `The person approves or declines it in the MWA app (the approvals list) or with the Approve button in Telegram; ` +
      `you will not see its output in this turn. You cannot approve it yourself. If a read-only command would do ` +
      `(ls, cat, grep, find, head, tail, wc), use that instead; otherwise tell the person what is waiting, and finish.`
    );
  },
};

/** The files under a folder, relative to it (skips node_modules and dot-files), at most `cap`. */
function filesUnder(base: string, cap = 200): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= cap) return;
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(base, '');
  return out;
}

/** The person's granted folders this run may read, for a listing or search with no `dir` (F07, 2026-10-24). */
const grantedFor = (ctx: ToolContext) => grantedFolders(ctx.sandboxDir).filter((r) => r.readable).map((r) => r.path);

const listFilesTool: RegisteredTool = {
  def: {
    name: 'list_files',
    description: 'List files in your working folder and in the person\'s granted folders (skips node_modules and dotfiles). ' +
      'With `dir`, lists that folder only (a subfolder of yours, or a granted folder\'s path). With `search`, ' +
      'finds the person\'s files by name across ALL their chats and jobs instead (newest first, with full paths you can read): ' +
      'use it when they mention a file from an earlier conversation.',
    parameters: { type: 'object', properties: {
      dir: { type: 'string', description: 'optional: one folder to list (a subfolder, or a granted folder\'s path); default: your working folder and every granted folder' },
      search: { type: 'string', description: 'optional: words in the file name or folder, to search every file the person has (e.g. "newsletter"); "*" lists the newest' },
    }, required: [] },
  },
  handler: async (args, ctx) => {
    if (args.search !== undefined && String(args.search).trim()) {
      // BL-71c: the person's files from every chat and job, the same list as their Files tab.
      if (!ownersRun(ctx)) return '(searching other chats\' files is only for the owner\'s own chats and jobs)';
      const root = personRoot();
      const words = String(args.search).toLowerCase().split(/\s+/).filter((w) => w && w !== '*');
      // insideRoot again: the listing follows links, and a link must not even name a file outside.
      const hits = listFiles(root).filter((f) => PERSON_FOLDERS.includes(topFolder(f.path)) && insideRoot(root, f.path)
        && words.every((w) => f.path.toLowerCase().includes(w))).slice(0, 40);
      if (!hits.length) return `(no files match "${String(args.search).slice(0, 60)}" — try fewer or other words, or "*" for the newest)`;
      // File names were chosen by earlier runs, some of which read outside content: marked like the files.
      return `${OTHER_FOLDER_MARK}\n` + hits.map((f) => `${join(root, f.path)} · ${new Date(f.mtime).toISOString().slice(0, 16).replace('T', ' ')} · ${f.size} bytes`).join('\n');
    }
    const dirGiven = args.dir !== undefined && String(args.dir).trim() !== '' && String(args.dir).trim() !== '.';
    // No `dir`: the working folder AND the person's granted folders, each under its own heading, so a question
    // about "my files" is answered from the folders they granted rather than "I couldn't find any files" (F07).
    const granted = dirGiven ? [] : grantedFor(ctx);
    if (granted.length) {
      const sections = [`== your working folder (${ctx.sandboxDir}) ==\n${filesUnder(resolve(ctx.sandboxDir)).join('\n') || '(empty)'}`];
      for (const g of granted) sections.push(`== the person's folder ${g} (read_file takes ${g}${sep}<name>) ==\n${filesUnder(g).join('\n') || '(empty)'}`);
      return sections.join('\n\n');
    }
    const found = readable(ctx, String(args.dir ?? '.'));
    if (!found) return outsideRefusal(ctx, String(args.dir ?? '.'), 'folder');
    const listing = filesUnder(found.path).join('\n') || '(empty)';
    return found.other ? `${OTHER_FOLDER_MARK}\n${listing}` : listing;
  },
};

const readFileTool: RegisteredTool = {
  def: {
    name: 'read_file',
    description: 'Read a file: one in your working folder, or any file the person already has from another chat or job (give its full path — list_files with `search` finds it). A long file comes in windows: the result says how to read on (`offset`).',
    parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number', description: 'read on from this character (the last result says which)' } }, required: ['path'] },
  },
  handler: async (args, ctx) => {
    const found = readable(ctx, String(args.path ?? ''));
    if (!found) return outsideRefusal(ctx, String(args.path ?? ''), 'file');
    const full = found.path;
    const mark = found.other ? `${OTHER_FOLDER_MARK}\n` : '';
    try {
      const text = readFileSync(full, 'utf8');
      // a short file comes whole, as before; a long one in windows the model can walk (production review 2026-10-27)
      if (text.length <= CAP && !args.offset) return mark + text;
      return mark + windowOf(text, args.offset, CAP, basename(full), 'read_file', { path: String(args.path) });
    } catch (e) {
      // Not-found is an ANSWER, not a failure: a run checking "does this exist yet?" before writing
      // it got "(could not read: ENOENT…)", which both reads as an error and counts as one in the
      // agent's refusal accounting — the first of the three "refusals" in the measured run above.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return `(no such file yet: ${args.path} — nothing exists there. If you meant to create it, call write_file with this path.)`;
      return `(could not read: ${(e as Error).message.slice(0, 80)})`;
    }
  },
};

/**
 * BL-75: a search over the text of files, without the shell. In the experience pilot (2026-10-23) a model with its
 * documents in a granted folder listed that folder 369 times and read a file 14 times: its `grep -rn … | head` was
 * staged for approval (a pipe), and it answered "I couldn't verify" in 17 of 54 answers. The same search over the
 * folders this run may read needs no card — it reads what read_file may read.
 */
const SEARCH_SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|7z|jar|exe|dll|so|dylib|db|sqlite|wal|shm|mp[34]|mov|wav|woff2?|ttf|otf|lock)$/i;
const SEARCH_MAX_FILE = 2_000_000;
const SEARCH_MAX_HITS = 60;
const SEARCH_HITS_PER_FILE = 8;
const searchFilesTool: RegisteredTool = {
  def: {
    name: 'search_files',
    description: 'Search the TEXT of files (case-insensitive) in your working folder and the person\'s granted folders, and get the matching lines with ' +
      'their file and line number — use it to find which file says something before reading it. With `dir`, searches that folder only; `regex: true` reads the query as a regular expression.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'words or a phrase to find in file contents' },
      dir: { type: 'string', description: 'optional: one folder to search (relative to your working folder, or a granted folder\'s path); default: your working folder and every granted folder' },
      regex: { type: 'boolean', description: 'treat the query as a regular expression' },
    }, required: ['query'] },
  },
  handler: async (args, ctx) => {
    const q = String(args.query ?? '').trim();
    if (!q) return '(no query given)';
    const dirGiven = args.dir !== undefined && String(args.dir).trim() !== '' && String(args.dir).trim() !== '.';
    const found = readable(ctx, String(args.dir ?? '.'));
    if (!found) return outsideRefusal(ctx, String(args.dir ?? '.'), 'folder');
    let re: RegExp;
    try { re = new RegExp(args.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } catch (e) { return `(bad regular expression: ${(e as Error).message.slice(0, 80)})`; }
    const hits: string[] = []; let files = 0; let matched = 0;
    // `at` prefixes a hit's path: empty in the working folder (a relative path), the folder's own path in a granted
    // folder (so read_file can open the hit as printed).
    const walk = (d: string, rel: string, at = '') => {
      let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (hits.length >= SEARCH_MAX_HITS) return;
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { walk(join(d, e.name), r, at); continue; }
        if (SEARCH_SKIP_EXT.test(e.name)) continue;
        let text: string;
        try { if (statSync(join(d, e.name)).size > SEARCH_MAX_FILE) continue; text = readFileSync(join(d, e.name), 'utf8'); } catch { continue; }
        files++;
        let inFile = 0;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && inFile < SEARCH_HITS_PER_FILE && hits.length < SEARCH_MAX_HITS; i++) {
          if (!re.test(lines[i])) continue;
          hits.push(`${at}${r}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          inFile++;
        }
        if (inFile) matched++;
      }
    };
    walk(found.path, '');
    // No `dir`: the person's granted folders too (F07) — their hits carry full paths.
    if (!dirGiven) for (const g of grantedFor(ctx)) walk(g, '', g + sep);
    if (!hits.length) return `(nothing in ${files} files matches "${q.slice(0, 60)}" — try fewer or other words)`;
    const body = `${matched} file${matched === 1 ? '' : 's'} match; ${hits.length}${hits.length >= SEARCH_MAX_HITS ? ' (first ' + SEARCH_MAX_HITS + ')' : ''} lines (file:line: text) — read_file opens one:\n${hits.join('\n')}`;
    return found.other ? `${OTHER_FOLDER_MARK}\n${body}` : body;
  },
};

const writeFileTool: RegisteredTool = {
  def: {
    name: 'write_file',
    description: 'Create or overwrite a file in the sandbox with the given content. Cross-platform — prefer this over shell redirection for writing files.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  handler: async (args, ctx) => {
    const full = allowed(ctx, String(args.path ?? ''));
    if (!full) return outsideRefusal(ctx, String(args.path ?? ''), 'path');
    const unsafe = writeRefusal(full);
    if (unsafe) return `(refused: ${unsafe}. Change the project files instead.)`;
    // A link inside an allowed folder must not carry the write outside it (BL-14a review): the REAL
    // path has to be allowed too.
    if (!realAllowed(ctx, full)) return outsideRefusal(ctx, String(args.path ?? ''), 'path');
    // Never into the inbox, outbox or done: a file in the inbox COMMANDS a fresh unattended run, so an
    // agent that could write one could launder a tainted run into a clean one and dodge BL-05's job
    // limits, whatever folders are granted (BL-06 review).
    if (inMailbox(full)) return '(refused: the agent never writes into the inbox, outbox or done folders — a file in the inbox is an instruction, and only the person gives those.)';
    // A write OUTSIDE the run's own folders — into a folder the person granted — waits for their approval like a
    // command does (usability review 2026-10-24, F02: a copy into the granted folder ran at once through write_file
    // while the shell copy's card still waited, so Decline changed nothing). The run's own folder stays immediate.
    const own = [ctx.sandboxDir, ...(ctx.extraRoots ?? [])].some((r) => insideReal(r, full));
    if (!own) {
      const content = String(args.content ?? '');
      const exists = existsSync(full);
      const summary = `${exists ? 'Overwrite' : 'Create'} the file ${full} (${content.length} bytes) in a folder you granted.${exists ? ' The current contents are replaced.' : ''}`;
      const auto = await tryAutoApprove({ tool: 'write_file', summary, ctx, args: { path: full, content }, run: () => writeGranted(full, content) });
      if (auto.ran) return auto.text;
      const id = stageAction({ tool: 'write_file', ctx, summary, executor: 'write_file_granted', args: { path: full, content }, reviewed: auto.review, ...(ctx.interactive === false ? { ttlMs: 24 * 60 * 60_000 } : {}) });
      return `[APPROVAL REQUIRED] Writing ${full} is in a folder the person granted, not in your working folder, so it waits for their approval. It has NOT been written.\n` +
        `confirmation_id: ${id}\nThe person approves or declines it in the app. You cannot approve it yourself. Say what is waiting for their approval; do not say the file was written.`;
    }
    try {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, String(args.content ?? ''), 'utf8');
      return `wrote ${args.path} (${String(args.content ?? '').length} bytes)`;
    } catch (e) {
      return `(could not write ${args.path}: ${(e as Error).message.slice(0, 80)})`;
    }
  },
};
async function writeGranted(full: string, content: string): Promise<string> {
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return `wrote ${full} (${content.length} bytes)`;
}
/** An approved write into a granted folder runs here, in whichever process confirms it (BL-18). The access policy at
 *  run time wins: a folder revoked after staging refuses it. */
registerExecutor('write_file_granted', async (args, ctx) => {
  const full = String(args.path ?? '');
  if (!full || !resolveAllowed(ctx.sandboxDir, full) || !realAllowed(ctx, full)) throw new Error('that folder is no longer granted, so nothing was written');
  const unsafe = writeRefusal(full);
  if (unsafe) throw new Error(unsafe);
  return writeGranted(full, String(args.content ?? ''));
});

const httpRequestTool: RegisteredTool = {
  def: {
    name: 'http_request',
    description: 'Make an HTTP request to a URL and return status + body (capped). For calling APIs / fetching docs.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string', description: 'GET (default), POST, etc.' },
        body: { type: 'string', description: 'optional request body' },
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'optional headers, e.g. {"Authorization": "Bearer {{vault:my-api.key}}"}. A {{vault:…}} reference (vault_list) is filled in only for its own site.' },
        offset: { type: 'number', description: 'read on from this character of a long answer (the last result says which)' },
      },
      required: ['url'],
    },
  },
  handler: async (args) => {
    const url = String(args.url ?? '');
    if (!/^https?:\/\//.test(url)) throw new ToolRefusal('(refused: url must be http(s))');
    // Loopback and private addresses are refused (net-guard): MWA's own approvals endpoint lives there.
    const method = String(args.method ?? 'GET').toUpperCase();
    // Hard timeout so a hung endpoint can't stall the agent run indefinitely.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Number(process.env.MWA_HTTP_TIMEOUT_MS ?? 15_000));
    // Only a refusal made BEFORE anything is sent is MWA refusing (BL-16): it is thrown, so the registry
    // flags it — for this external-classed tool, text alone can't say "refused". Once a request has gone
    // out, the call is an outbound action whatever follows — a redirect the guard then refuses, a
    // timeout — and must stay counted against the run's budget and in the action log (BL-16 review:
    // treating those as refusals let an unattended run send unlimited POSTs unlogged).
    // BL-63: saved vault values go in only now, only for the entry's own site; a reference for another site refuses
    // the whole request before anything is sent.
    const headers: Record<string, string> = args.body ? { 'content-type': 'application/json' } : {};
    let body = args.body ? String(args.body) : undefined;
    try {
      if (hasVaultRef(url)) throw new Error('a vault reference cannot go in the address — put it in a header or the body');
      if (args.headers && typeof args.headers === 'object') for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) headers[k] = resolveVaultRefs(String(v), url);
      if (body) body = resolveVaultRefs(body, url);
    } catch (e) { throw new ToolRefusal(`(refused: ${(e as Error).message})`); }
    const firstHop = await urlRefusal(url);
    if (firstHop) { clearTimeout(timer); throw new ToolRefusal(`(refused: ${firstHop})`); }
    try {
      const res = await guardedFetch(url, {
        method,
        signal: ctl.signal,
        ...(body ? { body } : {}), headers,
      });
      if (typeof res === 'string') return res;
      const text = await res.text();
      // a long answer comes in windows the model can walk (production review 2026-10-27: "the same truncated opening")
      return `status=${res.status}\n${text.length <= CAP && !args.offset ? text : windowOf(text, args.offset, CAP, url.slice(0, 80), 'http_request', { url })}`;
    } catch (e) {
      return `(http_request failed: ${(e as Error).name === 'AbortError' ? 'timed out' : (e as Error).message.slice(0, 120)})`;
    } finally {
      clearTimeout(timer);
    }
  },
};

/** read_document's fetch timeout: MWA_DOCUMENT_TIMEOUT_MS when it is a positive number, else 60 s. */
function documentTimeoutMs(): number { const n = Number(process.env.MWA_DOCUMENT_TIMEOUT_MS); return Number.isFinite(n) && n > 0 ? n : 60_000; }

/**
 * Production review 2026-10-27: "Learn everything you can about the rules of eventing" from an uploaded PDF never
 * got its answer — read_document gave the first 8,000 characters with no way to read on or to pick the pages with
 * the qualification tables, and "read some of those pages visually" could only mean a shell command. Now: pages, an
 * offset to read on from (every reader says how), and document_look, which hands the model a page as a picture the
 * way browser_look does.
 */
/** The bytes of a document: a local file inside an allowed folder, or an http(s) URL through the guard. */
async function loadDocument(src: string, ctx: ToolContext): Promise<Buffer | string> {
  if (/^https?:\/\//i.test(src)) {
    // MWA refusing before anything is sent is flagged (BL-16); the site's own answer — a 404, an error,
    // a redirect the guard refuses after the first request — is a RESULT, as before: a "tell me when it's
    // posted" job must be able to see "not there yet" without reporting a failure every run.
    const firstHop = await urlRefusal(src);
    if (firstHop) throw new ToolRefusal(`(refused: ${firstHop})`);
    // A site that never answers must not hold the run: the connection has no timeout of its own.
    const res = await guardedFetch(src, { headers: { 'user-agent': 'Mozilla/5.0 (MWA)' }, signal: AbortSignal.timeout(documentTimeoutMs()) });
    if (typeof res === 'string') return res;
    if (!res.ok) return `(couldn't fetch ${src}: ${res.status})`;
    return Buffer.from(await res.arrayBuffer());
  }
  // Local file: confine to the allowed folders (workspace + granted) — not arbitrary paths.
  // read_document's output is outside content already (classed external): another chat's file needs no mark.
  const found = readable(ctx, src);
  if (!found) throw new ToolRefusal(outsideRefusal(ctx, src, 'file'));
  return readFileSync(found.path);
}
const isPdf = (src: string, buf: Buffer) => src.toLowerCase().endsWith('.pdf') || buf.subarray(0, 5).toString('latin1') === '%PDF-';
/** "3-5", "4", "2-" → [first, last] within 1..count; nothing or nonsense → the whole document. */
export function pageRange(spec: unknown, count: number): [number, number] {
  const m = /^\s*(\d+)\s*(?:-\s*(\d*))?\s*$/.exec(String(spec ?? ''));
  if (!m || count < 1) return [1, Math.max(1, count)];
  const a = Math.min(Math.max(1, Number(m[1])), count);
  const b = m[2] === undefined ? a : m[2] === '' ? count : Math.min(Math.max(a, Number(m[2])), count);
  return [a, b];
}
/** The window of `text` from `offset`, headed by where it is and how to read on. */
export function windowOf(text: string, offset: unknown, max: number, what: string, tool: string, extra: Record<string, unknown> = {}): string {
  const total = text.length;
  const off = Math.min(Math.max(0, Math.floor(Number(offset) || 0)), total);
  const slice = text.slice(off, off + max);
  const end = off + slice.length;
  const again = Object.entries({ ...extra, offset: end }).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
  const where = total === 0 ? 'no text' : `characters ${off + 1}–${end} of ${total}`;
  const how = end < total ? `; to read on, call ${tool} again with ${again}` : total ? '; that is the end' : '';
  return `(${what}; ${where}${how})\n${slice}`;
}
/** A PDF's pages as text, kept for the last few documents: reading a 73-page rulebook page by page re-parsed the
 *  whole file each call (0.7 s each). Keyed by a hash of the bytes, so a changed file is read afresh. */
const pdfPagesCache = new Map<string, string[]>();
async function pdfPages(buf: Buffer): Promise<string[]> {
  const { createHash } = await import('node:crypto');
  const key = createHash('sha1').update(buf).digest('hex');
  const hit = pdfPagesCache.get(key);
  if (hit) { pdfPagesCache.delete(key); pdfPagesCache.set(key, hit); return hit; }
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages: string[] = Array.isArray(text) ? text.map((t) => String(t ?? '')) : [String(text ?? '')];
  pdfPagesCache.set(key, pages);
  while (pdfPagesCache.size > 4) pdfPagesCache.delete(pdfPagesCache.keys().next().value as string);
  return pages;
}
/** What read_document returns per call when the model does not ask for more (its `max_chars` default). */
export const READ_DOCUMENT_CHARS = 8000;
/**
 * v2 A6 (the big-ask plan): how big a document is, counted the way read_document reads it — no model call. `pages`: a
 * PDF's own page count, else the text in 3,000-character pages; `reads`: the read_document calls it takes at the
 * default window (each is one "page read" in the run log, the unit estimates price by). A file it cannot parse counts
 * as one page of its size in bytes.
 */
export async function documentSize(src: string, buf: Buffer): Promise<{ pages: number; chars: number; reads: number }> {
  const sized = (chars: number, pages?: number) => ({ pages: Math.max(1, pages ?? Math.ceil(chars / 3000)), chars, reads: Math.max(1, Math.ceil(chars / READ_DOCUMENT_CHARS)) });
  try {
    if (isPdf(src, buf)) {
      const pages = await pdfPages(buf);
      // the text read_document shows: each page headed "[page n of N]"
      const chars = pages.reduce((s, t, i) => s + t.trim().length + `[page ${i + 1} of ${pages.length}]\n\n`.length, 0);
      return sized(chars, pages.length);
    }
    if (src.toLowerCase().endsWith('.docx')) {
      const m: any = await import('mammoth');
      const fn = m.extractRawText ?? m.default?.extractRawText;
      const { value } = await fn({ buffer: buf });
      return sized(String(value ?? '').length);
    }
    const text = buf.toString('utf8');
    return sized(/<!doctype html|<html[\s>]/i.test(text.slice(0, 1024)) ? htmlToText(text).length : text.length);
  } catch {
    return sized(buf.length);
  }
}
const MAX_DOCUMENT_LOOKS = Math.max(0, Number(process.env.MWA_DOCUMENT_LOOKS ?? 6) || 0);
const documentLooks = new Map<string, number>(); // per run

const readDocumentTool: RegisteredTool = {
  def: {
    name: 'read_document',
    description: 'Read a document as text — a LOCAL file path (must be inside a folder you\'re allowed to access) OR an http(s) URL. Handles PDF, Word (.docx), and plain text / markdown / CSV / JSON. A PDF is read by page: `pages` ("3-5", "7", "4-") picks them, and every result says how to read on (`offset`). For a table, a form or a page whose text comes back jumbled, document_look shows you the page. Use this to ACTUALLY read a PDF (e.g. a camp Leaders Guide) — never guess its contents.',
    parameters: { type: 'object', properties: { source: { type: 'string', description: 'a file path or http(s) URL' }, pages: { type: 'string', description: 'PDF pages to read, e.g. "3-5", "7" or "4-" (default: all)' }, offset: { type: 'number', description: 'read on from this character (the last result says which)' }, max_chars: { type: 'number', description: 'cap returned text, default 8000' } }, required: ['source'] },
  },
  handler: async (args, ctx) => {
    const src = String(args.source ?? '').trim();
    if (!src) throw new ToolRefusal('(refused: no source given)');
    const max = Math.min(Math.max(500, Number(args.max_chars ?? 8000) || 8000), 40000);
    const name = src.replace(/^.*[\\/]/, '').slice(0, 80);
    try {
      const loaded = await loadDocument(src, ctx);
      if (typeof loaded === 'string') return loaded;
      const buf = loaded;
      const lower = src.toLowerCase();
      if (isPdf(src, buf)) {
        const pages = await pdfPages(buf);
        const [a, b] = pageRange(args.pages, pages.length);
        const chosen = pages.slice(a - 1, b).map((t, i) => `[page ${a + i} of ${pages.length}]\n${t.trim()}`).join('\n\n');
        if (!chosen.replace(/\[page \d+ of \d+\]/g, '').trim()) return `(${name}: ${pages.length} page${pages.length === 1 ? '' : 's'}; pages ${a}–${b} have no extractable text — scanned images, or a drawn table. document_look shows you a page as a picture.)`;
        return windowOf(chosen, args.offset, max, `${name}: ${pages.length} page${pages.length === 1 ? '' : 's'}, showing ${a === b ? `page ${a}` : `pages ${a}–${b}`}${b < pages.length ? ` (pages: "${b + 1}-" reads the rest)` : ''}`, 'read_document', { source: src, ...(args.pages ? { pages: String(args.pages) } : {}) });
      }
      if (lower.endsWith('.docx')) {
        const m: any = await import('mammoth');
        const fn = m.extractRawText ?? m.default?.extractRawText;
        const { value } = await fn({ buffer: buf });
        return windowOf(String(value ?? ''), args.offset, max, name, 'read_document', { source: src });
      }
      const text = buf.toString('utf8');
      // HTML (a web page or .html file) → strip to readable text, not raw markup.
      if (lower.endsWith('.html') || lower.endsWith('.htm') || /<!doctype html|<html[\s>]/i.test(text.slice(0, 1024))) {
        const plain = htmlToText(text);
        return plain ? windowOf(plain, args.offset, max, name, 'read_document', { source: src }) : '(no readable text on that page)';
      }
      return windowOf(text, args.offset, max, name, 'read_document', { source: src });
    } catch (e) {
      if (e instanceof ToolRefusal) throw e;
      return `(could not read document: ${(e as Error).message.slice(0, 140)})`;
    }
  },
};

const documentLookTool: RegisteredTool = {
  def: {
    name: 'document_look',
    description: 'Look at one page of a PDF (or an image file) as a picture, shown to you on your next step: a table, a form, a scanned page, a layout that read_document\'s text does not carry. A file in your folder, the person\'s uploads or a granted folder, or an http(s) URL. A few times a run; read the text first.',
    parameters: { type: 'object', properties: { source: { type: 'string', description: 'the PDF or image: a file path or http(s) URL' }, page: { type: 'number', description: 'the page to look at (1-based), default 1' } }, required: ['source'] },
  },
  handler: async (args, ctx) => {
    const src = String(args.source ?? '').trim();
    if (!src) throw new ToolRefusal('(refused: no source given)');
    const { supportsImages } = await import('../provider.js');
    if (!supportsImages(ctx.brainModel ?? '')) throw new ToolRefusal(`(this model${ctx.brainModel ? ` (${ctx.brainModel})` : ''} cannot see images — read the pages with read_document instead)`);
    const key = ctx.runId ?? 'run';
    const used = documentLooks.get(key) ?? 0;
    if (used >= MAX_DOCUMENT_LOOKS) throw new ToolRefusal(`(refused: this run has already looked at ${MAX_DOCUMENT_LOOKS} pages — read the rest as text with read_document)`);
    const name = src.replace(/^.*[\\/]/, '').slice(0, 80);
    try {
      const loaded = await loadDocument(src, ctx);
      if (typeof loaded === 'string') return loaded;
      const sharp = (await import('sharp')).default;
      let png: Buffer; let where: string;
      if (isPdf(src, loaded)) {
        const { getDocumentProxy, renderPageAsImage } = await import('unpdf');
        const pdf = await getDocumentProxy(new Uint8Array(loaded));
        const count = pdf.numPages;
        const page = Math.min(Math.max(1, Math.floor(Number(args.page) || 1)), count);
        const rendered = await renderPageAsImage(pdf, page, { canvasImport: () => import('@napi-rs/canvas'), scale: 1.5 });
        png = Buffer.from(rendered); where = `page ${page} of ${count} of ${name}`;
      } else if (/\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(src) || /^\x89PNG|^\xff\xd8/.test(loaded.subarray(0, 4).toString('latin1'))) {
        png = loaded; where = name;
      } else throw new ToolRefusal(`(refused: ${name} is not a PDF or an image — read_document reads it as text)`);
      const jpeg = await sharp(png).resize({ width: 1280, height: 1800, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
      documentLooks.set(key, used + 1);
      return { text: `(looking at ${where}; the picture is attached to your next step — read it as a reader would, and quote its figures and names exactly)`, image: { mime: 'image/jpeg', data: jpeg.toString('base64') } };
    } catch (e) {
      if (e instanceof ToolRefusal) throw e;
      return `(could not show the page: ${(e as Error).message.slice(0, 140)})`;
    }
  },
};

export const BUILTIN_TOOLS: Record<string, RegisteredTool> = {
  run_command: runCommandTool,
  list_files: listFilesTool,
  search_files: searchFilesTool,
  read_file: readFileTool,
  write_file: writeFileTool,
  read_document: readDocumentTool,
  document_look: documentLookTool,
  http_request: httpRequestTool,
};

/** Resolve a list of built-in names to RegisteredTools (unknown names skipped). */
export function builtinTools(names: string[]): RegisteredTool[] {
  return names.map((n) => BUILTIN_TOOLS[n]).filter(Boolean);
}
