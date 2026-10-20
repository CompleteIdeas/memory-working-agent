/**
 * BL-62 — GPT-6.1 Sol fills every optional tool field with an empty value. A weekday brief arrived as
 * schedule({daily_at: "08:30", days: "weekdays", in_minutes: 0, at: "", …}) and became a one-time job for now.
 */
import { describe, it, expect } from 'vitest';
import { withoutEmptyArgs } from '../src/agent.js';

describe('empty tool arguments mean "not given"', () => {
  it('Sol\'s weekday brief keeps only what it set', () => {
    const sol = { action: 'schedule', kind: 'task', instruction: 'Send me a short brief', in_minutes: 0, at: '', daily_at: '08:30', days: 'weekdays', every_minutes: 0, until: '', limits: '', urgent: false, goal: '', deliver: 'always', check: '' };
    expect(withoutEmptyArgs(sol)).toEqual({ action: 'schedule', kind: 'task', instruction: 'Send me a short brief', daily_at: '08:30', days: 'weekdays', urgent: false, deliver: 'always' });
  });
  it('a real delay stays; a zero means something outside schedule, so it stays there', () => {
    expect(withoutEmptyArgs({ action: 'schedule', instruction: 'x', in_minutes: 20 })).toEqual({ action: 'schedule', instruction: 'x', in_minutes: 20 });
    expect(withoutEmptyArgs({ action: 'read_file', path: 'a.txt', offset: 0, query: '  ', note: null })).toEqual({ action: 'read_file', path: 'a.txt', offset: 0 });
  });
});

import { outOfCredit } from '../src/agent.js';
describe('an AI account out of credit says so (BL-62)', () => {
  it('names the problem and where to fix it; other errors are left alone', () => {
    expect(outOfCredit('openrouter:openai/gpt-6.1-sol 402: {"error":{"message":"This request would exceed your available credits given your current in-flight requests')).toMatch(/out of credit\. Add credit at openrouter\.ai/);
    expect(outOfCredit('anthropic 400: Your credit balance is too low to access the Anthropic API')).toMatch(/Anthropic console/);
    expect(outOfCredit('azure 429: rate limited')).toBeNull();
  });
});
