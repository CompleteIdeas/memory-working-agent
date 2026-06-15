/**
 * Provider abstraction — NATIVE function-calling (verified 2026-06-13):
 *  - azure-gpt: gpt-5-4-mini via chat/completions — POST {base}/chat/completions,
 *    `api-key` header, body {model, messages, max_completion_tokens, tools, tool_choice}.
 *    Returns structured tool_calls (no fragile free-text JSON parsing). gpt-5.x is a
 *    reasoning model; reasoning is intrinsic to the deployment.
 *  - anthropic: @anthropic-ai/sdk messages.create with tools (tool_use blocks).
 *
 * The brain drives the loop with NATIVE TOOLS (USEA's proven design): the model
 * returns validated tool calls, not hand-parsed JSON. A text fallback in brain.ts
 * covers providers/models that don't emit tool_calls.
 */
import Anthropic from '@anthropic-ai/sdk';
import { loadEnv } from './env.js';
import { loadConfig } from './config.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A callable tool the model may invoke. `parameters` is a JSON Schema object. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ChatResult {
  text: string;
  toolCalls?: ToolCall[];
  usage: { input: number; output: number };
}

export interface ChatInput {
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  tools?: ToolDef[];
}

export interface Provider {
  id: string;
  model: string;
  price: [number, number];
  chat(input: ChatInput): Promise<ChatResult>;
}

function safeJson(s: unknown): Record<string, unknown> {
  if (typeof s !== 'string') return (s as Record<string, unknown>) ?? {};
  try { return JSON.parse(s); } catch { return {}; }
}

class AnthropicProvider implements Provider {
  readonly id: string;
  constructor(
    readonly model: string,
    readonly price: [number, number],
    private readonly client: Anthropic,
    idSuffix = '',
  ) {
    this.id = `anthropic:${model}${idSuffix}`;
  }
  async chat({ system, messages, maxTokens = 1500, tools }: ChatInput): Promise<ChatResult> {
    const r = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      ...(tools?.length
        ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })) }
        : {}),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const text = r.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('');
    const toolCalls = r.content
      .filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use')
      .map((c) => ({ name: c.name, args: (c.input ?? {}) as Record<string, unknown> }));
    return { text, toolCalls: toolCalls.length ? toolCalls : undefined, usage: { input: r.usage.input_tokens, output: r.usage.output_tokens } };
  }
}

