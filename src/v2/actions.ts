/**
 * What the helper DID, one row per action (v2 slice A10 review, H1): the count Today's "Done for you" and the
 * last-7-days line read.
 *
 * The AWM action log (MwaMemory.logAction, the Glass Box history) is not a counter: it slugs the tool name into a tag
 * (draft_email → tool=draft-email), and three similar drafts merge into one memory by design (the store reinforces
 * near-duplicates). So every logged action is ALSO written here, exactly once, with the tool's own name, who the run
 * was for and when. A staged action ("[APPROVAL REQUIRED]") is not an action — nothing happened yet — and is logged
 * by neither; the approval that runs it later is recorded then (src/tools/approval.ts), as `via: 'approval'`.
 */
import { appDb, recordEvent, registerMigrations } from './db.js';

registerMigrations([{
  name: '012-actions',
  sql: `
    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tool TEXT NOT NULL, person TEXT, session TEXT, run_id TEXT,
      via TEXT NOT NULL DEFAULT 'run' CHECK (via IN ('run','approval')));
    CREATE INDEX IF NOT EXISTS actions_ts ON actions(ts);`,
}]);

export interface ActionRow { id: number; ts: number; tool: string; person: string | null; session: string | null; run_id: string | null; via: 'run' | 'approval' }

/** One spelling for a tool: 'draft-email', 'Draft_Email' and 'draft_email' are the same tool. */
export const toolKey = (tool: string): string => String(tool ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');

/** A tool's result that only staged the action for the person's OK: nothing was done yet. */
export const stagedOnly = (result: string): boolean => /^\s*\[APPROVAL REQUIRED\]/.test(String(result ?? ''));

/** Record one action that happened. Never throws (the action already happened; the count is secondary). */
export function recordAction(a: { tool: string; person?: string | null; session?: string | null; runId?: string | null; via?: 'run' | 'approval'; ts?: number }): number | null {
  try {
    const d = appDb();
    return d.transaction(() => {
      const r = d.prepare('INSERT INTO actions (ts, tool, person, session, run_id, via) VALUES (?, ?, ?, ?, ?, ?)')
        .run(Math.round(a.ts ?? Date.now()), toolKey(a.tool), a.person ?? null, a.session ?? null, a.runId ?? null, a.via ?? 'run');
      const id = Number(r.lastInsertRowid);
      recordEvent({ entity: 'action', id: String(id), person: a.person ?? undefined }, d);
      return id;
    })();
  } catch { return null; }
}

/** Actions in [from, to], newest first. */
export function actionsBetween(from: number, to: number): ActionRow[] {
  return appDb().prepare('SELECT * FROM actions WHERE ts >= ? AND ts <= ? ORDER BY ts DESC, id DESC').all(from, to) as ActionRow[];
}

/**
 * The agent's side-effecting tool call, logged: the Glass Box history in AWM (as before) and one row here. A staged
 * action is logged by neither. Returns whether it was logged.
 */
export async function logToolAction(
  memory: { logAction(a: { verb: string; summary: string; effect: 'external' | 'local' | 'read'; tool?: string }): Promise<string | null> },
  a: { verb: string; tool: string; effect: 'external' | 'local' | 'read'; result: string; person?: string | null; session?: string | null; runId?: string | null },
): Promise<boolean> {
  if (stagedOnly(a.result)) return false;
  recordAction({ tool: a.tool, person: a.person, session: a.session, runId: a.runId });
  try { await memory.logAction({ verb: a.verb, summary: a.result.slice(0, 200).replace(/\n/g, ' '), effect: a.effect, tool: a.tool }); } catch { /* */ }
  return true;
}
