/**
 * Codegen+exec worker — headless, Dockerable. The brain dispatches a coding
 * subtask here; the worker generates file contents via a provider, writes them
 * into the sandbox, runs the task's test command, and returns pass/fail+output.
 *
 * Provider-parameterized: the same worker serves every benchmark arm (the arm's
 * model is passed in). No interactive CLI — fully automatable.
 */
import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import type { Provider } from './provider.js';
import { parseJsonLoose, runCommand } from './util.js';

export interface CodegenInstruction {
  instruction: string;
  /** shell command run in the sandbox to grade the result (exit 0 = pass) */
  testCmd: string;
  /** optional constraint the worker must honor (echoed into the prompt) */
  constraint?: string;
  /** fixed files the worker must NOT create/overwrite (e.g. the grader). default ['test.mjs'] */
  protect?: string[];
}

export interface WorkerResult {
  pass: boolean;
  output: string;
  filesWritten: string[];
  usage: { input: number; output: number };
  raw: string;
}

const MAX_FILE_BYTES = 20_000;

function listSandbox(dir: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const full = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, r);
      else {
        try {
          const c = readFileSync(full, 'utf8');
          if (c.length <= MAX_FILE_BYTES) out.push({ path: r, content: c });
        } catch {
          /* skip binary/unreadable */
        }
      }
    }
  };
  try {
    walk(dir, '');
  } catch {
    /* sandbox may be empty */
  }
  return out;
}

const SYSTEM = [
  'You are a precise coding worker. Implement the requested change.',
  'Output ONLY a JSON object, no prose, no fences:',
  '{"files":[{"path":"relative/path.ext","content":"<COMPLETE file contents>"}]}',
  'Include the FULL contents of every file you create or modify. Keep solutions minimal and correct.',
].join('\n');

export async function runWorker(
  provider: Provider,
  task: CodegenInstruction,
  sandboxDir: string,
): Promise<WorkerResult> {
  mkdirSync(sandboxDir, { recursive: true });
  const existing = listSandbox(sandboxDir);
  const ctx = existing.length
    ? `Existing files:\n${existing.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n')}`
    : 'The sandbox is empty.';
  const protect = task.protect ?? ['test.mjs'];
  const userMsg = [
    `TASK: ${task.instruction}`,
    task.constraint ? `HARD CONSTRAINT (must hold): ${task.constraint}` : '',
    `FIXED FILES (already exist, do NOT create or modify them): ${protect.join(', ')}. Implement the module(s) they import.`,
    ctx,
    'Return the JSON now.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const res = await provider.chat({ system: SYSTEM, messages: [{ role: 'user', content: userMsg }], maxTokens: 4000 });

  let files: { path: string; content: string }[] = [];
  try {
    const parsed = parseJsonLoose<{ files: { path: string; content: string }[] }>(res.text);
    files = Array.isArray(parsed.files) ? parsed.files : [];
  } catch (err) {
    return {
      pass: false,
      output: `worker: could not parse codegen JSON: ${(err as Error).message}`,
      filesWritten: [],
      usage: res.usage,
      raw: res.text.slice(0, 2000),
    };
  }

  const written: string[] = [];
  for (const f of files) {
    if (!f.path || typeof f.content !== 'string') continue;
    if (protect.includes(f.path) || protect.includes(f.path.replace(/^\.\//, ''))) continue; // never overwrite the grader
    // path-traversal guard
    const target = resolve(sandboxDir, f.path);
    if (!target.startsWith(resolve(sandboxDir))) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content, 'utf8');
    written.push(f.path);
  }

  const run = runCommand(task.testCmd, sandboxDir, 60_000);
  return {
    pass: run.code === 0,
    output: `[exit ${run.code}]\n${run.stdout}\n${run.stderr}`.trim().slice(0, 4000),
    filesWritten: written,
    usage: res.usage,
    raw: res.text.slice(0, 500),
  };
}
