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
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadEnv } from './env.js';
import { loadConfig } from './config.js';
import { runLogPath } from './paths.js';

/** A part of a message: text, or an image the model is to look at (the agent browser's `browser_look`, 2026-10-26). */
export type ContentPart = { type: 'text'; text: string } | { type: 'image'; mime: 'image/jpeg' | 'image/png'; data: string };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentPart[];
}

/** Whether a model takes images. A list, not a probe: the provider's model index is not consulted per call. */
export function supportsImages(model: string): boolean {
  if (/luna|mini-text|-text\b|deepseek|llama-?3\.[0-1]\b/i.test(model)) return false; // the cheap text-only tiers
  return /gpt-6|gpt-5|gpt-4o|gpt-4\.1|o[1-9]\b|claude|gemini|pixtral|llava|qwen[^/]*-?vl|vision|muse-glimmer|gemma-?[3-9]/i.test(model);
}
/** The text of a message's content, with a note where an image was dropped. */
export function textOnly(c: string | ContentPart[]): string {
  if (typeof c === 'string') return c;
  const text = c.filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('\n');
  return c.some((p) => p.type === 'image') ? `${text}\n(a screenshot was attached, but this model cannot see images — read the page as text instead)` : text;
}
/** OpenAI-style content: a string, or text and image_url parts (data URLs). */
export function openAiContent(c: string | ContentPart[]): string | { type: string; text?: string; image_url?: { url: string } }[] {
  if (typeof c === 'string') return c;
  return c.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } }));
}
/** Anthropic content: a string, or text and base64 image blocks. */
export function anthropicContent(c: string | ContentPart[]): string | Record<string, unknown>[] {
  if (typeof c === 'string') return c;
  return c.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }));
}
/** Ollama's native shape: text content plus an `images` list of base64 strings. */
export function ollamaContent(c: string | ContentPart[]): { content: string; images?: string[] } {
  if (typeof c === 'string') return { content: c };
  const images = c.filter((p): p is Extract<ContentPart, { type: 'image' }> => p.type === 'image').map((p) => p.data);
  return { content: c.filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('\n'), ...(images.length ? { images } : {}) };
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
  /** `cacheRead`/`cacheWrite` are 0 on providers without explicit prompt caching. They are
   *  reported rather than folded into `input` so a caller can SEE whether caching is working —
   *  a cache that silently misses looks exactly like no caching at all. */
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost?: number };
}
// `usage.cost` (USD) is the provider's own bill for the call when it reports one — OpenRouter does, per call,
// at the endpoint that served it (BL-58: MWA's flat OpenRouter rate was wrong for every model).

export interface ChatInput {
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  tools?: ToolDef[];
  /** Engage the model's reasoning (hidden thinking → concise answer). Each provider applies
   *  it only to models that support it (gpt-5.x reasoning_effort, Claude thinking); ignored
   *  otherwise. The router sets this per tier: strong tier = high, cheap tier = minimal. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /**
   * Mark the run-stable prefix (tools + system) as cacheable.
   *
   * An agent loop re-sends the same system prompt and the same tool definitions on every
   * step — in MWA's case roughly 1,200 tokens of AGENT_SYSTEM plus a dozen tool schemas,
   * up to 40 times per run. Caching is only possible when that prefix is BYTE-IDENTICAL
   * across calls, which is why `runAgent` moves every loop-invariant section (instruction,
   * working dir, standing preferences, domain pack) into `system` and leaves only the
   * volatile tail in the user message.
   *
   * Providers differ: Anthropic needs an explicit `cache_control` breakpoint (set here),
   * while OpenAI-compatible endpoints cache long prefixes automatically and ignore this.
   * Either way the caller does not have to know which.
   */
  cache?: boolean;
}

export interface Provider {
  id: string;
  model: string;
  price: [number, number];
  chat(input: ChatInput): Promise<ChatResult>;
}

/**
 * BL-58: OpenRouter's provider preferences for every call. Hosts that keep or train on prompts are refused
 * (`data_collection: deny`) unless MWA_OPENROUTER_DATA_COLLECTION=allow; MWA_OPENROUTER_PROVIDERS, a comma list of
 * OpenRouter provider tags ("anthropic,google-vertex/us,amazon-bedrock/us-east-1"), limits calls to those hosts and
 * turns off fallback to others, so a deployment can keep its data in one country.
 */
