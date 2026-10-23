/**
 * Cost, 2026-10-23: the same three research jobs cost $0.14 on gpt-6-luna and $2.08-2.62 on gpt-6.1-sol. Robert:
 * "Let's use Luna." Work nobody waits on runs on MWA_BACKGROUND_MODEL; a chat keeps the usual model.
 * BL-73: the background model is the worker and the usual strong model stays the boss it escalates to
 * ("a solid citizen … it can have a coworker or a boss that can review the work").
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getProvider, backgroundCalls, backgroundWorker } from '../src/provider.js';
import { RoutedProvider } from '../src/model-router.js';

const ok = (body: Record<string, unknown>) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const DONE = { choices: [{ finish_reason: 'stop', message: { content: 'Done.' } }], usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0001 } };

describe('background model', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  const record = () => {
    const calls: { model: string; effort?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
      const b = JSON.parse(init.body);
      calls.push({ model: b.model, effort: b.reasoning_effort });
      return ok(DONE);
    }));
    return calls;
  };

  it('with MWA_BACKGROUND_BOSS=on, starts background calls on MWA_BACKGROUND_MODEL and escalates them to the usual model', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'k');
    vi.stubEnv('MWA_BACKGROUND_BOSS', 'on');
    vi.stubEnv('MWA_MODEL', 'openrouter:openai/gpt-6.1-sol');
    vi.stubEnv('MWA_BACKGROUND_MODEL', 'openrouter:openai/gpt-6-luna');
    const calls = record();
    const router = new RoutedProvider(getProvider('brain'), getProvider('high'));
    const go = () => router.chat({ messages: [{ role: 'user', content: 'go' }] });
    expect(backgroundWorker()).toBe(false); // not inside background work
    await go();
    await backgroundCalls.run(true, async () => {
      expect(backgroundWorker()).toBe(true);
      expect(router.model).toBe('openai/gpt-6-luna');
      await go();
      router.escalate();
      await go();
    });
    await go(); // still the strong tier, back in a chat
    expect(calls.map((c) => c.model)).toEqual(['openai/gpt-6.1-sol', 'openai/gpt-6-luna', 'openai/gpt-6.1-sol', 'openai/gpt-6.1-sol']);
    expect(router.model).toBe('openai/gpt-6.1-sol');
  }, 30_000);

  it('runs the background worker at high effort unless MWA_BACKGROUND_EFFORT says otherwise', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'k');
    vi.stubEnv('MWA_MODEL', 'openrouter:openai/gpt-6.1-sol');
    vi.stubEnv('MWA_BACKGROUND_MODEL', 'openrouter:openai/gpt-6-luna');
    const calls = record();
    const router = new RoutedProvider(getProvider('brain'), getProvider('high'));
    await backgroundCalls.run(true, () => router.chat({ messages: [{ role: 'user', content: 'go' }] }));
    vi.stubEnv('MWA_BACKGROUND_EFFORT', 'low');
    await backgroundCalls.run(true, () => router.chat({ messages: [{ role: 'user', content: 'go' }] }));
    await router.chat({ messages: [{ role: 'user', content: 'go' }] }); // a chat keeps the tier's own effort
    expect(calls.map((c) => c.effort)).toEqual(['high', 'low', 'minimal']);
  }, 30_000);

  it('by default (no boss) keeps both tiers on the background model', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'k');
    vi.stubEnv('MWA_MODEL', 'openrouter:openai/gpt-6.1-sol');
    vi.stubEnv('MWA_BACKGROUND_MODEL', 'openrouter:openai/gpt-6-luna');
    const calls = record();
    const router = new RoutedProvider(getProvider('brain'), getProvider('high'));
    await backgroundCalls.run(true, async () => {
      expect(backgroundWorker()).toBe(false);
      router.escalate();
      await router.chat({ messages: [{ role: 'user', content: 'go' }] });
    });
    expect(calls.map((c) => c.model)).toEqual(['openai/gpt-6-luna']);
  }, 30_000);

  it('changes nothing when unset', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'k');
    vi.stubEnv('MWA_MODEL', 'openrouter:openai/gpt-6.1-sol');
    vi.stubEnv('MWA_BACKGROUND_MODEL', '');
    expect(backgroundCalls.run(true, () => getProvider('brain').model)).toBe('openai/gpt-6.1-sol');
    expect(backgroundCalls.run(true, () => backgroundWorker())).toBe(false);
  });
});
