/**
 * Built-in tools — the action capabilities a coding orchestrator needs beyond
 * codegen: run a command, inspect files, hit an HTTP endpoint. Each is a
 * RegisteredTool (ToolDef + handler). Selected by name from mwa.config.json.
 *
 * Safety: file/command tools are scoped to the sandbox dir (path-traversal
 * guarded), mirroring the worker. http_request is network egress — opt-in.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, basename, sep } from 'node:path';
import { runCommand, runCommandAsync } from '../util.js';
import { resolveAllowed, runCommandAllowed, allowedRoots, accessPolicy } from './access.js';
import { loadConfig } from '../config.js';
import { ToolRefusal, type RegisteredTool, type ToolContext } from './registry.js';
import { classifyCommand, scrubbedEnv, writeRefusal, realPathOf } from './shell-gate.js';
import { guardedFetch, urlRefusal } from './net-guard.js';
import { stageAction, registerExecutor, pendingStagedBy } from './approval.js';

/** A staged command, approved by a person, runs here — in whichever process confirms it (BL-18). */
registerExecutor('run_command_staged', async (args, ctx) => {
  // The access policy at RUN time wins: a switch after staging (Locked-down) still blocks it.
  const gate = runCommandAllowed(true);
  if (!gate.ok) throw new Error(gate.reason);
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

/** The REAL path (short names expanded, links followed) lands inside an allowed folder's REAL path —
 *  both sides resolved, so a short-name temp folder (C:\Users\ROBERT~1) doesn't refuse ordinary writes. */
function realAllowed(ctx: ToolContext, full: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const real = (p: string) => { try { return norm(realPathOf(resolve(p))); } catch { return norm(resolve(p)); } };
  const target = real(full);
  const roots = [ctx.sandboxDir, ...(ctx.extraRoots ?? []), ...allowedRoots(ctx.sandboxDir)].map(real);
  return roots.some((r) => target === r || target.startsWith(r.endsWith(sep) ? r : r + sep));
}

/** The mailbox folders (<workspace>/inbox, outbox, done), compared by real path. */
function inMailbox(full: string): boolean {
  const ws = process.env.MWA_WORKSPACE ?? loadConfig().workspace ?? './mwa-workspace';
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const real = (p: string) => { try { return norm(realPathOf(resolve(p))); } catch { return norm(resolve(p)); } };
  const target = real(full);
  return ['inbox', 'outbox', 'done'].map((d) => real(join(ws, d))).some((r) => target === r || target.startsWith(r + sep));
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
    const verdict0 = classifyCommand(command, (p) => allowed(ctx, p) !== null);
    if (verdict0.kind === 'read-only' && !stageOnly) return run(ctx.sandboxDir, scrubbedEnv());
    const verdict = verdict0.kind === 'read-only' ? { kind: 'needs-approval' as const, reason: 'nobody is watching this run, so nothing runs without your approval' } : verdict0;
    // A run nobody watches may stage only a few: a tainted job must not flood the approvals list.
    if (stageOnly && ctx.runId && pendingStagedBy(ctx.runId, 'tool').length >= 3) return '(refused: this run has already asked for 3 approvals — wait for the person, and say in your summary what is waiting)';
    const id = stageAction({
      tool: 'run_command', ctx,
      // The card is now the last defense for anything not read-only (second BL-03 review): show the
      // command in full and say plainly when it reaches the network or this machine's own MWA controls.
      // Warnings FIRST: a channel that cuts a long card (Telegram) must not cut them off.
      summary: [
        /\b(curl|wget|fetch|https?|nc|ncat|telnet|ssh|scp|ftp|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|bitsadmin|certutil)\b/i.test(command) ? '⚠ It reaches the network.' : '',
        /localhost|127\.|0\.0\.0\.0|\[::|::1|0x7f|2130706433|\/api\/approvals/i.test(command) ? '⚠ It targets this machine, possibly MWA\'s own controls (including approvals). Do not approve it unless you wrote it.' : '',
        `Run this command in ${ctx.sandboxDir}:`, `  ${command}`, `(Needs approval because ${verdict.reason}.)`,
        // Say plainly what approving means (BL-14a review): it runs as the person, and a test or build
        // command runs whatever code is in that folder — including code MWA wrote.
        'Approving runs it as you, with your files and network. If it runs tests or a build, it runs the code in that folder, including any MWA wrote: look at the change first.',
      ].filter(Boolean).join('\n'),
      executor: 'run_command_staged', args: { command },
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

const listFilesTool: RegisteredTool = {
  def: {
    name: 'list_files',
    description: 'List files in the sandbox (skips node_modules and dotfiles). Optional subdir.',
    parameters: { type: 'object', properties: { dir: { type: 'string', description: 'optional subdirectory, default root' } }, required: [] },
  },
  handler: async (args, ctx) => {
    const base = allowed(ctx, String(args.dir ?? '.'));
    if (!base) return outsideRefusal(ctx, String(args.dir ?? '.'), 'folder');
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
    walk(base, '');
    return out.slice(0, 200).join('\n') || '(empty)';
  },
};

const readFileTool: RegisteredTool = {
  def: {
    name: 'read_file',
    description: 'Read a file in the sandbox (size-capped). For ground truth / verifying generated code.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  handler: async (args, ctx) => {
    const full = allowed(ctx, String(args.path ?? ''));
    if (!full) return outsideRefusal(ctx, String(args.path ?? ''), 'file');
    try {
      if (statSync(full).size > CAP * 6) return `(large file; first ${CAP} bytes)\n` + readFileSync(full, 'utf8').slice(0, CAP);
      return readFileSync(full, 'utf8').slice(0, CAP);
    } catch (e) {
      // Not-found is an ANSWER, not a failure: a run checking "does this exist yet?" before writing
      // it got "(could not read: ENOENT…)", which both reads as an error and counts as one in the
      // agent's refusal accounting — the first of the three "refusals" in the measured run above.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return `(no such file yet: ${args.path} — nothing exists there. If you meant to create it, call write_file with this path.)`;
      return `(could not read: ${(e as Error).message.slice(0, 80)})`;
    }
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
    try {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, String(args.content ?? ''), 'utf8');
      return `wrote ${args.path} (${String(args.content ?? '').length} bytes)`;
    } catch (e) {
      return `(could not write ${args.path}: ${(e as Error).message.slice(0, 80)})`;
    }
  },
};

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
    const firstHop = await urlRefusal(url);
    if (firstHop) { clearTimeout(timer); throw new ToolRefusal(`(refused: ${firstHop})`); }
    try {
      const res = await guardedFetch(url, {
        method,
        signal: ctl.signal,
        ...(args.body ? { body: String(args.body), headers: { 'content-type': 'application/json' } } : {}),
      });
      if (typeof res === 'string') return res;
      const text = (await res.text()).slice(0, CAP);
      return `status=${res.status}\n${text}`;
    } catch (e) {
      return `(http_request failed: ${(e as Error).name === 'AbortError' ? 'timed out' : (e as Error).message.slice(0, 120)})`;
    } finally {
      clearTimeout(timer);
    }
  },
};

const readDocumentTool: RegisteredTool = {
  def: {
    name: 'read_document',
    description: 'Read a document as text — a LOCAL file path (must be inside a folder you\'re allowed to access) OR an http(s) URL. Handles PDF, Word (.docx), and plain text / markdown / CSV / JSON. Use this to ACTUALLY read a PDF (e.g. a camp Leaders Guide) — never guess its contents.',
    parameters: { type: 'object', properties: { source: { type: 'string', description: 'a file path or http(s) URL' }, max_chars: { type: 'number', description: 'cap returned text, default 8000' } }, required: ['source'] },
  },
  handler: async (args, ctx) => {
    const src = String(args.source ?? '').trim();
    if (!src) throw new ToolRefusal('(refused: no source given)');
    const max = Math.min(Number(args.max_chars ?? 8000), 40000);
    try {
      let buf: Buffer;
      if (/^https?:\/\//i.test(src)) {
        // MWA refusing before anything is sent is flagged (BL-16); the site's own answer — a 404, an error,
        // a redirect the guard refuses after the first request — is a RESULT, as before: a "tell me when it's
        // posted" job must be able to see "not there yet" without reporting a failure every run.
        const firstHop = await urlRefusal(src);
        if (firstHop) throw new ToolRefusal(`(refused: ${firstHop})`);
        const res = await guardedFetch(src, { headers: { 'user-agent': 'Mozilla/5.0 (MWA)' } });
        if (typeof res === 'string') return res;
        if (!res.ok) return `(couldn't fetch ${src}: ${res.status})`;
        buf = Buffer.from(await res.arrayBuffer());
      } else {
        // Local file: confine to the allowed folders (workspace + granted) — not arbitrary paths.
        const full = allowed(ctx, src);
        if (!full) throw new ToolRefusal(outsideRefusal(ctx, src, 'file'));
        buf = readFileSync(full);
      }
      const lower = src.toLowerCase();
      if (lower.endsWith('.pdf') || buf.subarray(0, 5).toString('latin1') === '%PDF-') {
        const { getDocumentProxy, extractText } = await import('unpdf');
        const pdf = await getDocumentProxy(new Uint8Array(buf));
        const { text } = await extractText(pdf, { mergePages: true });
        const t = Array.isArray(text) ? text.join('\n') : String(text ?? '');
        return t.trim().slice(0, max) || '(PDF has no extractable text — likely scanned images)';
      }
      if (lower.endsWith('.docx')) {
        const m: any = await import('mammoth');
        const fn = m.extractRawText ?? m.default?.extractRawText;
        const { value } = await fn({ buffer: buf });
        return String(value ?? '').slice(0, max);
      }
      const text = buf.toString('utf8');
      // HTML (a web page or .html file) → strip to readable text, not raw markup.
      if (lower.endsWith('.html') || lower.endsWith('.htm') || /<!doctype html|<html[\s>]/i.test(text.slice(0, 1024))) {
        return htmlToText(text).slice(0, max) || '(no readable text on that page)';
      }
      return text.slice(0, max);
    } catch (e) {
      if (e instanceof ToolRefusal) throw e;
      return `(could not read document: ${(e as Error).message.slice(0, 140)})`;
    }
  },
};

export const BUILTIN_TOOLS: Record<string, RegisteredTool> = {
  run_command: runCommandTool,
  list_files: listFilesTool,
  read_file: readFileTool,
  write_file: writeFileTool,
  read_document: readDocumentTool,
  http_request: httpRequestTool,
};

/** Resolve a list of built-in names to RegisteredTools (unknown names skipped). */
export function builtinTools(names: string[]): RegisteredTool[] {
  return names.map((n) => BUILTIN_TOOLS[n]).filter(Boolean);
}
