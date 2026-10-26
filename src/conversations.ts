/**
 * BL-71d — conversations you can go back to. The chat on screen lived only in the browser tab, and the
 * server's thread only in memory, so a reload, a deploy or another device started blank (Robert, 2026-10-22:
 * "you can't go back immediately and continue a conversation").
 *
 * v2 slice A5 (2026-10-26): turns live in app.db's `turns` table now, one continuous thread per Project
 * (src/v2/projects.ts). The functions below keep their old signatures, so serve.ts's callers did not change:
 *   - a session `p-<projectId>` is that project's thread;
 *   - any other session (`web-…`, an older client's conversation) is kept in General, with the conversation's own id
 *     in `legacy_session` — reading that session still returns just its turns, and they show in General's thread.
 * conversations.jsonl is no longer written; src/v2/migrate-conversations.ts reads it once to move what it holds into
 * General. Telegram sessions (`tg-…`) were never part of the app's conversations and are not kept here.
 *
 * `path`: the log's location, as before. Left out (or the configured one), the app database is used; a test naming
 * its own path gets its own database beside it, opened for the call and closed after.
 */
import { dirname, join, resolve } from 'node:path';
import { runLogPath } from './paths.js';
import { appDb, openAppDbAt, type AppDb } from './v2/db.js';
import { GENERAL, getProject, projectOfSession, writeTurn, setTurnMeta, type TurnRow, type TurnMeta, type Provenance } from './v2/projects.js';

export interface ConversationTurn {
  ts: number; session: string; message: string; reply: string; reason?: string;
  /** the turn read outside content: it goes back into the model's context only fenced */
  tainted?: boolean;
  /** a scheduled or background result posted into this conversation, not a turn the person typed; `running` is a
   *  turn whose run has started and not finished (F09, 2026-10-24) — the page re-attaches to it after a reload.
   *  `divider` (A5): the heading of a conversation migrated into General. */
  kind?: 'chat' | 'result' | 'offer' | 'running' | 'offer-answer' | 'divider';
  /** the live run this turn belongs to: the `running` turn and its finished turn share it */
  runId?: string;
  /** on an `offer` turn, how the person answered it. Pending list 2026-10-26, item 3a. */
  offer?: { answered: 'background' | 'now'; goal?: string; at: number };
  /** on an `offer-answer` record (the JSONL log only): the `ts` of the offer turn it answers */
  answers?: number;
  /** on a chat turn that resumed a stopped run (3b): the `ts` of the stopped turn whose words it continued */
  resumes?: number;
  /** A5: the turn's id and project (set when read back), and the other projects whose memories its answer used */
  id?: string;
  projectId?: string;
  provenance?: Provenance[];
  /** A6: what the turn asked about (an item, an event, a job) */
  about?: { kind: string; id: string };
}
export interface ConversationSummary { session: string; title: string; last: number; turns: number; lastMessage: string }

/** Where the old JSON-lines log is (read by the migration): MWA_CONVERSATIONS, else beside the run log. */
export function conversationsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MWA_CONVERSATIONS ?? join(dirname(runLogPath(env)), 'conversations.jsonl');
}

/** The database for a call: the app's, or (a path of its own) one beside that path, closed after. */
function withStore<T>(path: string | undefined, fn: (d: AppDb) => T): T {
  if (path === undefined || resolve(path) === resolve(conversationsPath())) return fn(appDb());
  const d = openAppDbAt(`${path}.sqlite`);
  try { return fn(d); } finally { d.close(); }
}

/** The project a session's turn belongs to, and the older conversation id it keeps. */
function placeOf(session: string, d: AppDb): { projectId: string; legacySession: string | null } {
  const p = projectOfSession(session);
  if (p && getProject(p, d)) return { projectId: p, legacySession: null };
  return { projectId: GENERAL, legacySession: session.slice(0, 80) };
}

function toTurn(r: TurnRow): ConversationTurn {
  let meta: TurnMeta = {};
  try { meta = r.meta ? JSON.parse(r.meta) : {}; } catch { meta = {}; }
  let prov: Provenance[] = [];
  try { prov = r.provenance ? JSON.parse(r.provenance) : []; } catch { prov = []; }
  return {
    ts: r.ts, session: r.legacy_session ?? r.session, message: r.message, reply: r.reply, kind: r.kind, id: r.id, projectId: r.project_id,
    ...(r.reason != null ? { reason: r.reason } : {}),
    ...(r.tainted != null ? { tainted: r.tainted === 1 } : {}),
    ...(r.run_id ? { runId: r.run_id } : {}),
    ...(meta.offer ? { offer: meta.offer } : {}),
    ...(meta.resumes !== undefined ? { resumes: meta.resumes } : {}),
    ...(prov.length ? { provenance: prov } : {}),
    ...(r.about_kind && r.about_id ? { about: { kind: r.about_kind, id: r.about_id } } : {}),
  };
}

