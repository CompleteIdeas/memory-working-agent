/**
 * Cost (2026-10-23): OpenAI first, flex for background calls, and pages trimmed to what matters to the task.
 */
import { describe, it, expect } from 'vitest';
import { openRouterRouting, backgroundCalls, US_OPENROUTER_HOSTS } from '../src/provider.js';
import { trimPage, PAGE_TOOLS } from '../src/trim.js';

describe('routing', () => {
  it('sends an OpenAI model to OpenAI first, and a background call to flex first', () => {
    expect(openRouterRouting({}, 'openai/gpt-6.1-sol', false)).toMatchObject({ only: US_OPENROUTER_HOSTS, order: ['openai'], allow_fallbacks: false });
    expect(openRouterRouting({}, 'openai/gpt-6.1-sol', true).order).toEqual(['openai/flex', 'openai']);
    expect(backgroundCalls.run(true, () => openRouterRouting({}, 'openai/gpt-6.1-sol').order)).toEqual(['openai/flex', 'openai']);
    expect(openRouterRouting({ MWA_OPENROUTER_FLEX: 'off' }, 'openai/gpt-6.1-sol', true).order).toEqual(['openai']);
    expect(openRouterRouting({ MWA_OPENROUTER_FLEX: 'all' }, 'openai/gpt-6.1-sol', false).order).toEqual(['openai/flex', 'openai']);
  });
  it('leaves other models and a host list without OpenAI alone', () => {
    expect(openRouterRouting({}, 'anthropic/claude-haiku-5.5', true).order).toBeUndefined();
    expect(openRouterRouting({ MWA_OPENROUTER_PROVIDERS: 'azure/us' }, 'openai/gpt-6.1-sol', true).order).toBeUndefined();
    expect(openRouterRouting({})).toEqual({ data_collection: 'deny', only: US_OPENROUTER_HOSTS, allow_fallbacks: false });
  });
});

describe('trimPage', () => {
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `Paragraph ${i} talks about cookie banners, site navigation and newsletter sign-up forms for the website footer.`).join('\n\n');
  it('keeps the opening and the passages about the task, in order, under the cap', () => {
    const page = ['AI Weekly — October 2026', filler(20), 'Anthropic released a new agent memory feature that lets nonprofits keep volunteer schedules.', filler(20), 'OpenAI shipped flex pricing for background agent jobs at half the price.', filler(20)].join('\n\n');
    const t = trimPage(page, 'AI agent news for a nonprofit: memory, pricing, background jobs', 1200);
    expect(t.trimmed).toBe(true);
    expect(t.text.length).toBeLessThan(2000);
    expect(t.text.startsWith('AI Weekly')).toBe(true);
    expect(t.text).toContain('agent memory feature');
    expect(t.text).toContain('flex pricing');
    expect(t.text.indexOf('agent memory')).toBeLessThan(t.text.indexOf('flex pricing')); // original order
    expect(t.text).toMatch(/trimmed to the parts about your task/);
  });
  it('leaves a short page alone, and can be turned off', () => {
    expect(trimPage('short page', 'x', 2500)).toEqual({ text: 'short page', trimmed: false, from: 10 });
    expect(trimPage(filler(200), 'x', 0).trimmed).toBe(false);
  });
  it('handles a page with no paragraph breaks', () => {
    const blob = 'word '.repeat(3000) + 'the volunteer schedule rules are here ' + 'word '.repeat(3000);
    const t = trimPage(blob, 'volunteer schedule', 1000);
    expect(t.trimmed).toBe(true);
    expect(t.text).toContain('volunteer schedule rules');
  });
  it('knows which tools return pages', () => {
    for (const n of ['fetch__fetch_url', 'read_document', 'http_request', 'browser_open']) expect(PAGE_TOOLS.test(n)).toBe(true);
    expect(PAGE_TOOLS.test('read_file')).toBe(false);
  });
});
