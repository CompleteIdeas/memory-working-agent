/** The model that may review a connector from outside the library (src/installer/policy.ts). */
import { describe, it, expect } from 'vitest';
import { isReviewCapable } from '../src/installer/policy.js';

describe('a reviewing model', () => {
  it("MWA's own default and the strong models of each family can review", () => {
    for (const m of ['openrouter:openai/gpt-6.1-sol', 'openai:gpt-6.1-sol', 'anthropic:claude-sonnet-5-5', 'openrouter:anthropic/claude-opus-5-5', 'anthropic:claude-fable-5-1',
      'openrouter:google/gemini-3-pro', 'azure:gpt-5-4', 'openrouter:deepseek/deepseek-v4.1-flash-1017']) expect(isReviewCapable(m), m).toBe(true);
  });
  it('small tiers and small local models cannot', () => {
    for (const m of ['openrouter:openai/gpt-6-luna', 'openai:gpt-5-nano', 'azure:gpt-4.1-mini', 'anthropic:claude-haiku-5-5', 'ollama:qwen3:4b', '']) expect(isReviewCapable(m), m).toBe(false);
  });
});