class AzureGptProvider implements Provider {
  readonly id: string;
  constructor(
    readonly model: string,
    readonly price: [number, number],
    private readonly base: string,
    private readonly key: string,
  ) {
    this.id = `azure-gpt:${model}`;
  }
  async chat({ system, messages, maxTokens = 1500, tools }: ChatInput): Promise<ChatResult> {
    const msgs = (system ? [{ role: 'system', content: system }, ...messages] : messages).map((m) => ({ role: m.role, content: m.content }));
    const body: Record<string, unknown> = {
      model: this.model,
      messages: msgs,
      max_completion_tokens: maxTokens, // gpt-5.x rejects max_tokens
    };
    if (tools?.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = 'auto';
    }
    // Retry transient failures (429 / 5xx / network) with backoff; fail fast on 4xx.
    let lastErr = 'azure: unknown error';
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, Math.min(8000, 600 * attempt * attempt)));
      let res: Response;
      try {
        res = await fetch(`${this.base}/chat/completions`, {
          method: 'POST',
          headers: { 'api-key': this.key, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (e) {
        lastErr = `azure network: ${(e as Error).message}`;
        continue;
      }
      if (res.ok) {
        const j: any = await res.json();
        const msg = j.choices?.[0]?.message ?? {};
        const text: string = msg.content ?? '';
        const toolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length
          ? msg.tool_calls.map((tc: any) => ({ name: tc.function?.name ?? '', args: safeJson(tc.function?.arguments) }))
          : undefined;
        return { text, toolCalls, usage: { input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0 } };
      }
      lastErr = `Azure ${res.status}: ${(await res.text()).slice(0, 200)}`;
      if (res.status !== 429 && res.status < 500) break; // deterministic 4xx → don't retry
    }
    throw new Error(lastErr);
  }
}

/**
 * OpenAI-compatible chat/completions — OpenAI, OpenRouter, Gemini (compat endpoint),
 * Ollama, and any local/self-hosted server speaking the same API. Bearer auth (omitted
 * for keyless local servers like Ollama). Uses max_tokens (gpt-5.x's max_completion_tokens
 * is Azure-specific, handled by AzureGptProvider).
 */
class OpenAICompatProvider implements Provider {
  readonly id: string;
  constructor(
    readonly model: string,
    readonly price: [number, number],
    private readonly base: string,
    private readonly key: string | undefined,
    label: string,
  ) {
    this.id = `${label}:${model}`;
  }
  async chat({ system, messages, maxTokens = 1500, tools }: ChatInput): Promise<ChatResult> {
    const msgs = (system ? [{ role: 'system', content: system }, ...messages] : messages).map((m) => ({ role: m.role, content: m.content }));
    const body: Record<string, unknown> = { model: this.model, messages: msgs, max_tokens: maxTokens };
    if (tools?.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = 'auto';
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.key) headers.authorization = `Bearer ${this.key}`;
    let lastErr = `${this.id}: unknown error`;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, Math.min(8000, 600 * attempt * attempt)));
      let res: Response;
      try {
        res = await fetch(`${this.base.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
      } catch (e) { lastErr = `${this.id} network: ${(e as Error).message}`; continue; }
      if (res.ok) {
        const j: any = await res.json();
        const msg = j.choices?.[0]?.message ?? {};
        const text: string = msg.content ?? '';
        const toolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length
          ? msg.tool_calls.map((tc: any) => ({ name: tc.function?.name ?? '', args: safeJson(tc.function?.arguments) }))
          : undefined;
        return { text, toolCalls, usage: { input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0 } };
      }
      lastErr = `${this.id} ${res.status}: ${(await res.text()).slice(0, 200)}`;
      if (res.status !== 429 && res.status < 500) break;
    }
    throw new Error(lastErr);
  }
}

export type ProviderRole = 'brain' | 'high';

// Built-in OpenAI-compatible providers: default base URL + the env var holding the key.
// `keyless` (Ollama) needs no key — the biggest onboarding unlock (run a local model with
// nothing to paste). Prices are per-1M [in, out]; ollama is free/local ($0).
export const OPENAI_COMPAT: Record<string, { base: string; keyEnv?: string; baseEnv?: string; keyless?: boolean; price: [number, number] }> = {
  openai: { base: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', baseEnv: 'OPENAI_BASE_URL', price: [0.5, 1.5] },
  openrouter: { base: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', price: [0.5, 1.5] },
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY', price: [0.3, 1.0] },
  ollama: { base: 'http://localhost:11434/v1', baseEnv: 'OLLAMA_BASE_URL', keyless: true, price: [0, 0] },
};

function anthropicFor(model: string, suffix = ''): Provider {
  const price: [number, number] = /haiku/i.test(model) ? [1, 5] : [3, 15];
  return new AnthropicProvider(model, price, new Anthropic({ apiKey: requireKey('ANTHROPIC_API_KEY'), maxRetries: 4 }), suffix);
}

/**
 * Resolve a "provider:model" spec (or a bare model name, back-compat) into a Provider.
 *  anthropic: · azure: · openai: · openrouter: · gemini: · ollama:  (ollama needs no key)
 */
export function resolveProvider(spec: string): Provider {
  loadEnv();
  const i = spec.indexOf(':');
  const provider = i > 0 ? spec.slice(0, i).toLowerCase() : '';
  const model = (i > 0 ? spec.slice(i + 1) : spec).trim();

  if (provider === 'anthropic' || (!provider && /claude/i.test(model))) {
    return anthropicFor(model || 'claude-sonnet-4-6');
  }
  if (provider === 'azure' || (!provider && /^gpt-/i.test(model))) {
    const base = process.env.AZURE_GPT_BASE_URL, key = process.env.AZURE_GPT_API_KEY;
    if (base && key) return new AzureGptProvider(provider ? model : (process.env.AZURE_GPT_DEPLOYMENT ?? model), [0.75, 4.5], base, key);
    return anthropicFor('claude-haiku-4-5-20251001', ' (brain-fallback)'); // azure asked-for but unconfigured → still run
  }
  const oc = OPENAI_COMPAT[provider];
  if (oc) {
    const base = (oc.baseEnv && process.env[oc.baseEnv]) || oc.base;
    const key = oc.keyless ? undefined : requireKey(oc.keyEnv!);
    return new OpenAICompatProvider(model, oc.price, base, key, provider);
  }
  throw new Error(`Unknown model provider in "${spec}". Use anthropic:, azure:, openai:, openrouter:, gemini:, or ollama:`);
}

/** Set of provider prefixes the UI/onboarding can offer. */
export const PROVIDERS = ['anthropic', 'azure', 'openai', 'openrouter', 'gemini', 'ollama'] as const;

/**
 * Resolve the provider for a tier from mwa.config.json: `models.fetch` (cheap brain) and
 * `models.reason` (strong ceiling), each a "provider:model" spec — so the model is a
 * config value and any provider (incl. local Ollama, no key) works with no code change.
 * Falls back to whatever IS configured so the agent always runs.
 */
export function getProvider(role: ProviderRole): Provider {
  loadEnv();
  const cfg = loadConfig();
  const spec = role === 'high' ? cfg.models.reason : cfg.models.fetch;
  try {
    return resolveProvider(spec);
  } catch (e) {
    if (role === 'high' && process.env.ANTHROPIC_API_KEY) return anthropicFor('claude-sonnet-4-6');
    // Strong tier unresolved (e.g. a stale config left reason pointing at a provider whose
    // key is absent) — fall back to the cheap/fetch model so single-provider setups
    // (keyless Ollama, OpenAI-only, etc.) still escalate instead of throwing.
    if (role === 'high' && cfg.models.fetch !== spec) { try { return resolveProvider(cfg.models.fetch); } catch { /* fall through */ } }
    const base = process.env.AZURE_GPT_BASE_URL, key = process.env.AZURE_GPT_API_KEY;
    if (base && key) return new AzureGptProvider(process.env.AZURE_GPT_DEPLOYMENT ?? 'gpt-5-4-mini', [0.75, 4.5], base, key);
    if (process.env.ANTHROPIC_API_KEY) return anthropicFor('claude-haiku-4-5-20251001', ' (brain-fallback)');
    throw e;
  }
}

function requireKey(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}
