/**
 * Letting the model see the page (Robert, 2026-10-25: "they need to be able to sort of see"). A message's content may
 * carry image parts; each provider maps them to its own shape, or drops them with a note when the model cannot see;
 * a tool may return an image, which the agent shows to the model on the next step only.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supportsImages, textOnly, openAiContent, anthropicContent, ollamaContent, resolveProvider } from '../src/provider.js';

const IMG = { type: 'image' as const, mime: 'image/jpeg' as const, data: 'AAAA' };
const PARTS = [{ type: 'text' as const, text: 'What does the notice say?' }, IMG];

describe('content parts', () => {
  it('knows which models take images', () => {
    for (const m of ['openai/gpt-6.1-sol', 'anthropic/claude-sonnet-5.5', 'google/gemini-3.8-flash', 'muse-glimmer-30b']) expect([m, supportsImages(m)]).toEqual([m, true]);
    for (const m of ['openai/gpt-6-luna', 'deepseek/deepseek-v4', 'llama3.1:8b']) expect([m, supportsImages(m)]).toEqual([m, false]);
  });
  it('maps parts per provider, and drops the image with a note where it cannot be seen', () => {
    expect(openAiContent('plain')).toBe('plain');
    expect(openAiContent(PARTS)).toEqual([{ type: 'text', text: 'What does the notice say?' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }]);
    expect(anthropicContent(PARTS)).toEqual([{ type: 'text', text: 'What does the notice say?' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }]);
    expect(ollamaContent(PARTS)).toEqual({ content: 'What does the notice say?', images: ['AAAA'] });
    expect(textOnly(PARTS)).toMatch(/What does the notice say\?\n\(a screenshot was attached, but this model cannot see images/);
    expect(textOnly('plain')).toBe('plain');
  });
});

describe('an OpenAI-style provider', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  const reply = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'It says accept.' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  it('sends image parts to a model that sees, and text with a note to one that does not', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    const bodies: { messages: { content: unknown }[] }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => { bodies.push(JSON.parse(init.body)); return reply(); }));
    await resolveProvider('openrouter:openai/gpt-6.1-sol').chat({ system: 's', messages: [{ role: 'user', content: PARTS }], maxTokens: 100 });
    await resolveProvider('openrouter:openai/gpt-6-luna').chat({ system: 's', messages: [{ role: 'user', content: PARTS }], maxTokens: 100 });
    expect(bodies[0].messages[1].content).toEqual(openAiContent(PARTS));
    expect(bodies[1].messages[1].content).toMatch(/cannot see images/);
  }, 30_000);
});

describe('in the loop', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it('a tool\'s image reaches the model on the next step only, and the tool is told which model runs', async () => {
    const { runAgent } = await import('../src/agent.js');
    const dir = mkdtempSync(join(tmpdir(), 'mwa-vision-'));
    vi.stubEnv('MWA_FAST_CHAT', '0');
    const seenModel: string[] = []; const contents: unknown[] = [];
    const tools = { defs: () => [{ name: 'browser_look', description: 'x', parameters: { type: 'object', properties: {} } }], has: (n: string) => n === 'browser_look',
      callDetailed: async (_n: string, _a: unknown, ctx: { brainModel?: string }) => { seenModel.push(String(ctx.brainModel)); return { text: '(looking at the page)', failed: false, image: { mime: 'image/jpeg', data: 'AAAA' } }; }, call: async () => 'ok' } as never;
    let step = 0;
    const brain = { id: 'b', model: 'openai/gpt-6.1-sol', price: [0, 0] as [number, number], chat: async (input: { system?: string; messages: { content: unknown }[] }) => {
      if (!String(input.system ?? '').includes('TRUST BOUNDARY')) return { text: '{}', usage: { input: 1, output: 1 } };
      contents.push(input.messages[0].content); step++;
      return { text: JSON.stringify(step === 1 ? { action: 'browser_look' } : { action: 'done', summary: 'The notice asks to accept cookies; nothing else is on the page.' }), usage: { input: 1, output: 1 } };
    } };
    try {
      const r = await runAgent({ instruction: 'What does the notice on the open page say?', dir, memory: { enabled: false, async recall() { return []; }, async listPolicies() { return []; }, setSessionId() { /* */ }, async addScheduledTask() { return null; }, async logAction() { return null; } } as never, brain: brain as never, worker: brain as never, tools, interactive: true, plan: false, budget: { maxSteps: 5, maxWallMs: 30_000 } } as never);
      expect(r.reason).toBe('done');
      expect(seenModel).toEqual(['openai/gpt-6.1-sol']);
      expect(typeof contents[0]).toBe('string'); // step 1: text only
      const second = contents[1] as { type: string; mime?: string; data?: string }[];
      expect(Array.isArray(second)).toBe(true);
      expect(second.find((p) => p.type === 'image')).toEqual({ type: 'image', mime: 'image/jpeg', data: 'AAAA' });
      expect(second.some((p) => p.type === 'text' && /SCREENSHOT of the open page/.test(String((p as { text?: string }).text)))).toBe(true);
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
