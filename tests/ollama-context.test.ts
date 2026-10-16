/**
 * BL-20 — Ollama's OpenAI-compatible endpoint can't set the context size, so it silently cut MWA's
 * prompts to a few thousand tokens. The ollama: provider now uses the native /api/chat: num_ctx sized
 * from the prompt and shared per model, `truncate: false` so Ollama refuses instead of cutting (MWA
 * resizes once or says why), room for thinking models, and plain errors when it can't work.
 * The fake server below answers in Ollama 0.40.2's real shapes (probed 2026-10-16).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { resolveProvider, OllamaProvider, ollamaHost, OLLAMA_CTX_FLOOR } from '../src/provider.js';
import { testProvider } from '../src/wizard.js';

let server: Server; let base = '';
const models: Record<string, { limit: number | null; thinking?: boolean; promptTokens?: number; replies?: any[] }> = {};
const seen: { model: string; num_ctx: number; num_predict: number; truncate: unknown }[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const m = models[body.model] ?? { limit: 32768 };
      const json = (status: number, v: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
      if (req.url === '/api/show') return json(200, { model_info: m.limit === null ? {} : { 'llama.context_length': m.limit }, capabilities: ['completion', 'tools', ...(m.thinking ? ['thinking'] : [])] });
      if (req.url === '/v1/chat/completions') return json(200, { choices: [{ message: { content: 'ok' } }] });
      if (req.url === '/api/chat') {
        seen.push({ model: body.model, num_ctx: body.options.num_ctx, num_predict: body.options.num_predict, truncate: body.truncate });
        const tokens = m.promptTokens ?? 1000;
        if (body.truncate === false && tokens > body.options.num_ctx) {
          const inner = { error: { code: 400, message: `request (${tokens} tokens) exceeds the available context size (${body.options.num_ctx} tokens), try increasing it`, type: 'exceed_context_size_error', n_prompt_tokens: tokens, n_ctx: body.options.num_ctx } };
          return json(400, { error: JSON.stringify(inner) });
        }
        const reply = m.replies?.shift() ?? { message: { role: 'assistant', content: 'All done.', tool_calls: [{ function: { name: 'read', arguments: { path: 'a.txt' } } }] }, done_reason: 'stop' };
        return json(200, { ...reply, prompt_eval_count: tokens, eval_count: 56 });
      }
      res.writeHead(404); res.end('404 page not found');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());
beforeEach(() => { seen.length = 0; delete process.env.MWA_OLLAMA_NUM_CTX; delete process.env.MWA_OLLAMA_MAX_NUM_CTX; });

const big = (chars: number) => [{ role: 'user' as const, content: 'x'.repeat(chars) }];
const make = (model: string, cfg: (typeof models)[string]) => { models[model] = cfg; return new OllamaProvider(model, [0, 0], base); };

describe('the ollama: provider', () => {
  it('uses the native API, whatever OLLAMA_BASE_URL says', () => {
    expect([ollamaHost('http://localhost:11434/v1'), ollamaHost('http://h:11434/v1/'), ollamaHost('http://h:11434/api'), ollamaHost('http://h:11434/v1?x=1'), ollamaHost('http://h:11434')])
      .toEqual(['http://localhost:11434', 'http://h:11434', 'http://h:11434', 'http://h:11434', 'http://h:11434']);
    const saved = process.env.OLLAMA_BASE_URL;
    try { process.env.OLLAMA_BASE_URL = `${base}/v1`; expect(resolveProvider('ollama:llama3')).toBeInstanceOf(OllamaProvider); }
    finally { if (saved === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = saved; }
  });

  it('asks Ollama not to truncate, sizes the context for the prompt, and maps tool calls and usage', async () => {
    const p = make('plain', { limit: 131072, promptTokens: 11000 });
    const out = await p.chat({ system: 'You are MWA.', messages: big(27_000), maxTokens: 500, tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } }] });
    expect(seen).toEqual([{ model: 'plain', num_ctx: OLLAMA_CTX_FLOOR, num_predict: 500, truncate: false }]);
    expect(out).toEqual({ text: 'All done.', toolCalls: [{ name: 'read', args: { path: 'a.txt' } }], usage: { input: 11000, output: 56 } });
  });

  it('when the real prompt is bigger than estimated, Ollama refuses, and MWA resizes once and retries', async () => {
    const p = make('dense', { limit: 131072, promptTokens: 20000 });
    await p.chat({ messages: big(1_000), maxTokens: 500 });
    // 20,000 real tokens + 500 reply + 256 margin = 20,756: the next 8k step is 24,576.
    expect(seen.map((s) => s.num_ctx)).toEqual([OLLAMA_CTX_FLOOR, 24576]);
  });

  it('one context size per model, shared by every provider, that only grows (a change reloads the model)', async () => {
    models.shared = { limit: 131072 };
    const brain = new OllamaProvider('shared', [0, 0], base);
    const worker = new OllamaProvider('shared', [0, 0], base);
    await brain.chat({ messages: big(1_000) });
    await brain.chat({ messages: big(50_000) });
    await worker.chat({ messages: big(1_000) });
    expect(seen.map((s) => s.num_ctx)).toEqual([OLLAMA_CTX_FLOOR, 24576, 24576]);
  });

  it('a prompt that can’t fit the model, the ceiling, or a fixed size is refused with the real numbers, never cut', async () => {
    await expect(make('tiny', { limit: 8192, promptTokens: 12000 }).chat({ messages: big(30_000) }))
      .rejects.toThrow(/this prompt is 12000 tokens and needs about \d+ with its reply, but tiny holds at most 8192/);
    // A short prompt still runs on that model, at the model's own size.
    models.tiny.promptTokens = 900; seen.length = 0;
    await new OllamaProvider('tiny', [0, 0], base).chat({ messages: big(1_000) });
    expect(seen.map((s) => s.num_ctx)).toEqual([8192]);
    process.env.MWA_OLLAMA_MAX_NUM_CTX = '12000';
    await expect(make('ceiling', { limit: 131072, promptTokens: 15000 }).chat({ messages: big(1_000) })).rejects.toThrow(/MWA_OLLAMA_MAX_NUM_CTX is 12000/);
    delete process.env.MWA_OLLAMA_MAX_NUM_CTX; process.env.MWA_OLLAMA_NUM_CTX = '8000';
    await expect(make('fixed', { limit: 131072, promptTokens: 9000 }).chat({ messages: big(100) })).rejects.toThrow(/MWA_OLLAMA_NUM_CTX is 8000/);
  });

  it('a thinking model gets room to think (none at minimal effort); one that thinks without answering is asked again with more room', async () => {
    const p = make('thinker', { limit: 131072, thinking: true, replies: [
      { message: { role: 'assistant', content: '', thinking: 'Let me consider…' }, done_reason: 'length' },
      { message: { role: 'assistant', content: 'The answer.', thinking: '…' }, done_reason: 'stop' },
    ] });
    expect((await p.chat({ messages: big(100), maxTokens: 500 })).text).toBe('The answer.');
    expect(seen.map((s) => s.num_predict)).toEqual([4500, 9000]);
    seen.length = 0;
    await p.chat({ messages: big(100), maxTokens: 500, reasoningEffort: 'minimal' });
    expect(seen.map((s) => s.num_predict)).toEqual([500]);
    models.thinker.replies = Array.from({ length: 3 }, () => ({ message: { role: 'assistant', content: '', thinking: '…' }, done_reason: 'length' }));
    await expect(p.chat({ messages: big(100), maxTokens: 500 })).rejects.toThrow(/used its whole reply budget \(18000 tokens\) thinking without answering/);
  });

  it('says plainly when nothing is listening, when the server isn’t Ollama, and passes Ollama’s own errors through', async () => {
    // A port that was just freed: nothing listens there.
    const gone = createServer(); await new Promise<void>((r) => gone.listen(0, '127.0.0.1', r));
    const freePort = (gone.address() as { port: number }).port; await new Promise((r) => gone.close(r));
    const started = Date.now();
    await expect(new OllamaProvider('m', [0, 0], `http://127.0.0.1:${freePort}`).chat({ messages: big(10) })).rejects.toThrow(/nothing is answering at .* — is Ollama running\?/);
    expect(Date.now() - started).toBeLessThan(8000); // no retry loop
    const notOllama = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(404); res.end('Not Found'); }); });
    await new Promise<void>((r) => notOllama.listen(0, '127.0.0.1', r));
    try {
      const p = new OllamaProvider('m', [0, 0], `http://127.0.0.1:${(notOllama.address() as { port: number }).port}`);
      await expect(p.chat({ messages: big(10) })).rejects.toThrow(/isn't Ollama.*openai:<model> with OPENAI_BASE_URL/);
    } finally { notOllama.close(); }
    models.gone = { limit: 4096, replies: [{ error: 'model is unloading' }] };
    await expect(new OllamaProvider('gone', [0, 0], base).chat({ messages: big(10) })).rejects.toThrow(/answered without a message: model is unloading/);
  }, 20_000); // Windows takes about 2 s to refuse each connection

  it('setup checks a local model’s context: too small is refused, small is noted', async () => {
    models['setup-small'] = { limit: 8192 }; models['setup-mid'] = { limit: 20000 }; models['setup-big'] = { limit: 131072 };
    expect(await testProvider('ollama', 'setup-small', undefined, `${base}/v1`)).toEqual({ ok: false, message: expect.stringMatching(/holds at most 8192 tokens.*needs at least 16384/) });
    expect(await testProvider('ollama', 'setup-mid', undefined, `${base}/v1`)).toEqual({ ok: true, message: expect.stringMatching(/holds 20000 tokens of context, enough for short tasks/) });
    expect((await testProvider('ollama', 'setup-big', undefined, `${base}/v1`)).ok).toBe(true);
  });
});
