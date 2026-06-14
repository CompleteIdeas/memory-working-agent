/**
 * Built-in tools — the action capabilities a coding orchestrator needs beyond
 * codegen: run a command, inspect files, hit an HTTP endpoint. Each is a
 * RegisteredTool (ToolDef + handler). Selected by name from mwa.config.json.
 *
 * Safety: file/command tools are scoped to the sandbox dir (path-traversal
 * guarded), mirroring the worker. http_request is network egress — opt-in.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, sep, dirname } from 'node:path';
import { runCommand } from '../util.js';
import type { RegisteredTool, ToolContext } from './registry.js';

const CAP = 4000;
const SHELL_HINT = process.platform === 'win32'
  ? 'OS shell is cmd.exe (Windows) — avoid bash-only syntax (heredocs, multi-line, &&-chains may differ); for writing files use the write_file tool, not shell redirection'
  : 'OS shell is sh';

function insideSandbox(ctx: ToolContext, rel: string): string | null {
  const root = resolve(ctx.sandboxDir);
  const full = resolve(root, rel);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

const runCommandTool: RegisteredTool = {
  def: {
    name: 'run_command',
    description: `Run a shell command in the project sandbox and return its stdout/stderr. Use for builds, tests, git, grep, running node. (${SHELL_HINT}.)`,
    parameters: { type: 'object', properties: { command: { type: 'string', description: 'the shell command' } }, required: ['command'] },
  },
  handler: async (args, ctx) => {
    const command = String(args.command ?? '').trim();
    if (!command) return '(no command given)';
    const r = runCommand(command, resolve(ctx.sandboxDir), 60_000); // absolute cwd — Windows spawnSync rejects relative
    const out = `${r.stdout ?? ''}${r.stderr ? `\n[stderr] ${r.stderr}` : ''}`.trim();
    return `exit=${r.code}\n${out.slice(0, CAP) || '(no output)'}`;
  },
};

const listFilesTool: RegisteredTool = {
  def: {
    name: 'list_files',
    description: 'List files in the sandbox (skips node_modules and dotfiles). Optional subdir.',
    parameters: { type: 'object', properties: { dir: { type: 'string', description: 'optional subdirectory, default root' } }, required: [] },
  },
  handler: async (args, ctx) => {
    const base = insideSandbox(ctx, String(args.dir ?? '.'));
    if (!base) return '(refused: path outside sandbox)';
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
    const full = insideSandbox(ctx, String(args.path ?? ''));
    if (!full) return '(refused: path outside sandbox)';
    try {
      if (statSync(full).size > CAP * 6) return `(large file; first ${CAP} bytes)\n` + readFileSync(full, 'utf8').slice(0, CAP);
      return readFileSync(full, 'utf8').slice(0, CAP);
    } catch (e) {
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
    const full = insideSandbox(ctx, String(args.path ?? ''));
    if (!full) return '(refused: path outside sandbox)';
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
    if (!/^https?:\/\//.test(url)) return '(refused: url must be http(s))';
    const method = String(args.method ?? 'GET').toUpperCase();
    const res = await fetch(url, {
      method,
      ...(args.body ? { body: String(args.body), headers: { 'content-type': 'application/json' } } : {}),
    });
    const text = (await res.text()).slice(0, CAP);
    return `status=${res.status}\n${text}`;
  },
};

export const BUILTIN_TOOLS: Record<string, RegisteredTool> = {
  run_command: runCommandTool,
  list_files: listFilesTool,
  read_file: readFileTool,
  write_file: writeFileTool,
  http_request: httpRequestTool,
};

/** Resolve a list of built-in names to RegisteredTools (unknown names skipped). */
export function builtinTools(names: string[]): RegisteredTool[] {
  return names.map((n) => BUILTIN_TOOLS[n]).filter(Boolean);
}
