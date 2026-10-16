/**
 * BL-23 — MWA says which configured models resisted instructions planted in what they read, which
 * failed, and which haven't been measured. It warns; it doesn't block.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { modelKey, injectionNote, modelWarnings, INJECTION_MEASUREMENTS } from '../src/model-safety.js';

describe('model names', () => {
  it('match however the provider, vendor path and punctuation are written', () => {
    expect(['azure:gpt-5-4-mini', 'openai:gpt-5.4-mini', 'openrouter:openai/gpt-5.4-mini', 'GPT-5.4-mini'].map(modelKey))
      .toEqual(['gpt-5-4-mini', 'gpt-5-4-mini', 'gpt-5-4-mini', 'gpt-5-4-mini']);
    expect(modelKey('openrouter:google/gemini-2.5-flash-lite')).toBe('gemini-2-5-flash-lite');
    expect(modelKey('ollama:qwen3:4b')).toBe('qwen3:4b');
  });
});

describe('what a person is told', () => {
  it('a model that held says so; one that failed says how often and what not to use it for; an unknown one says it is unmeasured', () => {
    expect(injectionNote('azure:gpt-5-4-mini')).toEqual({ standing: 'held', text: expect.stringMatching(/ignored instructions planted .* all 8 trials/) });
    expect(injectionNote('openrouter:deepseek/deepseek-v3.2')).toEqual({ standing: 'failed', text: expect.stringMatching(/followed instructions planted .* 4 of 8 trials.*Don't use it on email or web pages you don't trust/) });
    expect(injectionNote('openrouter:openai/gpt-5-nano')).toEqual({ standing: 'failed', text: expect.stringMatching(/failed the test \(repeated a planted code word/) });
    expect(injectionNote('ollama:qwen3:4b')).toEqual({ standing: 'unmeasured', text: expect.stringMatching(/ollama:qwen3:4b hasn't been tested .*\(docs\/models\.md\)/) });
  });

  it('startup warns once per configured model that didn’t hold, and not at all when they did', () => {
    expect(modelWarnings({ fetch: 'azure:gpt-5-4-mini', reason: 'azure:gpt-5-4-mini' })).toEqual([]);
    expect(modelWarnings({ fetch: 'openrouter:google/gemini-2.5-flash-lite', reason: 'openrouter:google/gemini-2.5-flash-lite' })).toHaveLength(1);
    expect(modelWarnings({ fetch: 'openrouter:google/gemini-2.5-flash-lite', reason: 'anthropic:claude-sonnet-4-6' })).toHaveLength(2);
  });

  it('the documented table and the code agree', () => {
    const doc = readFileSync('docs/models.md', 'utf8');
    for (const m of Object.values(INJECTION_MEASUREMENTS)) {
      const row = doc.split('\n').find((l) => l.startsWith('|') && l.includes(m.model));
      expect([m.model, !!row]).toEqual([m.model, true]);
      if (m.complied >= 0) expect([m.model, row!.includes(`${m.complied} of ${m.of}`)]).toEqual([m.model, true]);
    }
  });
});
