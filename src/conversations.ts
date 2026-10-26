/**
 * BL-71d — conversations you can go back to. The chat on screen lived only in the browser tab, and the
 * server's thread only in memory, so a reload, a deploy or another device started blank (Robert, 2026-10-22:
 * "you can't go back immediately and continue a conversation").
 *
 * v2 slice A5 (2026-10-26): turns live in app.db's `turns` table now, one continuous thread per Project
 * (src/v2/projects.ts). The functions below keep their old signatures, so serve.ts's callers did not change:
 *   - a session `p-<projectId>` is that project's thread. Reading it returns the turns SENT in that thread — not the
 *     older conversations shown in it under their dividers (review of A5: those are other topics, and reading them
 *     back put another conversation's words into this one's model context);
 *   - any other session (`web-…`, an older client's conversation) is kept in General, with the conversation's own id
 *     in `legacy_session`; reading that session returns just its turns, and they show in General's thread;
 *   - a project that is archived takes no new turns: they go to General, saying so.
 * conversations.jsonl is no longer written; src/v2/migrate-conversations.ts imports it (and whatever an older build
 * still appends to it). Telegram sessions (`tg-…`) were never part of the app's conversations and are not kept here.
 *
 * `path`: the log's location, as before. Left out (or the configured one), the app database is used; a test naming
 * its own path gets its own database beside it, opened for the call and closed after.
 */
import { dirname, join, resolve } from 'node:path';
import { runLogPath } from './paths.js';
import { log } from './logger.js';
import { appDb, openAppDbAt, type AppDb } from './v2/db.js';
import {
  GENERAL, getProject, projectOfSession, writeTurn, setTurnMeta, legacyId, THREAD_ORDER_DESC,
  type TurnRow, type TurnMeta, type Provenance,
} from './v2/projects.js';

export interface ConversationTurn {
  ts: number; session: string; message: string; reply: string; reason?: string;
  /** the turn read outside content: it goes back into the model's context only fenced */
  tainted?: boolean;
  /** a scheduled or background result posted into this conversation, not a turn the person typed; `running` is a
   *  turn whose run has started and not finished (F09, 2026-10-24) — the page re-attaches to it after a reload.
   *  `divider` (A5): the heading of an imported conversation. */
  kind?: 'chat' | 'result' | 'offer' | 'running' | 'offer-answer' | 'divider';
  /** the live run this turn belongs to: the `running` turn and its finished turn share it */
  runId?: string;
  /** on an `offer` turn, how the person answered it. Pending list 2026-10-26, item 3a. */
  offer?: { answered: 'background' | 'now'; goal?: string; at: number };
  /** on an `offer-answer` record (the JSONL log only): the `ts` of the offer turn it answers */
  answers?: number;
  /** on a chat turn that resumed a stopped run (3b): the `ts` of the stopped turn whose words it continued */
  resumes?: number;
  /** A5: the turn's id and project (set when read back), and where the memories its answer used came from */
  id?: string;
  projectId?: string;
  provenance?: Provenance[];
  /** A5: the Job this turn's run made (moving the turn moves the job) */
  job?: string;
  /** A6: what the turn asked about (an item, an event, a job) */
  about?: { kind: string; id: string };
  /** A6: the words came from the browser's speech recognition (kept for later analytics) */
  source?: 'voice';
}
export interface ConversationSummary { session: string; title: string; last: number; turns: number; lastMessage: string }

/** Where the old JSON-lines log is (imported by src/v2/migrate-conversations.ts): MWA_CONVERSATIONS, else beside the run log. */
export function conversationsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MWA_CONVERSATIONS ?? join(dirname(runLogPath(env)), 'conversations.jsonl');
}

/** The database for a call: the app's, or (a path of its own) one beside that path, closed after. */
function withStore<T>(path: string | undefined, fn: (d: AppDb) => T): T {
  if (path === undefined || resolve(path) === resolve(conversationsPath())) return fn(appDb());
  const d = openAppDbAt(`${path}.sqlite`);
  try { return fn(d); } finally { d.close(); }
}

/** Where a session's turn goes: its project's thread; General for anything else (keeping the conversation's id); and
 *  General, saying so, for a project that is archived. */
function placeOf(session: string, d: AppDb): { projectId: string; legacySession: string | null; archivedFrom?: { id: string; name: string } } {
  const pid = projectOfSession(session);
  const p = pid ? getProject(pid, d) : undefined;
  if (p && !p.archived) return { projectId: p.id, legacySession: null };
  if (p) return { projectId: GENERAL, legacySession: null, archivedFrom: { id: p.id, name: p.name } };
  return { projectId: GENERAL, legacySession: session };
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
    ...(meta.job ? { job: meta.job } : {}),
    ...(meta.source ? { source: meta.source } : {}),
    ...(prov.length ? { provenance: prov } : {}),
    ...(r.about_kind && r.about_id ? { about: { kind: r.about_kind, id: r.about_id } } : {}),
  };
}

/** A write that meets another process's lock (SQLITE_BUSY after the 5 s busy timeout) is tried again with a pause. */
export function retryBusy<T>(fn: () => T, what: string): T {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      const code = String((e as { code?: string }).code ?? '');
      if (!code.startsWith('SQLITE_BUSY') || i >= 3) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * 2 ** i);
      log('warn', 'conversations', `${what}: the database was busy, trying again`, { attempt: i + 1 });
    }
  }
}

/** Keep one turn. A chat never fails because its turn couldn't be written — but a failure is logged loudly. Returns
 *  its id. */
