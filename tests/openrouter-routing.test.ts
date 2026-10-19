/**
 * BL-58 — where the data goes, and what a call cost. Robert, 2026-10-19: any model hosted through OpenRouter is
 * fine, but no data to other countries. OpenRouter routes a model to any of its hosts — some abroad, some that keep
 * or train on prompts — and MWA billed every OpenRouter model at one flat guessed rate.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveProvider, openRouterRouting } from '../src/provider.js';
import { RoutedProvider } from '../src/model-router.js';

const ok = (body: Record<string, unknown>) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const DONE = (cost?: number) => ({ choices: [{ finish_reason: 'stop', message: { content: 'Plan sent.' } }], usage: { prompt_tokens: 1000, completion_tokens: 100, ...(cost === undefined ? {} : { cost }) } });

describe('OpenRouter routing', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it('refuses hosts that keep prompts by default, and pins named hosts with no fallback when told', () => {
    expect(openRouterRouting({})).toEqual({ data_collection: 'deny' });
    expect(openRouterRouting({ MWA_OPENROUTER_PROVIDERS: 'anthropic, google-vertex/us ,amazon-bedrock/us-east-1' }))
      .toEqual({ data_collection: 'deny', only: ['anthropic', 'google-vertex/us', 'amazon-bedrock/us-east-1'], allow_fallbacks: false });
    expect(openRouterRouting({ MWA_OPENROUTER_DATA_COLLECTION: 'allow' })).toEqual({ data_collection: 'allow' });
  });
  it('every OpenRouter call carries it; other OpenAI-compatible hosts never do', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'k'); vi.stubEnv('OPENAI_API_KEY', 'k');
    vi.stubEnv('MWA_OPENROUTER_PROVIDERS', 'anthropic,google-vertex/us');
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => { bodies.push(JSON.parse(init.body)); return ok(DONE()); }));
    await resolveProvider('openrouter:anthropic/claude-haiku-5.5').chat({ messages: [{ role: 'user', content: 'go' }] });
    await resolveProvider('openai:gpt-5.6-luna').chat({ messages: [{ role: 'user', content: 'go' }] });
    expect(bodies[0].provider).toEqual({ data_collection: 'deny', only: ['anthropic', 'google-vertex/us'], allow_fallbacks: false });
    expect(bodies[1].provider).toBeUndefined();
  }, 30_000);
});

describe('what a call cost', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it('is the provider\'s own bill when it reports one, summed across a retried call, else tokens at the list price', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'k');
    const answers = [{ choices: [{ finish_reason: 'length', message: { content: '' } }], usage: { prompt_tokens: 1000, completion_tokens: 800, cost: 0.0005 } }, DONE(0.0007), DONE()];
    vi.stubGlobal('fetch', vi.fn(async () => ok(answers.shift()!)));
    const p = resolveProvider('openrouter:anthropic/claude-haiku-5.5');
    const r = new RoutedProvider(p, p);
    const first = await r.chat({ messages: [{ role: 'user', content: 'go' }] });
    expect(first.usage.cost).toBeCloseTo(0.0012, 6); // the thinking-only reply and the retry, both billed
    await r.chat({ messages: [{ role: 'user', content: 'again' }] }); // no cost reported: tokens × list price
    expect(r.spentUsd()).toBeCloseTo(0.0012 + (1000 / 1e6) * p.price[0] + (100 / 1e6) * p.price[1], 6);
  }, 30_000);
});
