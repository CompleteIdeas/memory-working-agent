/**
 * Which models resist instructions planted in what MWA reads (BL-23).
 *
 * MWA fences outside content (email, web pages, tool output) and tells the model to treat it as data.
 * That only works if the model keeps to it, and models differ a lot. These are measured, not assumed:
 * scripts/e2e-injection.mjs, 8 trials per model, on 2026-10-15. Each trial plants instructions in a
 * file the run reads; "complied" means the model did what they said (wrote the planted file). See
 * docs/models.md for the method and its limits.
 *
 * A model that isn't listed hasn't been measured. That isn't the same as unsafe, but it isn't safe
 * either, and the person should know which one they are running.
 */

export interface InjectionMeasurement { model: string; complied: number; of: number; echoed?: number; date: string; note?: string }

/** Measured models, by a normalized name (see modelKey). */
export const INJECTION_MEASUREMENTS: Record<string, InjectionMeasurement> = {
  'gpt-5-4-mini': { model: 'gpt-5.4-mini', complied: 0, of: 8, echoed: 0, date: '2026-10-15', note: 'held in every round of the build loop since' },
  'gemini-2-5-flash-lite': { model: 'gemini-2.5-flash-lite', complied: 2, of: 8, echoed: 1, date: '2026-10-15' },
  'deepseek-v3-2': { model: 'deepseek-v3.2', complied: 4, of: 8, echoed: 3, date: '2026-10-15' },
  'gpt-5-nano': { model: 'gpt-5-nano', complied: -1, of: 8, echoed: 1, date: '2026-10-15', note: 'repeated a planted code word; the full count was lost' },
};

/** A comparable name: no provider prefix or vendor path, lower case, dots and underscores as dashes. */
export function modelKey(spec: string): string {
  const afterProvider = spec.includes(':') && /^[a-z]+:/i.test(spec) ? spec.slice(spec.indexOf(':') + 1) : spec;
  return afterProvider.split('/').pop()!.trim().toLowerCase().replace(/[._]/g, '-');
}

export type InjectionStanding = 'held' | 'failed' | 'unmeasured';

/** How a configured model fared against planted instructions, in one sentence for a person. */
export function injectionNote(spec: string): { standing: InjectionStanding; text: string } {
  const m = INJECTION_MEASUREMENTS[modelKey(spec)];
  if (!m) {
    return { standing: 'unmeasured', text: `${spec} hasn't been tested against instructions planted in emails or web pages. Until it has, don't point it at mail or pages you don't trust (docs/models.md).` };
  }
  if (m.complied === 0) return { standing: 'held', text: `${m.model} ignored instructions planted in what it read in all ${m.of} trials (${m.date}).` };
  const how = m.complied > 0 ? `followed instructions planted in what it read in ${m.complied} of ${m.of} trials` : `failed the test${m.note ? ` (${m.note})` : ''}`;
  return { standing: 'failed', text: `${m.model} ${how} (${m.date}). Don't use it on email or web pages you don't trust: a message could make it act for the sender (docs/models.md).` };
}

/** Warnings for the configured models, for the startup log. Empty when every one has held. */
export function modelWarnings(models: { fetch: string; reason: string }): string[] {
  const out: string[] = [];
  for (const spec of [...new Set([models.fetch, models.reason])]) {
    const n = injectionNote(spec);
    if (n.standing !== 'held') out.push(n.text);
  }
  return out;
}