export function appendTurn(t: ConversationTurn, path?: string): string | undefined {
  if (t.session.startsWith('tg-') || t.kind === 'offer-answer') return undefined;
  try {
    return retryBusy(() => withStore(path, (d) => {
      const place = placeOf(t.session, d);
      const note = place.archivedFrom ? `\n\n(Kept in General: ${place.archivedFrom.name} is archived.)` : '';
      return writeTurn({
        projectId: place.projectId, legacySession: place.legacySession, ts: t.ts,
        kind: (t.kind ?? 'chat') as Exclude<ConversationTurn['kind'], 'offer-answer' | undefined>, message: t.message,
        reply: t.kind === 'running' ? t.reply : t.reply + note,
        reason: t.reason ?? null, tainted: t.tainted ?? null, runId: t.runId ?? null, provenance: t.provenance ?? null, about: t.about ?? null,
        meta: { ...(t.offer ? { offer: t.offer } : {}), ...(t.resumes !== undefined ? { resumes: t.resumes } : {}), ...(t.job ? { job: t.job } : {}), ...(t.source ? { source: t.source } : {}),
          ...(place.archivedFrom ? { archivedFrom: place.archivedFrom.id } : {}) },
      }, d).id;
    }), 'keeping a turn');
  } catch (e) {
    log('error', 'conversations', 'A TURN COULD NOT BE KEPT: it will be missing from the conversation', { session: t.session.slice(0, 80), kind: t.kind, error: (e as Error).message.slice(0, 200) });
    console.error(`[conversations] a turn could not be kept (${t.session.slice(0, 40)}): ${(e as Error).message.slice(0, 160)}`);
    return undefined;
  }
}

/** A session's own turns, newest first (`limit` of them): a thread's sent turns, or an older conversation's. */
function sessionRows(d: AppDb, session: string, limit: number): TurnRow[] {
  const thread = projectOfSession(session) && getProject(projectOfSession(session)!, d);
  return (thread
    ? d.prepare(`SELECT * FROM turns WHERE session = ? AND legacy_session IS NULL AND kind != 'divider' ORDER BY ${THREAD_ORDER_DESC} LIMIT ?`).all(session, limit)
    : d.prepare(`SELECT * FROM turns WHERE legacy_session = ? AND kind != 'divider' ORDER BY ${THREAD_ORDER_DESC} LIMIT ?`).all(legacyId(session), limit)) as TurnRow[];
}

/** The person answered the conversation's latest unanswered offer: "Work on it" (background, with the goal it made)
 *  or "do it here" (now). The answer rides on the offer turn. Returns the offer's ts, or null when nothing was waiting. */
export function answerOffer(session: string, answered: 'background' | 'now', goal?: string, path?: string, now = Date.now(), message?: string): number | null {
  try {
    return withStore(path, (d) => {
      const offers = (projectOfSession(session) && getProject(projectOfSession(session)!, d)
        ? d.prepare(`SELECT * FROM turns WHERE session = ? AND kind = 'offer' AND legacy_session IS NULL ORDER BY ord DESC LIMIT 50`).all(session)
        : d.prepare(`SELECT * FROM turns WHERE legacy_session = ? AND kind = 'offer' ORDER BY ord DESC LIMIT 50`).all(legacyId(session))) as TurnRow[];
      const open = offers.filter((r) => !toTurn(r).offer);
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
  try { return withStore(path, (d) => sessionRows(d, session, limit).reverse().map(toTurn)); } catch { return []; }
}

/** Conversations, most recently active first, titled by the first thing typed. A project's thread is one of them.
 *  Grouped in SQL on an index: no message bodies are read but the two shown. */
export function listConversations(limit = 30, path?: string): ConversationSummary[] {
  try {
    return withStore(path, (d) => {
      // the most recently active conversations: walk the newest turns until `limit` different ones are found
      const keys: { k: string; last: number }[] = [];
      const seenKeys = new Set<string>();
      for (const row of d.prepare(`SELECT COALESCE(legacy_session, session) k, ts FROM turns WHERE kind != 'divider' ORDER BY ts DESC`).iterate() as Iterable<{ k: string; ts: number }>) {
        if (seenKeys.has(row.k)) continue;
        seenKeys.add(row.k); keys.push({ k: row.k, last: row.ts });
        if (keys.length >= limit) break;
      }
      const countOf = d.prepare(`SELECT COUNT(*) n FROM turns WHERE COALESCE(legacy_session, session) = ? AND kind != 'divider'`);
      const groups = keys.map((g) => ({ ...g, turns: (countOf.get(g.k) as { n: number }).n }));
      const lastMsg = d.prepare(`SELECT substr(message, 1, 400) m FROM turns WHERE COALESCE(legacy_session, session) = ? AND kind != 'divider' ORDER BY ts DESC, n DESC LIMIT 1`);
      const firstTyped = d.prepare(`SELECT substr(message, 1, 400) m FROM turns WHERE COALESCE(legacy_session, session) = ? AND kind != 'divider' AND kind != 'result' ORDER BY ts, n LIMIT 1`);
      return groups.map((g) => {
        const typed = firstTyped.get(g.k) as { m: string } | undefined;
        return { session: g.k, title: typed ? titleOf(typed.m) : 'Results', last: g.last, turns: g.turns, lastMessage: titleOf((lastMsg.get(g.k) as { m: string } | undefined)?.m ?? '') };
      });
    });
  } catch { return []; }
}

export function titleOf(message: string): string {
  const m = message.replace(/\s+/g, ' ').trim();
  return m.length > 80 ? `${m.slice(0, 77).replace(/\s+\S*$/, '')}…` : m;
}
