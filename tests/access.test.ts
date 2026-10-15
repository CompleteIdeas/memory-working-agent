import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { resolveAllowed } from '../src/tools/access.js';

// Security: a file tool may only touch paths inside an allowed root. These prove the
// path-traversal guard — the prompt-injection blast radius depends on it holding.
const base = resolve('mwa-access-fixture');
const granted = resolve('mwa-access-granted');

describe('resolveAllowed path guard', () => {
  it('allows a relative path inside the workspace', () => {
    expect(resolveAllowed(base, 'sub/file.txt', [base])).toBe(resolve(base, 'sub/file.txt'));
  });

  it('allows an absolute path inside an allowed root', () => {
    expect(resolveAllowed(base, resolve(granted, 'g.txt'), [base, granted])).toBe(resolve(granted, 'g.txt'));
  });

  it('refuses ../ traversal out of the workspace', () => {
    expect(resolveAllowed(base, '../escape.txt', [base])).toBeNull();
  });

  it('refuses an absolute path outside every allowed root', () => {
    expect(resolveAllowed(base, resolve(base, '..', 'sibling', 'x'), [base])).toBeNull();
  });

  it('refuses a granted-looking path when that root was NOT granted', () => {
    expect(resolveAllowed(base, resolve(granted, 'g.txt'), [base])).toBeNull();
  });
});

/**
 * The scheduler's extra root (2026-10-14). A scheduled task's instruction is written in one run and
 * executed in another, so an absolute path the model baked in at schedule time points at a sibling
 * sandbox. Measured: a fired task refused itself — "the path is currently outside what I'm allowed
 * to access" — and could never have succeeded. The fix passes the creating run's folder as an extra
 * allowed root; it must widen access to THAT folder and nothing else.
 */
describe('resolveAllowed with a scheduled task origin root', () => {
  const sched = resolve('mwa-workspace/scheduled/sched-b0906998-1791959398800');
  const origin = resolve('mwa-workspace/serve/trial-1791952944183-3');
  const sibling = resolve('mwa-workspace/serve/trial-OTHER-SESSION');

  it('refuses the origin path when it is not granted — the measured failure', () => {
    expect(resolveAllowed(sched, resolve(origin, 'note-3.txt'), [sched])).toBeNull();
  });

  it('allows the origin path once it is an extra root', () => {
    expect(resolveAllowed(sched, resolve(origin, 'note-3.txt'), [sched, origin]))
      .toBe(resolve(origin, 'note-3.txt'));
  });

  it('still refuses a DIFFERENT session folder — the root widens by exactly one folder', () => {
    expect(resolveAllowed(sched, resolve(sibling, 'steal.txt'), [sched, origin])).toBeNull();
  });

  it('still refuses traversal out of the origin root', () => {
    expect(resolveAllowed(sched, resolve(origin, '../../../etc/passwd'), [sched, origin])).toBeNull();
  });

  it('keeps resolving RELATIVE paths against the run own folder, not the origin', () => {
    // This is why `origin` is not `dir`: the fired run still works in its own fresh folder.
    expect(resolveAllowed(sched, 'note-3.txt', [sched, origin])).toBe(resolve(sched, 'note-3.txt'));
  });
});
