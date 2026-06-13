import { spawnSync } from 'node:child_process';

/**
 * Extract a JSON object/array from model text that may include prose or
 * ```json fences. Returns the parsed value or throws.
 */
export function parseJsonLoose<T = any>(text: string): T {
  const s = text.trim();
  // 1) direct parse FIRST — clean JSON may legitimately contain ```fences```
  //    inside string values (e.g. a dispatch instruction with example code).
  //    Stripping fences before parsing corrupts that. Try the raw object first.
  try {
    return JSON.parse(s) as T;
  } catch {
    /* not bare JSON */
  }
  // 2) whole response wrapped in a fenced block
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim()) as T;
    } catch {
      /* fall through */
    }
  }
  // 3) grab the widest {...} or [...]
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  let start = -1;
  let open = '{';
  let close = '}';
  if (firstObj === -1 && firstArr === -1) throw new Error('no JSON found in text');
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
    start = firstArr;
    open = '[';
    close = ']';
  } else {
    start = firstObj;
  }
  const end = s.lastIndexOf(close);
  if (end <= start) throw new Error('unbalanced JSON in text');
  return JSON.parse(s.slice(start, end + 1)) as T;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a shell command in cwd with a timeout; capture output. Cross-platform. */
export function runCommand(cmd: string, cwd: string, timeoutMs = 60_000): CommandResult {
  const r = spawnSync(cmd, { cwd, shell: true, timeout: timeoutMs, encoding: 'utf8' });
  return {
    code: typeof r.status === 'number' ? r.status : 1,
    stdout: (r.stdout ?? '').slice(-8000),
    stderr: (r.stderr ?? (r.error ? String(r.error.message) : '')).slice(-8000),
  };
}
