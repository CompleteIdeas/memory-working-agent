import { describe, it, expect } from 'vitest';
import { validateConfig } from '../src/config.js';

describe('validateConfig', () => {
  it('accepts an empty/partial config', () => {
    expect(validateConfig({})).toEqual([]);
  });

  it('accepts a well-formed config', () => {
    const w = validateConfig({
      models: { fetch: 'azure:gpt-5-4-mini', reason: 'anthropic:claude-sonnet-4-6' },
      tools: { builtins: ['read_file'], access: { preset: 'assistant' }, mcpServers: { search: { command: 'node', args: ['x.mjs'] } } },
    } as any);
    expect(w).toEqual([]);
  });

  it('flags a malformed model spec', () => {
    const w = validateConfig({ models: { fetch: 'gpt-5-4-mini', reason: 'azure:m' } } as any);
    expect(w.some((x) => x.includes('models.fetch'))).toBe(true);
    expect(w.some((x) => x.includes('models.reason'))).toBe(false);
  });

  it('flags an invalid access preset', () => {
    const w = validateConfig({ tools: { access: { preset: 'superuser' } } } as any);
    expect(w.some((x) => x.includes('preset'))).toBe(true);
  });

  it('flags builtins that are not an array', () => {
    const w = validateConfig({ tools: { builtins: 'read_file' } } as any);
    expect(w.some((x) => x.includes('builtins'))).toBe(true);
  });

  it('flags an MCP server missing a command', () => {
    const w = validateConfig({ tools: { mcpServers: { broken: { args: ['x'] } } } } as any);
    expect(w.some((x) => x.includes('broken') && x.includes('command'))).toBe(true);
  });
});
