/**
 * Provider abstraction — verified wire formats (2026-06-12 real calls):
 *  - anthropic: @anthropic-ai/sdk messages.create (high-model = Sonnet)
 *  - azure-gpt: gpt-5-4-mini via the Responses API — POST {base}/responses,
 *    `api-key` header, body {model: deployment, instructions, input[], max_output_tokens}
 *
 * The brain talks to providers through chat(system, messages) -> {text, usage}.
 * No native tool-calling: the brain emits a JSON-action protocol (portable
 * across both providers, easy to verify/recover). See brain.ts.
 */
import Anthropic from '@anthropic-ai/sdk';
import { loadEnv } from './env.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  text: string;
  usage: { input: number; output: number };
}

export interface ChatInput {
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
}

export interface Provider {
  /** stable id for logging/results */
  id: string;
  /** model/deployment name */
  model: string;
  /** rough USD per 1M tokens [input, output] for cost estimates */
  price: [number, number];
  chat(input: ChatInput): Promise<ChatResult>;
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
  async chat({ system, messages, maxTokens = 1500 }: ChatInput): Promise<ChatResult> {
    const r = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const text = r.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('');
    return { text, usage: { input: r.usage.input_tokens, output: r.usage.output_tokens } };
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
  async chat({ system, messages, maxTokens = 1500 }: ChatInput): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: messages.map((m) => ({ role: m.role, content: m.content })),
      max_output_tokens: maxTokens,
    };
    if (system) body.instructions = system;
    const res = await fetch(`${this.base}/responses`, {
      method: 'POST',
      headers: { 'api-key': this.key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Azure ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const j: any = await res.json();
    const text: string =
      j.output_text ??
      (Array.isArray(j.output)
        ? j.output.flatMap((o: any) => (o.content ?? []).map((c: any) => c.text ?? '')).join('')
        : '');
    return {
      text,
      usage: { input: j.usage?.input_tokens ?? 0, output: j.usage?.output_tokens ?? 0 },
    };
  }
}

export type ProviderRole = 'brain' | 'high';

/**
 * Resolve a provider for a benchmark role.
 *  - brain: Azure gpt-5-4-mini; falls back to Anthropic Haiku if Azure key absent.
 *  - high:  Anthropic Sonnet 4.6 (the frontier ceiling).
 */
export function getProvider(role: ProviderRole): Provider {
  loadEnv();
  if (role === 'high') {
    return new AnthropicProvider('claude-sonnet-4-6', [3, 15], new Anthropic({ apiKey: requireKey('ANTHROPIC_API_KEY') }));
  }
  // role === 'brain'
  const azBase = process.env.AZURE_GPT_BASE_URL;
  const azKey = process.env.AZURE_GPT_API_KEY;
  const azDep = process.env.AZURE_GPT_DEPLOYMENT ?? 'gpt-5-4-mini';
  if (azBase && azKey) {
    return new AzureGptProvider(azDep, [0.75, 4.5], azBase, azKey);
  }
  // fallback: Haiku as the cheap brain (noted in results)
  return new AnthropicProvider(
    'claude-haiku-4-5-20251001',
    [1, 5],
    new Anthropic({ apiKey: requireKey('ANTHROPIC_API_KEY') }),
    ' (brain-fallback)',
  );
}

function requireKey(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}
