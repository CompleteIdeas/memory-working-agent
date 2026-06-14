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

export type ProviderRole = 'brain' | 'high';

/**
 * Resolve a provider for a benchmark role.
 *  - brain: Azure gpt-5-4-mini (reasoning model, native tools); Haiku fallback if Azure absent.
 *  - high:  Anthropic Sonnet 4.6 (the emergency ceiling).
 */
export function getProvider(role: ProviderRole): Provider {
  loadEnv();
  if (role === 'high') {
    return new AnthropicProvider('claude-sonnet-4-6', [3, 15], new Anthropic({ apiKey: requireKey('ANTHROPIC_API_KEY'), maxRetries: 4 }));
  }
  // role === 'brain'
  const azBase = process.env.AZURE_GPT_BASE_URL;
  const azKey = process.env.AZURE_GPT_API_KEY;
  const azDep = process.env.AZURE_GPT_DEPLOYMENT ?? 'gpt-5-4-mini';
  if (azBase && azKey) {
    return new AzureGptProvider(azDep, [0.75, 4.5], azBase, azKey);
  }
  return new AnthropicProvider(
    'claude-haiku-4-5-20251001',
    [1, 5],
    new Anthropic({ apiKey: requireKey('ANTHROPIC_API_KEY'), maxRetries: 4 }),
    ' (brain-fallback)',
  );
}

function requireKey(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}