/** BL-61: where OpenRouter may send a call when nobody says otherwise — first-party US labs and US-region hosts.
 *  BL-73: and US companies serving open-weight models from US data centers, so a model such as DeepSeek V4.1 Flash
 *  can be the background worker while chats stay on OpenAI — never its maker's own endpoint (deepseek, alibaba,
 *  minimax, z-ai) or a host outside the US. DeepInfra and Crusoe by their 8-bit endpoints, not the 4-bit ones. */
export const US_OPENROUTER_HOSTS = ['openai', 'anthropic', 'google-vertex/us', 'azure/us', 'amazon-bedrock/us-east-1', 'amazon-bedrock/us-east-2', 'amazon-bedrock/us-west-2',
  'deepinfra/fp8', 'deepinfra/bf16', 'together', 'fireworks', 'baseten', 'crusoe/fp8', 'parasail/fp8', 'inference-net/us'];

/**
 * Cost (2026-10-23): calls nobody waits on — a scheduled job, a hand-off, thinking time — run inside this, and an
 * OpenAI model is then asked for OpenAI's "flex" tier first: the same model at half price, slower and sometimes
 * turned away under load (then the standard tier answers). Measured through OpenRouter: the same reply cost
 * $0.000034 on flex against $0.000068. MWA_OPENROUTER_FLEX: `background` (default), `all`, or `off`.
 */
export const backgroundCalls = new AsyncLocalStorage<boolean>();

/** Which run a model call belongs to, for the token log (set by runAgent). */
export const callTags = new AsyncLocalStorage<{ session?: string; job?: string; run?: string }>();

/**
 * Cost (2026-10-23): one line per model call in tokens.jsonl beside the run log (MWA_TOKEN_LOG; "0" turns it off):
 * which run, which host and tier answered, input / cached / output / reasoning tokens, the real cost, and how big the
 * system prompt and the messages were — so a long job's spend can be taken apart instead of guessed at.
 */
function logCall(rec: Record<string, unknown>): void {
  if (process.env.MWA_TOKEN_LOG === '0' || process.env.VITEST) return;
  try {
    const p = process.env.MWA_TOKEN_LOG ?? join(dirname(runLogPath()), 'tokens.jsonl');
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify({ ts: Date.now(), bg: backgroundCalls.getStore() === true, ...callTags.getStore(), ...rec }) + '\n');
  } catch { /* best effort */ }
}

