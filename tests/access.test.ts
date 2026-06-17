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
