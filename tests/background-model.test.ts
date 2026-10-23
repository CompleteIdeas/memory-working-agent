/**
 * Cost, 2026-10-23: the same three research jobs cost $0.14 on gpt-6-luna and $2.08-2.62 on gpt-6.1-sol. Robert:
 * "Let's use Luna." Work nobody waits on runs on MWA_BACKGROUND_MODEL; a chat keeps the usual model.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getProvider, backgroundCalls } from '../src/provider.js';
import { RoutedProvider } from '../src/model-router.js';

const ok = (body: Record<string, unknown>) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const DONE = { choices: [{ finish_reason: 'stop', message: { content: 'Done.' } }], usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0001 } };

describe('background model', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('sends background calls to MWA_BACKGROUND_MODEL at both tiers and chats to the usual model', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'k');
    vi.stubEnv('MWA_MODEL', 'openrouter:openai/gpt-6.1-sol');
    vi.stubEnv('MWA_BACKGROUND_MODEL', 'openrouter:openai/gpt-6-luna');
    const models: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => { models.push(JSON.parse(init.body).model); return ok(DONE); }));
    const router = new RoutedProvider(getProvider('brain'), getProvider('high'));
    const go = () => router.chat({ messages: [{ role: 'user', content: 'go' }] });
    await go();
    await backgroundCalls.run(true, async () => {
      expect(router.model).toBe('openai/gpt-6-luna');
      await go();
      router.escalate();
      await go();
    });
    await go(); // still the strong tier, back in a chat
    expect(models).toEqual(['openai/gpt-6.1-sol', 'openai/gpt-6-luna', 'openai/gpt-6-luna', 'openai/gpt-6.1-sol']);
    expect(router.model).toBe('openai/gpt-6.1-sol');
  }, 30_000);

  it('changes nothing when unset', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'k');
    vi.stubEnv('MWA_MODEL', 'openrouter:openai/gpt-6.1-sol');
    vi.stubEnv('MWA_BACKGROUND_MODEL', '');
    expect(backgroundCalls.run(true, () => getProvider('brain').model)).toBe('openai/gpt-6.1-sol');
  });
});