export function openRouterRouting(env: NodeJS.ProcessEnv = process.env, model = '', background = backgroundCalls.getStore() === true): Record<string, unknown> {
  // US hosts by default (Robert: no data to other countries); MWA_OPENROUTER_PROVIDERS names others, "any" lifts it.
  const named = String(env.MWA_OPENROUTER_PROVIDERS ?? '').trim();
  const only = named.toLowerCase() === 'any' ? [] : named ? named.split(',').map((s) => s.trim()).filter(Boolean) : US_OPENROUTER_HOSTS;
  // An OpenAI model goes to OpenAI first: Bedrock and Azure US charge 10% more for the same model ($2.20 / $11 against
  // $2 / $10 for gpt-6.1-sol), and a call could land there. Only when OpenAI is an allowed host.
  const flexMode = String(env.MWA_OPENROUTER_FLEX ?? 'background').toLowerCase();
  const openaiFirst = /^openai\//i.test(model) && (!only.length || only.includes('openai'));
  const flex = openaiFirst && (flexMode === 'all' || (flexMode === 'background' && background));
  return {
    data_collection: env.MWA_OPENROUTER_DATA_COLLECTION === 'allow' ? 'allow' : 'deny',
    ...(only.length ? { only, allow_fallbacks: false } : {}),
    ...(openaiFirst ? { order: flex ? ['openai/flex', 'openai'] : ['openai'] } : {}),
  };
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
  async chat({ system, messages, maxTokens = 1500, tools, reasoningEffort, cache }: ChatInput): Promise<ChatResult> {
    // Extended thinking on reasoning-capable Claude models (hidden thinking blocks; the
    // visible text stays concise). budget must be < max_tokens, so add headroom.
    const canThink = /claude-(opus|sonnet)/i.test(this.model);
    const budget = canThink && reasoningEffort && reasoningEffort !== 'minimal'
      ? ({ low: 1024, medium: 2000, high: 3200 } as const)[reasoningEffort] : 0;
    const r = await this.client.messages.create({
      model: this.model,
      max_tokens: budget ? maxTokens + budget : maxTokens,
      ...(budget ? { thinking: { type: 'enabled', budget_tokens: budget } } as any : {}),
      // One breakpoint, on the system block. The request is serialized tools-then-system-then-
      // messages, so a breakpoint here covers BOTH the tool schemas and the system prompt —
      // the whole run-stable prefix — without needing a second marker on the last tool.
      ...(system
        ? { system: cache
            ? [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }]
            : system }
        : {}),
      ...(tools?.length
        ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })) }
        : {}),
      messages: messages.map((m) => ({ role: m.role, content: anthropicContent(m.content) as never })),
    });
    const text = r.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('');
    const toolCalls = r.content
      .filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use')
      .map((c) => ({ name: c.name, args: (c.input ?? {}) as Record<string, unknown> }));
    return {
      text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: {
        input: r.usage.input_tokens,
        output: r.usage.output_tokens,
        cacheRead: (r.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0,
        cacheWrite: (r.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0,
      },
    };
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
  async chat({ system, messages, maxTokens = 1500, tools, reasoningEffort }: ChatInput): Promise<ChatResult> {
    const msgs = (system ? [{ role: 'system', content: system }, ...messages] : messages).map((m) => ({ role: m.role, content: supportsImages(this.model) ? openAiContent(m.content) : textOnly(m.content) }));
    // gpt-5.x is a reasoning model: pass reasoning_effort, and give non-minimal efforts
    // token headroom so hidden reasoning doesn't starve the visible answer.
    const reasons = /gpt-5/i.test(this.model) && !!reasoningEffort;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: msgs,
      max_completion_tokens: reasons && reasoningEffort !== 'minimal' ? maxTokens + 3000 : maxTokens, // gpt-5.x rejects max_tokens
    };
    if (reasons) body.reasoning_effort = reasoningEffort;
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
  /** this endpoint refused `reasoning: { enabled: false }` once (BL-35) — don't send it again */
  private reasoningMandatory = false;
  /** BL-57: this model was seen spending the whole output budget on hidden reasoning — give it headroom from now on */
  private seenThinking = false;
  async chat({ system, messages, maxTokens = 1500, tools, reasoningEffort }: ChatInput): Promise<ChatResult> {
    const msgs = (system ? [{ role: 'system', content: system }, ...messages] : messages).map((m) => ({ role: m.role, content: supportsImages(this.model) ? openAiContent(m.content) : textOnly(m.content) }));
    // Only send reasoning_effort to OpenAI reasoners (gpt-5.x, o-series) — others 400 on it.
    // gpt-6.x too (2026 bake-off): without its effort set it reasons at the default, which is slow and costly per step.
    const openaiReasoner = /(^|[:/-])(o[1-9]|gpt-[5-9])/i.test(this.model);
    const reasons = openaiReasoner && !!reasoningEffort;
    // Models that "think" spend OUTPUT tokens on hidden reasoning BEFORE the visible answer —
    // give them headroom so the reply isn't starved/truncated. A model not on this list is learned from its first
    // empty reply cut off at the limit (BL-57: Claude Haiku 5.5 through OpenRouter spent all 800 tokens thinking).
    const thinker = openaiReasoner || this.seenThinking || /gemini|deepseek-r|qwen3|:thinking|grok-[34]-mini|magistral/i.test(this.model);
    const headroom = thinker && reasoningEffort !== 'minimal' ? 4000 : 0;
    const body: Record<string, unknown> = { model: this.model, messages: msgs, max_tokens: maxTokens + headroom };
    if (reasons) body.reasoning_effort = reasoningEffort;
    // Gemini Flash THINKS by default and (via OpenRouter) ignores reasoning token caps, so its
    // dynamic thinking can devour the whole budget and truncate the answer mid-word. The agent
    // reasons across tool-steps + AWM, not hidden CoT — so disable Gemini's hidden thinking on
    // OpenRouter for reliable, faster, cheaper replies. (Only OpenRouter accepts `reasoning`.)
    if (/gemini/i.test(this.model) && this.base.includes('openrouter') && !this.reasoningMandatory) body.reasoning = { enabled: false };
    // BL-58: where the data goes. OpenRouter routes a model to any of its hosts, some abroad and some that keep or
    // train on prompts. A host that collects data is refused unless MWA_OPENROUTER_DATA_COLLECTION=allow, and
    // MWA_OPENROUTER_PROVIDERS (comma list of OpenRouter provider tags, e.g. "anthropic,google-vertex/us") limits the
    // call to those hosts with no fallback — Robert, 2026-10-19: no data to other countries.
    if (this.base.includes('openrouter')) {
      body.provider = openRouterRouting(process.env, this.model);
      // The real cost and the cached and reasoning tokens of each call, not an estimate from list prices (2026-10-23):
      // without it a flex call or a cache hit cost what the list price said.
      body.usage = { include: true };
    }
    if (tools?.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = 'auto';
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.key) headers.authorization = `Bearer ${this.key}`;
    let lastErr = `${this.id}: unknown error`;
    const spent = { input: 0, output: 0, cost: 0, costKnown: false }; // a reply thrown away for thinking past the limit still cost its tokens
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
        spent.input += j.usage?.prompt_tokens ?? 0; spent.output += j.usage?.completion_tokens ?? 0;
        if (typeof j.usage?.cost === 'number') { spent.cost += j.usage.cost; spent.costKnown = true; }
        const cached = Number(j.usage?.prompt_tokens_details?.cached_tokens ?? 0) || 0;
        logCall({ model: this.model, served: j.provider, route: (body.provider as { order?: string[] } | undefined)?.order?.[0], in: j.usage?.prompt_tokens ?? 0, cached,
          out: j.usage?.completion_tokens ?? 0, reasoning: Number(j.usage?.completion_tokens_details?.reasoning_tokens ?? 0) || 0, cost: j.usage?.cost,
          sysChars: system?.length ?? 0, msgChars: messages.reduce((n, m) => n + String(m.content ?? '').length, 0), msgs: messages.length, tools: tools?.length ?? 0, attempt });
        // Nothing visible, cut off at the limit: the budget went to hidden reasoning. Once, with headroom.
        if (!text.trim() && !toolCalls && j.choices?.[0]?.finish_reason === 'length' && !this.seenThinking) {
          this.seenThinking = true;
          body.max_tokens = maxTokens + 4000;
          lastErr = `${this.id}: the reply was all hidden reasoning, cut off at ${maxTokens} tokens`;
          continue;
        }
        return { text, toolCalls, usage: { input: spent.input, output: spent.output, ...(cached ? { cacheRead: cached } : {}), ...(spent.costKnown ? { cost: spent.cost } : {}) } };
      }
      const errText = await res.text();
      lastErr = `${this.id} ${res.status}: ${errText.slice(0, 200)}`;
      // Newer Gemini endpoints (gemini-3.8-flash) refuse a request that turns reasoning off: "Reasoning is
      // mandatory for this endpoint and cannot be disabled" — every call failed (BL-35). Send it without.
      if (res.status === 400 && body.reasoning && /reasoning is mandatory/i.test(errText)) { delete body.reasoning; this.reasoningMandatory = true; continue; } // once per provider, not every call
      if (res.status !== 429 && res.status < 500) break;
    }
    throw new Error(lastErr);
  }
}

