/**
 * Benchmark task domain. Each task ships a FIXED test (written by setup) that
 * the worker must satisfy — the worker never writes its own grader, so success
 * is objective and the same across all arms. T3 adds a hard constraint checked
 * by inspecting the produced code (context-rot / constraint-at-depth test).
 */
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Task {
  id: string;
  goal: string;
  testCmd: string;
  constraint?: string;
  /** writes the fixed test (and any starters) into the sandbox before the run */
  setup(sandboxDir: string): void;
  /** optional extra grade beyond the test passing (e.g. constraint check) */
  gradeExtra?(sandboxDir: string): { ok: boolean; note: string };
}

function write(dir: string, file: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content, 'utf8');
}

function readMjsExcept(dir: string, except: string): string {
  let blob = '';
  try {
    for (const f of readdirSync(dir)) {
      if (f === except || !f.endsWith('.mjs')) continue;
      blob += readFileSync(join(dir, f), 'utf8') + '\n';
    }
  } catch {
    /* empty */
  }
  return blob;
}

const T1: Task = {
  id: 'stack',
  goal:
    'Create stack.mjs exporting a class `Stack` with methods: push(x); pop() (returns the most-recently-pushed item, or undefined if empty); peek() (returns the top without removing); size(). A fixed test file test.mjs already exists and must pass when you run `node test.mjs`.',
  testCmd: 'node test.mjs',
  setup(dir) {
    write(
      dir,
      'test.mjs',
      [
        "import { Stack } from './stack.mjs';",
        "import assert from 'node:assert';",
        'const s = new Stack();',
        'assert.equal(s.size(), 0);',
        'assert.equal(s.pop(), undefined);',
        's.push(1); s.push(2); s.push(3);',
        'assert.equal(s.size(), 3);',
        'assert.equal(s.peek(), 3);',
        'assert.equal(s.pop(), 3);',
        'assert.equal(s.pop(), 2);',
        'assert.equal(s.size(), 1);',
        'assert.equal(s.peek(), 1);',
        "console.log('PASS');",
      ].join('\n'),
    );
  },
};

const T2: Task = {
  id: 'calc',
  goal:
    "Create calc.mjs exporting `calc(op, a, b)` where op is 'add' | 'sub' | 'mul' | 'div'. It must throw an Error on division by zero and on any unknown op. A fixed test file test.mjs already exists and must pass via `node test.mjs`.",
  testCmd: 'node test.mjs',
  setup(dir) {
    write(
      dir,
      'test.mjs',
      [
        "import { calc } from './calc.mjs';",
        "import assert from 'node:assert';",
        "assert.equal(calc('add',2,3),5);",
        "assert.equal(calc('sub',5,2),3);",
        "assert.equal(calc('mul',4,3),12);",
        "assert.equal(calc('div',10,2),5);",
        "assert.throws(()=>calc('div',1,0));",
        "assert.throws(()=>calc('bogus',1,1));",
        "console.log('PASS');",
      ].join('\n'),
    );
  },
};

const T3: Task = {
  id: 'palindrome',
  goal:
    'Create pal.mjs exporting isPalindrome(s): returns true if s is a palindrome ignoring case and non-alphanumeric characters (so "A man a plan a canal Panama" is true), false otherwise; empty string is true. A fixed test file test.mjs already exists and must pass via `node test.mjs`.',
  constraint: 'Do NOT use the built-in Array .reverse() method anywhere. Implement any reversal manually with a loop.',
  testCmd: 'node test.mjs',
  setup(dir) {
    write(
      dir,
      'test.mjs',
      [
        "import { isPalindrome } from './pal.mjs';",
        "import assert from 'node:assert';",
        "assert.equal(isPalindrome('racecar'), true);",
        "assert.equal(isPalindrome('hello'), false);",
        "assert.equal(isPalindrome('A man a plan a canal Panama'), true);",
        "assert.equal(isPalindrome(''), true);",
        "console.log('PASS');",
      ].join('\n'),
    );
  },
  gradeExtra(dir) {
    const code = readMjsExcept(dir, 'test.mjs');
    const violated = /\.reverse\s*\(/.test(code);
    return { ok: !violated, note: violated ? 'constraint VIOLATED: used .reverse()' : 'constraint held (no .reverse())' };
  },
};

export const TASKS: Task[] = [T1, T2, T3];
