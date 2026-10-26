/**
 * List prices per model, in dollars per million tokens — the fallback when a provider does not report a call's own
 * bill (OpenRouter's `usage.cost` always wins when present). Review of A3b (2026-10-26): every `openrouter:` model was
 * priced at one flat [0.5, 1.5], so a dollar cap projected an escalation from luna to sol at the cheap price (sol bills
 * $2 / $10), and an unknown model counted as nearly free.
 *
 * Anthropic prices are Anthropic's first-party list (2026-10). Prices marked `approx` are estimates for models whose
 * list price MWA has not recorded; they sit at or above what MWA's own runs measured, and only matter when the
 * provider gives no bill of its own. A model in none of these rows is priced at UNKNOWN_PRICE (conservative) and
 * named once in the log.
 */
export interface ModelPrice {
  in: number; out: number;
  /** cached input read / written (Anthropic reports these apart from `input`); default 0.1× and 1.25× input */
  cacheRead?: number; cacheWrite?: number;
  approx?: boolean;
}

const ROWS: [RegExp, ModelPrice][] = [
  // OpenAI (through OpenRouter or direct)
  [/gpt-6\.1-sol/i, { in: 2, out: 10, cacheRead: 0.2 }],
  [/gpt-6-luna/i, { in: 0.25, out: 2, cacheRead: 0.025, approx: true }],
  [/gpt-5\.4-mini/i, { in: 0.75, out: 4.5, cacheRead: 0.075 }],
  // DeepSeek, Google (background-model candidates in the 2026-10 job bake-off)
  [/deepseek-v4\.1-flash/i, { in: 0.15, out: 0.6, approx: true }],
  [/gemini-3\.8-flash/i, { in: 0.3, out: 2.5, approx: true }],
  [/gemini-4-argon/i, { in: 1.25, out: 10, approx: true }],
  // Anthropic (first-party list): Opus is priced as Opus
  [/claude-opus-5[-.]5/i, { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 }],
  [/claude-opus-(?:5|4[-.][5-9])\b/i, { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  [/claude-(?:3-)?opus/i, { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  [/claude-sonnet-5(?:[-.]5)?\b/i, { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  [/claude-(?:3[-.]\d-)?sonnet/i, { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  [/claude-haiku-5[-.]5/i, { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }],
  [/claude-(?:3[-.]\d-)?haiku/i, { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
];

/** A model nobody priced: counted conservatively, never as free. */
export const UNKNOWN_PRICE: ModelPrice = { in: 10, out: 30 };

/** The list price of a model ("openai/gpt-6.1-sol", "claude-opus-5-5"), or null when it is not in the table. */
export function priceFor(model: string | undefined | null): ModelPrice | null {
  const m = String(model ?? '');
  for (const [re, p] of ROWS) if (re.test(m)) return p;
  return null;
}

const warned = new Set<string>();
/** Say once per model that it is priced at the conservative default. */
export function warnUnknownPrice(model: string): void {
  if (warned.has(model)) return;
  warned.add(model);
  console.error(`[cost] no list price for "${model}": counted at $${UNKNOWN_PRICE.in}/$${UNKNOWN_PRICE.out} per 1M tokens until it reports its own cost`);
}
