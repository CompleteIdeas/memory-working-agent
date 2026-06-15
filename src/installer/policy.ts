/**
 * Install policy + the "installation model" quality gate.
 *
 * The model that reviews unvetted connectors is tied to the USER'S configured model
 * (defaults to the strong/reason tier). If that model isn't capable enough to vet
 * untrusted code, the external-install capability is turned OFF with a clear reason —
 * we never pretend a weak local model can security-review code. Onboarding should nudge
 * toward a capable option (an aggregator like OpenRouter, or a key they already have).
 */
import type { MwaConfig } from '../config.js';

// provider:model specs we consider strong enough to review code. Conservative on purpose.
const CAPABLE = [
  /(^|:)claude-(opus|sonnet)/i,
  /(^|:)(gpt-4o|gpt-4\.|gpt-5|o1|o3|o4)/i,
  /(^|:)gemini-(1\.5-pro|2\.|2\.5)/i,
  /openrouter:.*(claude-(3|opus|sonnet)|gpt-4|gpt-5|deepseek|qwen2\.5-72|llama-3\.1-(70|405))/i,
];

/** Is this provider:model spec strong enough to security-review untrusted code? */
export function isReviewCapable(spec: string): boolean {
  if (!spec) return false;
  // Local Ollama models: only trust clearly-large ones; small local models are NOT trusted.
  if (/^ollama:/i.test(spec)) return /(70b|72b|405b|qwen2\.5-72|llama3\.[13]-70)/i.test(spec);
  return CAPABLE.some((re) => re.test(spec));
}

/** The model spec used for connector reviews (models.installer, else the reason tier). */
export function installerSpec(cfg: MwaConfig): string {
  return cfg.models.installer || cfg.models.reason;
}

export interface ExternalInstallState { enabled: boolean; policy: string; reason: string; model: string }

/** Whether installing connectors from OUTSIDE the curated library is allowed right now. */
export function externalInstallState(cfg: MwaConfig): ExternalInstallState {
  const policy = cfg.tools.installPolicy ?? 'review-required';
  const model = installerSpec(cfg);
  if (policy === 'off') return { enabled: false, policy, model, reason: 'Installing connectors from outside the library is turned off (installPolicy: off).' };
  if (policy === 'curated-only') return { enabled: false, policy, model, reason: 'Only connectors from the curated library can be installed (installPolicy: curated-only).' };
  if (!isReviewCapable(model)) {
    return {
      enabled: false, policy, model,
      reason: `Installing connectors from outside the library needs a stronger reviewing model than "${model}". Connect a capable model — an aggregator like OpenRouter, or an Anthropic/OpenAI key you already have — to enable it.`,
    };
  }
  return { enabled: true, policy, model, reason: `Connectors from outside the library are reviewed by ${model} before you approve them.` };
}