/**
 * Ollama, through its native API (BL-20). Its OpenAI-compatible /v1 endpoint can't set the context
 * size, so Ollama silently kept only part of MWA's ~11k-token prompts, losing the system prompt and
 * tool list. Measured 2026-10-16 on Ollama 0.40.2: a 67k-character prompt kept 2,050 tokens and the
 * model missed an instruction placed at the start. /api/chat takes `options.num_ctx` per request.
 *
 * - The context is sized from the prompt (a cautious estimate, 8k steps from 16k). One size is kept per
 *   Ollama host and model for the whole process, and it only grows, because Ollama reloads the model
 *   whenever the size changes.
 * - `truncate: false` makes Ollama refuse a prompt that doesn't fit instead of cutting it. The refusal
 *   names the real token count: MWA resizes and retries once, or, past the model's limit or
 *   MWA_OLLAMA_MAX_NUM_CTX, says so with both numbers. MWA_OLLAMA_NUM_CTX fixes the size outright.
 * - A thinking model gets room to think. One that spends its whole reply budget thinking, and says
 *   nothing, is asked again with more room, then reported, never returned as a silent blank.
 */
export const OLLAMA_CTX_STEP = 8192;
export const OLLAMA_CTX_FLOOR = 16384;
/** The least context a model must hold for MWA: its ~11k-token prompts plus a reply. */
export const OLLAMA_MIN_MODEL_CONTEXT = 16384;

/** Tokens a request needs: a cautious estimate of the prompt, plus the reply, plus a margin. */
export function ollamaTokensNeeded(promptChars: number, maxOut: number): number {
  return Math.ceil(promptChars / 2.5) + maxOut + 256;
}

/** Ollama's own address from OLLAMA_BASE_URL, which may name the /v1 or /api path, or carry a query. */
export function ollamaHost(base: string): string {
  const strip = (p: string) => p.replace(/\/+$/, '').replace(/\/(?:v1|api)$/i, '');
  try {
    const u = new URL(base);
    return `${u.protocol}//${u.host}${strip(u.pathname)}`;
  } catch { return strip(base); }
}

