/**
 * BL-23 — MWA says which configured models resisted instructions planted in what they read, which
 * failed, and which haven't been measured. A measurement is for one model through one provider. It
 * warns; it doesn't block.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { modelKey, effectiveModel, injectionNote, modelWarnings, INJECTION_MEASUREMENTS } from '../src/model-safety.js';

describe('which model a spec actually runs', () => {
  it('reads provider and model as the provider resolver does; a bare gpt-* name is the Azure deployment', () => {
    expect(effectiveModel('openrouter:google/gemini-2.5-flash-lite')).toEqual({ provider: 'openrouter', model: 'google/gemini-2.5-flash-lite' });
    expect(effectiveModel('gpt-5-4-mini', {})).toEqual({ provider: 'azure', model: 'gpt-5-4-mini' });
    expect(effectiveModel('gpt-5-4-mini', { AZURE_GPT_DEPLOYMENT: 'my-cheap-one' })).toEqual({ provider: 'azure', model: 'my-cheap-one' });
    expect(effectiveModel('claude-sonnet-4-6')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
    expect([modelKey('openai/GPT-5.4-mini'), modelKey('gemini-2.5-flash-lite')]).toEqual(['gpt-5-4-mini', 'gemini-2-5-flash-lite']);
  });
  it('odd specs don’t crash', () => {
    for (const s of ['', ':', 'azure:', 'ollama:qwen3:4b']) expect(injectionNote(s, {}).standing).toBe('unmeasured');
  });
});

describe('what a person is told', () => {
  it('held only for the model through the provider it was measured on', () => {
    expect(injectionNote('azure:gpt-5-4-mini', {})).toEqual({ standing: 'held', text: expect.stringMatching(/ignored instructions planted .* all 8 trials.*deployment name/) });
    expect(injectionNote('gpt-5-4-mini', {}).standing).toBe('held'); // the bare name runs that Azure deployment
    // The same name through another provider, or an Azure deployment running something else, isn't measured.
    expect(injectionNote('openrouter:openai/gpt-5.4-mini', {})).toEqual({ standing: 'unmeasured', text: expect.stringMatching(/through openrouter; it held through azure/) });
    expect(injectionNote('gpt-5-4-mini', { AZURE_GPT_DEPLOYMENT: 'my-cheap-one' }).standing).toBe('unmeasured');
    expect(injectionNote('azure:gpt-5-4-mini-high', {}).standing).toBe('unmeasured');
  });
  it('a model that failed is reported as failing whatever the route, with how often and what not to use it for', () => {
    expect(injectionNote('openrouter:deepseek/deepseek-v3.2', {})).toEqual({ standing: 'failed', text: expect.stringMatching(/followed instructions planted .* 4 of 8 trials \(via openrouter.*Don't use it on email or web pages you don't trust/) });
    expect(injectionNote('openai:gemini-2.5-flash-lite', {}).standing).toBe('failed');
    expect(injectionNote('openrouter:openai/gpt-5-nano', {})).toEqual({ standing: 'failed', text: expect.stringMatching(/failed the test \(repeated a planted code word/) });
    expect(injectionNote('ollama:qwen3:4b', {})).toEqual({ standing: 'unmeasured', text: expect.stringMatching(/ollama:qwen3:4b hasn't been tested .*\(docs\/models\.md\)/) });
  });

  it('startup warns once per configured model that didn’t hold, and not at all when they did', () => {
    expect(modelWarnings({ fetch: 'azure:gpt-5-4-mini', reason: 'azure:gpt-5-4-mini' }, {})).toEqual([]);
    expect(modelWarnings({ fetch: 'openrouter:google/gemini-2.5-flash-lite', reason: 'openrouter:google/gemini-2.5-flash-lite' }, {})).toHaveLength(1);
    expect(modelWarnings({ fetch: 'openrouter:google/gemini-2.5-flash-lite', reason: 'anthropic:claude-sonnet-4-6' }, {})).toHaveLength(2);
  });

  it('the documented table and the code agree, row for row', () => {
    const rows = readFileSync('docs/models.md', 'utf8').split('\n').filter((l) => /^\| (\*\*)?[a-z0-9.-]+(\*\*)? \(/i.test(l));
    expect(rows).toHaveLength(INJECTION_MEASUREMENTS.length);
    for (const m of INJECTION_MEASUREMENTS) {
      const row = rows.find((l) => l.replace(/\*/g, '').startsWith(`| ${m.model} (`));
      expect([m.model, !!row]).toEqual([m.model, true]);
      const cells = row!.split('|').map((c) => c.replace(/\*/g, '').trim());
      expect([m.model, cells[1].toLowerCase().includes(m.provider === 'azure' ? 'azure' : 'openrouter')]).toEqual([m.model, true]);
      if (m.complied >= 0) expect([m.model, cells[2].startsWith(`${m.complied} of ${m.of}`)]).toEqual([m.model, true]);
      if (m.echoed !== null) expect([m.model, cells[3]]).toEqual([m.model, `${m.echoed} of ${m.of}`]);
    }
  });
});