/** Keep one turn. Best effort: a chat never fails because its turn couldn't be written. Returns its id. */
export function appendTurn(t: ConversationTurn, path?: string): string | undefined {
  if (t.session.startsWith('tg-') || t.kind === 'offer-answer') return undefined;
  try {
    return withStore(path, (d) => {
      const place = placeOf(t.session, d);
      return writeTurn({
        ...place, ts: t.ts, kind: (t.kind ?? 'chat') as Exclude<ConversationTurn['kind'], 'offer-answer' | undefined>, message: t.message, reply: t.reply,
        reason: t.reason ?? null, tainted: t.tainted ?? null, runId: t.runId ?? null, provenance: t.provenance ?? null, about: t.about ?? null,
        meta: { ...(t.offer ? { offer: t.offer } : {}), ...(t.resumes !== undefined ? { resumes: t.resumes } : {}) },
      }, d)?.id;
    });
  } catch { return undefined; /* best effort */ }
}

function sessionRows(d: AppDb, session: string, limit?: number): TurnRow[] {
  // A thread session is its project's turns; any other is the older conversation kept under that id.
  const rows = d.prepare(`SELECT * FROM turns WHERE (session = @s OR legacy_session = @s) AND kind != 'divider' ORDER BY ord DESC, rowid DESC ${limit ? 'LIMIT @limit' : ''}`)
    .all({ s: session.slice(0, 80), ...(limit ? { limit } : {}) }) as TurnRow[];
  return rows.reverse();
}

/** The person answered the conversation's latest unanswered offer: "Work on it" (background, with the goal it made)
 *  or "do it here" (now). The answer rides on the offer turn. Returns the offer's ts, or null when nothing was waiting. */
export function answerOffer(session: string, answered: 'background' | 'now', goal?: string, path?: string, now = Date.now(), message?: string): number | null {
  try {
    return withStore(path, (d) => {
      const open = sessionRows(d, session).filter((r) => r.kind === 'offer' && !toTurn(r).offer).reverse();
      // With the words sent back, only the offer with those words: "Try again" on a failed task also sends stay=1 (audit
      // 2026-10-26), and must not answer an unrelated offer. Without words, the latest waiting one.
      const offer = message ? open.find((r) => r.message === message.slice(0, 20_000)) : open[0];
      if (!offer) return null;
      setTurnMeta(offer.id, { offer: { answered, ...(goal ? { goal } : {}), at: now } }, d);
      return offer.ts;
    });
  } catch { return null; }
}

/** A conversation's turns, oldest first (the last `limit`). */
export function readConversation(session: string, limit = 60, path?: string): ConversationTurn[] {
  try { return withStore(path, (d) => sessionRows(d, session, limit).map(toTurn)); } catch { return []; }
}

/** Conversations, most recently active first, titled by their first message. A project's thread is one of them. */
export function listConversations(limit = 30, path?: string): ConversationSummary[] {
  let rows: TurnRow[] = [];
  try { rows = withStore(path, (d) => d.prepare(`SELECT * FROM turns WHERE kind != 'divider' ORDER BY ts, rowid`).all() as TurnRow[]); } catch { return []; }
  const by = new Map<string, ConversationSummary>();
  for (const t of rows) {
    const session = t.legacy_session ?? t.session;
    const s = by.get(session);
    const typed = t.kind !== 'result';
    if (!s) by.set(session, { session, title: typed ? titleOf(t.message) : 'Results', last: t.ts, turns: 1, lastMessage: titleOf(t.message) });
    else {
      s.last = t.ts; s.turns++; s.lastMessage = titleOf(t.message);
      if (s.title === 'Results' && typed) s.title = titleOf(t.message);
    }
  }
  return [...by.values()].sort((a, b) => b.last - a.last).slice(0, limit);
}

export function titleOf(message: string): string {
  const m = message.replace(/\s+/g, ' ').trim();
  return m.length > 80 ? `${m.slice(0, 77).replace(/\s+\S*$/, '')}…` : m;
}
