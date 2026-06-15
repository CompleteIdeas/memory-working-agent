/**
 * Built-in tools — the action capabilities a coding orchestrator needs beyond
 * codegen: run a command, inspect files, hit an HTTP endpoint. Each is a
 * RegisteredTool (ToolDef + handler). Selected by name from mwa.config.json.
 *
 * Safety: file/command tools are scoped to the sandbox dir (path-traversal
 * guarded), mirroring the worker. http_request is network egress — opt-in.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { runCommand } from '../util.js';
import { resolveAllowed, runCommandAllowed } from './access.js';
import type { RegisteredTool, ToolContext } from './registry.js';

const CAP = 4000;
const SHELL_HINT = process.platform === 'win32'
  ? 'OS shell is cmd.exe (Windows) — avoid bash-only syntax (heredocs, multi-line, &&-chains may differ); for writing files use the write_file tool, not shell redirection'
  : 'OS shell is sh';

// A file path is allowed if it lands inside the workspace OR a folder the user granted
// (access preset). Relative paths resolve against the workspace.
function allowed(ctx: ToolContext, p: string): string | null {
  return resolveAllowed(ctx.sandboxDir, p);
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
    description: `Run a shell command in the project sandbox and return its stdout/stderr. Use for builds, tests, git, grep, running node. (${SHELL_HINT}.)`,
    parameters: { type: 'object', properties: { command: { type: 'string', description: 'the shell command' } }, required: ['command'] },
  },
  handler: async (args, ctx) => {
    const gate = runCommandAllowed(ctx.interactive);
    if (!gate.ok) return `(refused: ${gate.reason})`;
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
    const base = allowed(ctx, String(args.dir ?? '.'));
    if (!base) return '(refused: that folder is outside what this assistant may access — grant it in settings)';
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
    if (!full) return '(refused: that file is outside what this assistant may access — grant its folder in settings)';
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
    const full = allowed(ctx, String(args.path ?? ''));
    if (!full) return '(refused: that path is outside what this assistant may access — grant its folder in settings)';
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

const readDocumentTool: RegisteredTool = {
  def: {
    name: 'read_document',
    description: 'Read a document as text — a LOCAL file path (must be inside a folder you\'re allowed to access) OR an http(s) URL. Handles PDF, Word (.docx), and plain text / markdown / CSV / JSON. Use this to ACTUALLY read a PDF (e.g. a camp Leaders Guide) — never guess its contents.',
    parameters: { type: 'object', properties: { source: { type: 'string', description: 'a file path or http(s) URL' }, max_chars: { type: 'number', description: 'cap returned text, default 8000' } }, required: ['source'] },
  },
  handler: async (args, ctx) => {
    const src = String(args.source ?? '').trim();
    if (!src) return '(no source given)';
    const max = Math.min(Number(args.max_chars ?? 8000), 40000);
    try {
      let buf: Buffer;
      if (/^https?:\/\//i.test(src)) {
        const res = await fetch(src, { headers: { 'user-agent': 'Mozilla/5.0 (MWA)' }, redirect: 'follow' });
        if (!res.ok) return `(couldn't fetch ${src}: ${res.status})`;
        buf = Buffer.from(await res.arrayBuffer());
      } else {
        // Local file: confine to the allowed folders (workspace + granted) — not arbitrary paths.
        const full = allowed(ctx, src);
        if (!full) return '(refused: that file is outside what this assistant may access — grant its folder in settings)';
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
