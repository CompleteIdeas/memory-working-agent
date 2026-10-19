/**
 * BL-57 — a model that spends its whole output budget thinking. Claude Haiku 5.5 through OpenRouter returned
 * finish_reason "length", no text, no tool call, 800 reasoning tokens: MWA's runs on it ended "no tool calls".
 * The provider learns it from that reply, retries once with headroom, and keeps the headroom for that model.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveProvider } from '../src/provider.js';

const reply = (body: Record<string, unknown>) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const THOUGHT_ONLY = { choices: [{ finish_reason: 'length', message: { content: '' } }], usage: { prompt_tokens: 600, completion_tokens: 800 } };
const DONE = { choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ function: { name: 'done', arguments: JSON.stringify({ summary: 'Plan sent.' }) } }] } }], usage: { prompt_tokens: 600, completion_tokens: 900 } };

describe('a model that thinks past the output limit', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it('is retried once with headroom, counted for both, and given headroom from then on', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    const sent: number[] = [];
    const answers = [THOUGHT_ONLY, DONE, DONE];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => { sent.push(JSON.parse(init.body).max_tokens); return reply(answers.shift()!); }));
    const p = resolveProvider('openrouter:anthropic/claude-haiku-5.5');
    const tools = [{ name: 'done', description: 'finish', parameters: { type: 'object', properties: { summary: { type: 'string' } } } }];
    const out = await p.chat({ system: 's', messages: [{ role: 'user', content: 'go' }], maxTokens: 800, tools });
    expect(out.toolCalls?.[0]).toEqual({ name: 'done', args: { summary: 'Plan sent.' } });
    expect(out.usage).toEqual({ input: 1200, output: 1700 });
    await p.chat({ system: 's', messages: [{ role: 'user', content: 'again' }], maxTokens: 800, tools });
    expect(sent).toEqual([800, 4800, 4800]);
  }, 30_000);
  it('a short reply cut off with text is returned as it is — that is not thinking', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    const sent: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => { sent.push(JSON.parse(init.body).max_tokens); return reply({ choices: [{ finish_reason: 'length', message: { content: 'A long answer that ran out of room' } }], usage: { prompt_tokens: 1, completion_tokens: 800 } }); }));
    const out = await resolveProvider('openrouter:anthropic/claude-sonnet-5.5').chat({ system: 's', messages: [{ role: 'user', content: 'go' }], maxTokens: 800 });
    expect(out.text).toBe('A long answer that ran out of room');
    expect(sent).toEqual([800]);
  }, 30_000);
});
