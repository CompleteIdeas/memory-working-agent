/**
 * BL-20 — Ollama's OpenAI-compatible endpoint can't set the context size, so it silently cut MWA's
 * prompts to a few thousand tokens. The ollama: provider now uses the native /api/chat with num_ctx
 * sized from the prompt, refuses what can't fit, and says when a server isn't Ollama.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { resolveProvider, OllamaProvider, ollamaHost, ollamaTokensNeeded, OLLAMA_CTX_FLOOR } from '../src/provider.js';

let server: Server; let base = '';
let limit: number | null = 32768;
let chatStatus = 200; let chatBody: unknown = null;
const seen: any[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === '/api/show') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(limit === null ? { model_info: {} } : { model_info: { 'llama.context_length': limit } }));
      }
      if (req.url === '/api/chat') {
        seen.push(body);
        res.writeHead(chatStatus, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(chatBody ?? {
          message: { role: 'assistant', content: '<think>hmm</think>All done.', tool_calls: [{ function: { name: 'read', arguments: { path: 'a.txt' } } }] },
          prompt_eval_count: 1234, eval_count: 56,
        }));
      }
      res.writeHead(404); res.end('404 page not found');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());
beforeEach(() => { seen.length = 0; limit = 32768; chatStatus = 200; chatBody = null; delete process.env.MWA_OLLAMA_NUM_CTX; delete process.env.MWA_OLLAMA_MAX_NUM_CTX; });

const big = (chars: number) => [{ role: 'user' as const, content: 'x'.repeat(chars) }];

describe('the ollama: provider', () => {
  it('uses the native API, whatever OLLAMA_BASE_URL says about /v1', () => {
    expect([ollamaHost('http://localhost:11434/v1'), ollamaHost('http://h:11434/v1/'), ollamaHost('http://h:11434')]).toEqual(['http://localhost:11434', 'http://h:11434', 'http://h:11434']);
    const saved = process.env.OLLAMA_BASE_URL;
    try { process.env.OLLAMA_BASE_URL = `${base}/v1`; expect(resolveProvider('ollama:llama3')).toBeInstanceOf(OllamaProvider); }
    finally { if (saved === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = saved; }
  });

  it('sends num_ctx sized for the whole prompt, maps tool calls and usage, and drops inline thinking', async () => {
    const p = new OllamaProvider('llama3', [0, 0], base);
    const out = await p.chat({ system: 'You are MWA.', messages: big(27_000), maxTokens: 500, tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } }] });
    const sent = seen[0];
    // 27k characters at a cautious 2.5 a token is ~10.8k, plus the reply: a 16k context, not Ollama's default.
    expect(sent.options.num_ctx).toBe(16384);
    expect(sent.options.num_ctx).toBeGreaterThanOrEqual(ollamaTokensNeeded(27_000, 500));
    expect([sent.stream, sent.tools[0].function.name, sent.messages[0].role]).toEqual([false, 'read', 'system']);
    expect(out).toEqual({ text: 'All done.', toolCalls: [{ name: 'read', args: { path: 'a.txt' } }], usage: { input: 1234, output: 56 } });
  });

  it('grows the context in steps when a prompt needs it, and never shrinks it (a change reloads the model)', async () => {
    const p = new OllamaProvider('llama3', [0, 0], base);
    await p.chat({ messages: big(1_000) });
    await p.chat({ messages: big(50_000) });
    await p.chat({ messages: big(1_000) });
    expect(seen.map((b) => b.options.num_ctx)).toEqual([OLLAMA_CTX_FLOOR, 24576, 24576]);
  });

  it('refuses a request that can’t fit the model, or the ceiling, instead of letting Ollama cut it', async () => {
    limit = 8192;
    const small = new OllamaProvider('tiny', [0, 0], base);
    await expect(small.chat({ messages: big(30_000) })).rejects.toThrow(/needs about \d+ tokens of context, but tiny holds at most 8192/);
    expect(seen).toEqual([]);
    limit = 131072; process.env.MWA_OLLAMA_MAX_NUM_CTX = '12000';
    await expect(new OllamaProvider('big', [0, 0], base).chat({ messages: big(30_000) })).rejects.toThrow(/MWA_OLLAMA_MAX_NUM_CTX is 12000/);
    // A prompt that fits uses at most the cap, even when the step above it would pass it.
    limit = 20000; delete process.env.MWA_OLLAMA_MAX_NUM_CTX;
    await new OllamaProvider('mid', [0, 0], base).chat({ messages: big(40_000) });
    expect(seen.at(-1).options.num_ctx).toBe(20000);
  });

  it('a fixed MWA_OLLAMA_NUM_CTX is used as given; an unknown model limit doesn’t stop it', async () => {
    process.env.MWA_OLLAMA_NUM_CTX = '40960';
    await new OllamaProvider('m', [0, 0], base).chat({ messages: big(100) });
    delete process.env.MWA_OLLAMA_NUM_CTX; limit = null;
    await new OllamaProvider('n', [0, 0], base).chat({ messages: big(100) });
    expect(seen.map((b) => b.options.num_ctx)).toEqual([40960, OLLAMA_CTX_FLOOR]);
  });

  it('says plainly when the server isn’t Ollama, and passes Ollama’s own errors through', async () => {
    const notOllama = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(404); res.end('Not Found'); }); });
    await new Promise<void>((r) => notOllama.listen(0, '127.0.0.1', r));
    try {
      const p = new OllamaProvider('m', [0, 0], `http://127.0.0.1:${(notOllama.address() as { port: number }).port}`);
      await expect(p.chat({ messages: big(10) })).rejects.toThrow(/isn't Ollama.*openai:<model> with OPENAI_BASE_URL/);
    } finally { notOllama.close(); }
    chatStatus = 404; chatBody = { error: "model 'nope' not found" };
    await expect(new OllamaProvider('nope', [0, 0], base).chat({ messages: big(10) })).rejects.toThrow(/404: .*model 'nope' not found/);
  });
});
