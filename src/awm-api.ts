/**
 * The ONE place MWA touches AWM's internals (BL-11, H-7 in docs/harness-evaluation-2026-10-13.md).
 *
 * AWM is a vendored submodule, and MWA uses parts of it that aren't its published API: the engines,
 * the write pipeline, the storage adapters. Those have no stability contract — AWM's own releases have
 * renamed a tag, moved the default store and changed recall defaults. There were 14 deep imports into
 * `agent-working-memory/dist/**` across five source files, so an AWM refactor landed as a break
 * somewhere unexpected. Now the coupling is listed here; an AWM upgrade that moves something breaks this
 * file and nothing else. `tests/awm-api.test.ts` keeps it that way.
 *
 * Importing this file is LIGHT (BL-11 review): its only static import is AWM's onboarding questions,
 * plain data. Everything heavy — the engines, which pull in the embedding model's runtime, and the
 * storage adapters — is behind a loader, so `npm run setup` can still report a missing or broken AWM
 * instead of crashing at import, and code that imports the agent doesn't load the model runtime.
 *
 * What MWA uses, and why:
 * - the engines (activation, connections, consolidation): recall, association and sleep — MwaMemory
 *   drives them directly rather than through AWM's HTTP/MCP surfaces;
 * - performWrite: AWM's write pipeline (salience, novelty, embedding) for MwaMemory.write;
 * - initCoordinationTables: the workspace tables a hive-mode memory needs;
 * - embed, cosineSimilarity: the embedding model, for the gauntlet's vector-RAG arm and setup's warm-up;
 * - INTERVIEW_QUESTIONS: AWM's onboarding interview, which `mwa onboard` presents;
 * - the three storage adapters (SQLite, PGlite, Postgres), loaded only when chosen;
 * - AWM's CLI, for the backend-agnostic export/import a Postgres switch runs.
 *
 * The dev scripts in scripts/ still import internals directly: they are measurement tools, not the
 * product, and some exist precisely to probe one internal.
 */
import { createRequire } from 'node:module';

export { INTERVIEW_QUESTIONS } from 'agent-working-memory/dist/onboard/index.js';

// Typed from AWM's own declarations — type-only, so nothing loads at import — so a changed constructor
// or signature fails the build here, not just a renamed export (BL-11 review).
export interface AwmEngines {
  ActivationEngine: typeof import('agent-working-memory/dist/engine/activation.js').ActivationEngine;
  ConnectionEngine: typeof import('agent-working-memory/dist/engine/connections.js').ConnectionEngine;
  ConsolidationEngine: typeof import('agent-working-memory/dist/engine/consolidation.js').ConsolidationEngine;
  performWrite: typeof import('agent-working-memory/dist/core/write-pipeline.js').performWrite;
  initCoordinationTables: typeof import('agent-working-memory/dist/coordination/schema.js').initCoordinationTables;
}

let engines: Promise<AwmEngines> | null = null;
/** The engines and the write pipeline, loaded once on first use. */
export function loadEngines(): Promise<AwmEngines> {
  engines ??= (async () => {
    const [activation, connections, consolidation, pipeline, schema] = await Promise.all([
      import('agent-working-memory/dist/engine/activation.js'),
      import('agent-working-memory/dist/engine/connections.js'),
      import('agent-working-memory/dist/engine/consolidation.js'),
      import('agent-working-memory/dist/core/write-pipeline.js'),
      import('agent-working-memory/dist/coordination/schema.js'),
    ]);
    return {
      ActivationEngine: activation.ActivationEngine, ConnectionEngine: connections.ConnectionEngine,
      ConsolidationEngine: consolidation.ConsolidationEngine, performWrite: pipeline.performWrite,
      initCoordinationTables: schema.initCoordinationTables,
    };
  })();
  engines.catch(() => { engines = null; }); // a failed load may be retried
  return engines;
}

/** AWM 0.18.1's "newer beats older" order for results its conflict detector marked (BL-59). An AWM build that
 *  predates it leaves the order as it is. */
export async function loadConflictOrder(): Promise<<T>(results: T[], marks: unknown[][]) => T[]> {
  try {
    const mod: any = await import('agent-working-memory/dist/core/conflicts.js');
    if (typeof mod.newestFirstAmongConflicts === 'function') return mod.newestFirstAmongConflicts;
  } catch { /* older AWM */ }
  return (results) => results;
}

/** The embedding model's entry points. */
export async function loadEmbeddings(): Promise<{ embed: (text: string) => Promise<number[]>; cosineSimilarity: (a: number[], b: number[]) => number }> {
  return import('agent-working-memory/dist/core/embeddings.js');
}

/** AWM's implicit-use rule (A5: which recalled memories an answer used). */
export async function loadImplicitFeedback(): Promise<{ matchUses: typeof import('agent-working-memory/dist/core/implicit-feedback.js').matchUses }> {
  return import('agent-working-memory/dist/core/implicit-feedback.js');
}

/** The SQLite store (the default backend). */
export async function loadSqliteStore(): Promise<any> {
  return (await import('agent-working-memory/dist/storage/sqlite.js')).EngramStore;
}

/** The embedded PGlite store (single process). */
export async function loadPGliteStore(): Promise<any> {
  return (await import('agent-working-memory/dist/storage/pglite.js')).PGliteEngramStore;
}

/** The networked Postgres store. A computed specifier, resolved at run time, keeps MWA buildable
 *  against AWM builds that predate the adapter. */
export async function loadPostgresStore(): Promise<any> {
  const mod = 'agent-working-memory/dist/storage/postgres.js';
  return (await import(/* @vite-ignore */ mod)).PostgresEngramStore;
}

/** The path of AWM's CLI, for its export/import; throws when this build doesn't ship it. */
export function awmCliPath(): string {
  return createRequire(import.meta.url).resolve('agent-working-memory/dist/cli.js');
}
