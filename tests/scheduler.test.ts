import { describe, it, expect } from 'vitest';
import { backoffDelay } from '../src/scheduler.js';

describe('scheduler backoff', () => {
  it('uses the base interval when healthy', () => {
    expect(backoffDelay(60_000, 0)).toBe(60_000);
  });
  it('doubles with consecutive failures', () => {
    expect(backoffDelay(60_000, 1)).toBe(120_000);
    expect(backoffDelay(60_000, 2)).toBe(240_000);
    expect(backoffDelay(60_000, 3)).toBe(480_000);
  });
  it('caps at 30 minutes', () => {
    expect(backoffDelay(60_000, 10)).toBe(30 * 60_000);
    expect(backoffDelay(60_000, 99)).toBe(30 * 60_000);
  });
});