const positive = (v: string | undefined): number | null => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null; };
const stepUp = (tokens: number) => Math.max(OLLAMA_CTX_FLOOR, Math.ceil(tokens / OLLAMA_CTX_STEP) * OLLAMA_CTX_STEP);

export interface OllamaModelInfo { limit: number | null; thinking: boolean }
const modelInfo = new Map<string, Promise<OllamaModelInfo | null>>();

/**
 * A model's context limit and whether it thinks, from /api/show. null when Ollama couldn't be reached;
 * that isn't remembered, so a restarted Ollama is asked again.
 */
export async function ollamaModelInfo(host: string, model: string): Promise<OllamaModelInfo | null> {
  const key = `${host} ${model}`;
  let pending = modelInfo.get(key);
  if (!pending) {
    pending = (async (): Promise<OllamaModelInfo | null> => {
      try {
        const r = await fetch(`${host}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(15_000) });
        // Not remembered: a model that isn't pulled yet, or an Ollama having a bad moment, is asked again.
        if (!r.ok) return null;
        const j: any = await r.json();
        const k = Object.keys(j.model_info ?? {}).find((x) => x.endsWith('.context_length'));
        return { limit: k ? positive(String(j.model_info[k])) : null, thinking: Array.isArray(j.capabilities) && j.capabilities.includes('thinking') };
      } catch { return null; }
    })();
    modelInfo.set(key, pending);
  }
  const info = await pending;
  if (info === null) modelInfo.delete(key);
  return info;
}

/** The context size in use per Ollama host and model, shared by every provider in this process. */
const contextInUse = new Map<string, number>();

/** Errors that mean the connection was never made: retrying won't help. */
const CONNECT_FAILURES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT']);

/** Ollama's "this doesn't fit" refusal (truncate:false): the prompt's real size, or null when it's another error. */
function contextRefusal(status: number, text: string): { prompt: number; ctx: number } | null {
  if (status !== 400 || !/exceed_context_size|exceeds the available context/i.test(text)) return null;
  let inner: any = null;
  try { const outer = JSON.parse(text); inner = typeof outer.error === 'string' ? JSON.parse(outer.error) : outer; } catch { /* the message below still has the numbers */ }
  const e = inner?.error ?? inner ?? {};
  const prompt = Number(e.n_prompt_tokens) || Number(/request \((\d+) tokens\)/.exec(text)?.[1]);
  const ctx = Number(e.n_ctx) || Number(/context size \((\d+) tokens\)/.exec(text)?.[1]);
  return prompt ? { prompt, ctx } : null;
}

export class OllamaProvider implements Provider {
  readonly id: string;
  constructor(readonly model: string, readonly price: [number, number], private readonly host: string) {
    this.id = `ollama:${model}`;
  }
  private get key(): string { return `${this.host} ${this.model}`; }

  /** The largest context MWA may ask for: the model's own limit and MWA_OLLAMA_MAX_NUM_CTX, whichever is smaller. */
  private cap(info: OllamaModelInfo | null): { cap: number; why: string } {
    const limit = info?.limit ?? null;
    const ceiling = positive(process.env.MWA_OLLAMA_MAX_NUM_CTX);
    if (ceiling !== null && (limit === null || ceiling <= limit)) return { cap: ceiling, why: `MWA_OLLAMA_MAX_NUM_CTX is ${ceiling}` };
    return limit !== null ? { cap: limit, why: `${this.model} holds at most ${limit}` } : { cap: Infinity, why: '' };
  }

  /** The num_ctx for a request needing about `tokens`: the shared size, grown in steps, within the cap. */
  contextFor(tokens: number, info: OllamaModelInfo | null): number {
    const fixed = positive(process.env.MWA_OLLAMA_NUM_CTX);
    if (fixed) return fixed;
    const ctx = Math.min(Math.max(contextInUse.get(this.key) ?? 0, stepUp(tokens)), this.cap(info).cap);
    contextInUse.set(this.key, Math.max(contextInUse.get(this.key) ?? 0, ctx));
    return ctx;
  }

  private async post(body: Record<string, unknown>): Promise<{ status: number; text: string }> {
    let lastErr = `${this.id}: unknown error`;
    const timeoutMs = positive(process.env.MWA_OLLAMA_TIMEOUT_MS) ?? 10 * 60_000;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, Math.min(8000, 600 * attempt * attempt)));
      let res: Response;
      try {
        res = await fetch(`${this.host}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        const err = e as Error & { cause?: { code?: string; errors?: { code?: string }[] } };
        if (err.name === 'TimeoutError') throw new Error(`${this.id}: no answer within ${Math.round(timeoutMs / 1000)} s (MWA_OLLAMA_TIMEOUT_MS)`);
        // Can't connect at all (nothing listening, a name that doesn't resolve, no route): retrying won't fix it.
        const code = err.cause?.code ?? err.cause?.errors?.[0]?.code ?? '';
        if (CONNECT_FAILURES.has(code)) throw new Error(`${this.id}: can't reach Ollama at ${this.host} (${code}) — is it running, and is OLLAMA_BASE_URL right?`);
        lastErr = `${this.id} network: ${err.message}${code ? ` (${code})` : ''}`; continue;
      }
      const text = await res.text();
      // Only a busy or briefly unavailable server is worth asking again; another error ("requires more system
      // memory") would just reload the model each time.
      if (![429, 502, 503, 504].includes(res.status)) return { status: res.status, text };
      lastErr = `${this.id} ${res.status}: ${text.slice(0, 200)}`;
    }
    throw new Error(lastErr);
  }

  async chat({ system, messages, maxTokens = 1500, tools, reasoningEffort }: ChatInput): Promise<ChatResult> {
    const msgs = (system ? [{ role: 'system', content: system }, ...messages] : messages).map((m) => ({ role: m.role, ...ollamaContent(m.content) }));
    const toolDefs = tools?.length ? tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) : undefined;
    // Images are not prompt text: the context estimate counts the words, not the base64.
    const chars = JSON.stringify(msgs.map((m) => ({ role: m.role, content: m.content }))).length + (toolDefs ? JSON.stringify(toolDefs).length : 0);
    const info = await ollamaModelInfo(this.host, this.model);
    const thinker = info ? info.thinking : /qwen3|deepseek-r|magistral|thinking|gpt-oss/i.test(this.model);
    // Room to think before answering, as for hosted thinkers; none when the caller asks for minimal effort.
    // A thinking model always gets room to think, even at minimal effort: told not to think (think:false),
    // qwen3 just writes its reasoning into the answer instead (probed on Ollama 0.40.2), and without the room
    // it spends the whole reply budget thinking and says nothing.
    let maxOut = maxTokens + (thinker ? 4000 : 0);
    let numCtx = this.contextFor(ollamaTokensNeeded(chars, maxOut), info);
    for (let round = 0; ; round++) {
      // truncate:false — refuse a prompt that doesn't fit instead of cutting it. shift:false — when the reply
      // runs into the end of the context, stop there instead of dropping the start of the prompt to make room.
      const body: Record<string, unknown> = { model: this.model, messages: msgs, stream: false, truncate: false, shift: false, options: { num_ctx: numCtx, num_predict: maxOut } };
      if (toolDefs) body.tools = toolDefs;
      const { status, text } = await this.post(body);
      const tooBig = contextRefusal(status, text);
      if (tooBig) {
        const need = tooBig.prompt + maxOut + 256;
        const { cap, why } = this.cap(info);
        const fixed = positive(process.env.MWA_OLLAMA_NUM_CTX);
        if (round === 0 && !fixed && need <= cap) { numCtx = this.contextFor(need, info); continue; }
        throw new Error(`${this.id}: this prompt is ${tooBig.prompt} tokens and needs about ${need} with its reply, but ${fixed ? `MWA_OLLAMA_NUM_CTX is ${fixed}` : why || `Ollama's context is ${tooBig.ctx}`}. Ollama would drop the start of the prompt (the instructions and tools), so MWA stopped. Use a model with a larger context, or a hosted model.`);
      }
      if (status === 404 && !/model/i.test(text)) {
        throw new Error(`${this.id}: ${this.host} doesn't serve Ollama's /api/chat, so it isn't Ollama (or is a very old one). For LM Studio, llama.cpp or another OpenAI-compatible server, use openai:<model> with OPENAI_BASE_URL.`);
      }
      if (status < 200 || status >= 300) throw new Error(`${this.id} ${status}: ${text.slice(0, 200)}`);
      let j: any;
      try { j = JSON.parse(text); } catch { throw new Error(`${this.id}: Ollama's answer wasn't JSON: ${text.slice(0, 120)}`); }
      if (!j.message) throw new Error(`${this.id}: Ollama answered without a message${j.error ? `: ${String(j.error).slice(0, 160)}` : ''}`);
      // Reasoning a model writes inline is not the answer (the native API normally puts it in `thinking`).
      const answer = String(j.message.content ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      const toolCalls = Array.isArray(j.message.tool_calls) && j.message.tool_calls.length
        ? j.message.tool_calls.map((tc: any) => ({ name: tc.function?.name ?? '', args: typeof tc.function?.arguments === 'string' ? safeJson(tc.function.arguments) : (tc.function?.arguments ?? {}) }))
        : undefined;
      if (!answer && !toolCalls && j.done_reason === 'length') {
        // It ran out of room before answering, usually while thinking. Once more with twice the room.
        // The context stays as it is: growing it for a model that keeps thinking would hold that memory for good.
        if (round < 2) { maxOut *= 2; continue; }
        throw new Error(`${this.id}: the model used its whole reply budget (${maxOut} tokens)${j.message.thinking ? ' thinking' : ''} without answering`);
      }
      return { text: answer, toolCalls, usage: { input: j.prompt_eval_count ?? 0, output: j.eval_count ?? 0 } };
    }
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
  // Ollama's own API, not its /v1 shim: only the native API can set the context size (BL-20).
  if (provider === 'ollama') {
    const oc = OPENAI_COMPAT.ollama;
    return new OllamaProvider(model, oc.price, ollamaHost((oc.baseEnv && process.env[oc.baseEnv]) || oc.base));
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
 * List available models for a provider, for the onboarding model picker. Best-effort:
 *  - OpenAI-compatible (openai/openrouter/gemini/ollama): GET {base}/models (Bearer key; ollama keyless).
 *    OpenRouter's list is the richest (hundreds of models, public) — a great "easy to spin up" default.
 *  - anthropic: GET https://api.anthropic.com/v1/models.
 *  - azure: deployment-named, no catalog → [] (the UI lets you type the deployment).
 * Returns [] on any error so the UI cleanly falls back to manual entry.
 */
export async function listModels(provider: string, opts: { key?: string; baseUrl?: string; kind?: 'chat' | 'image' } = {}): Promise<{ id: string; name?: string }[]> {
  loadEnv();
  const p = provider.toLowerCase();
  const kind = opts.kind ?? 'chat';
  try {
    if (p === 'anthropic') {
      if (kind === 'image') return []; // Anthropic has no image-generation models
      const key = opts.key || process.env.ANTHROPIC_API_KEY;
      if (!key) return [];
      const r = await fetch('https://api.anthropic.com/v1/models?limit=200', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return [];
      const j = (await r.json()) as { data?: { id: string; display_name?: string }[] };
      return (j.data ?? []).map((m) => ({ id: m.id, name: m.display_name })).filter((m) => m.id);
    }
    if (p === 'azure') return []; // deployment-named — user types the deployment name
    const oc = OPENAI_COMPAT[p];
    if (!oc) return [];
    const base = (opts.baseUrl || (oc.baseEnv && process.env[oc.baseEnv]) || oc.base).replace(/\/$/, '');
    const key = oc.keyless ? undefined : (opts.key || process.env[oc.keyEnv!]);
    if (!oc.keyless && !key) return [];
    const headers: Record<string, string> = {};
    if (key) headers['authorization'] = `Bearer ${key}`;
    const r = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const j = (await r.json()) as { data?: ModelRow[] };
    return kind === 'image' ? filterImageModels(j.data ?? []) : filterChatModels(j.data ?? []);
  } catch {
    return [];
  }
}

interface ModelRow { id: string; name?: string; supported_parameters?: string[]; architecture?: { output_modalities?: string[] } }

/** Keep only models that OUTPUT images (diffusion / image-gen) — the inverse of the chat
 *  filter. Used to populate the image-model picker from the user's connected provider. */
function filterImageModels(rows: ModelRow[]): { id: string; name?: string }[] {
  const hasCaps = rows.some((m) => m.architecture?.output_modalities);
  if (!hasCaps) return []; // can't tell → don't guess (the UI offers connecting an image service)
  return rows
    .filter((m) => m.id && (m.architecture?.output_modalities ?? []).includes('image'))
    .map((m) => ({ id: m.id, name: m.name }));
}

/**
 * Keep only models usable as a CHAT BRAIN and drop image/embedding/etc. Catalogs like
 * OpenRouter mix in image-generation and embedding models (and list newest first, so brand-new
 * image models sit on top) — picking one silently breaks tool use. When a catalog advertises
 * capabilities we filter to text-output, tool-capable models and sort those first; when it
 * doesn't (plain OpenAI/Ollama /models), we pass everything through unchanged.
 */
function filterChatModels(rows: ModelRow[]): { id: string; name?: string }[] {
  const hasCaps = rows.some((m) => m.supported_parameters || m.architecture?.output_modalities);
  if (!hasCaps) return rows.map((m) => ({ id: m.id, name: m.name })).filter((m) => m.id);
  const scored = rows
    .filter((m) => m.id)
    .map((m) => {
      const out = m.architecture?.output_modalities ?? [];
      const textOut = out.length === 0 || out.includes('text');
      const imageOnly = out.length > 0 && out.includes('image') && !out.includes('text');
      const tools = (m.supported_parameters ?? []).includes('tools');
      return { id: m.id, name: m.name, keep: textOut && !imageOnly, tools };
    })
    .filter((m) => m.keep);
  // Tool-capable models are the only ones that can drive the agent — surface them first.
  scored.sort((a, b) => (b.tools ? 1 : 0) - (a.tools ? 1 : 0));
  const toolCapable = scored.filter((m) => m.tools);
  const list = toolCapable.length ? toolCapable : scored; // never return empty if all lacked the flag
  return list.map((m) => ({ id: m.id, name: m.name }));
}

/**
 * Resolve the provider for a tier from mwa.config.json: `models.fetch` (cheap brain) and
 * `models.reason` (strong ceiling), each a "provider:model" spec — so the model is a
 * config value and any provider (incl. local Ollama, no key) works with no code change.
 * Falls back to whatever IS configured so the agent always runs.
 */
export function getProvider(role: ProviderRole): Provider {
  const main = tierProvider(role);
  const bg = loadConfig().models.background;
  if (!bg) return main;
  // BL-73: the strong tier stays the usual model — the boss a background run escalates to.
  if (role === 'high' && backgroundBoss()) return main;
  try { return new BackgroundSwitch(main, resolveProvider(bg)); } catch { return main; }
}

/**
 * BL-73 (Robert, 2026-10-23: "a solid citizen that can just run on short, ongoing tasks … when it does [complex work],
 * it can have a coworker or a boss that can review the work"). With a background model, a background run starts on
 * it and escalates to the usual strong model (the boss) — when it stalls for 3 steps, ignores a check or gives up
 * (src/agent.ts) — when MWA_BACKGROUND_BOSS=on. Off (the default), both tiers are the background model.
 */
export function backgroundBoss(env: NodeJS.ProcessEnv = process.env): boolean {
  // Off unless asked for. The job bake-off (2026-10-23, round 3) measured it: with MWA's checks, Luna alone scored
  // 27/28 at $0.0044 a brief and with Sol as boss 28/28 at $0.074; DeepSeek V4.1 Flash 27/28 either way, $0.0046
  // against $0.063. The boss stepped in on 8-10 of 28 fires and was over 90% of the cost.
  return /^(1|on|true|yes)$/i.test(String(env.MWA_BACKGROUND_BOSS ?? '').trim());
}

/** True when this call is background work handed to a background model: it starts on the worker, with a boss above. */
export function backgroundWorker(): boolean {
  if (backgroundCalls.getStore() !== true || !backgroundBoss()) return false;
  try { return Boolean(loadConfig().models.background); } catch { return false; }
}

/**
 * Cost (2026-10-23): a call made inside backgroundCalls (a scheduled job, a hand-off, thinking time) goes to
 * models.background (MWA_BACKGROUND_MODEL); a chat the person is waiting on keeps the usual model.
 * Measured on three research jobs: $0.14 on gpt-6-luna against $2.08-2.62 on gpt-6.1-sol, all three files written.
 * Decided per call, not per provider object, because one router serves both chats and jobs.
 * BL-73: at MWA_BACKGROUND_EFFORT (default high) — the job bake-off measured every worker at high, where a brief cost
 * $0.003 on DeepSeek V4.1 Flash; the cheap tier's usual "minimal" is for quick chat turns, not unattended work.
 */
class BackgroundSwitch implements Provider {
  constructor(private readonly main: Provider, private readonly bg: Provider) {}
  private active(): Provider { return backgroundCalls.getStore() === true ? this.bg : this.main; }
  get id(): string { return this.active().id; }
  get model(): string { return this.active().model; }
  get price(): [number, number] { return this.active().price; }
  chat(input: ChatInput): Promise<ChatResult> {
    if (backgroundCalls.getStore() !== true) return this.main.chat(input);
    const e = String(process.env.MWA_BACKGROUND_EFFORT ?? 'high').trim().toLowerCase();
    const effort = (['minimal', 'low', 'medium', 'high'] as const).find((x) => x === e);
    return this.bg.chat(effort ? { ...input, reasoningEffort: effort } : input);
  }
}

function tierProvider(role: ProviderRole): Provider {
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
