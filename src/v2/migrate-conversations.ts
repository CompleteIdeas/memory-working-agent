/**
 * v2 slice A5: the conversations the person had before Projects move into General's thread, once.
 *
 * Each conversation in conversations.jsonl becomes a dated divider ("Conversation from Oct 22: <title>") followed by
 * its turns, in their order, kept together. Every turn keeps its conversation id (`legacy_session`), so the older
 * client still opens that conversation by its id, and the files of its folder (serve/<id>) stay where they are and
 * are listed under General. Telegram conversations (`tg-…`) are not the app's and are skipped.
 *
 * Lossless: the JSONL is only read. An offer's recorded answer rides on its offer turn; a `running` turn whose finished
 * turn is in the log is that same turn (the table fills a running row in), so it is not copied twice — a running turn
 * whose run never finished is copied as it is, as the old log showed it.
 * Idempotent: each migrated turn has a unique key (legacy_session, ts, kind, run_id); a second run inserts nothing.
 * Recorded once as `data-008-projects` (serve runs it at start, before it answers anything).
 */
import { existsSync, readFileSync } from 'node:fs';
import { appDb, type AppDb } from './db.js';
import { GENERAL, insertTurn, type TurnKind } from './projects.js';
import { titleOf, type ConversationTurn } from '../conversations.js';

export const CONVERSATIONS_MIGRATION = 'data-008-projects';

export interface ConversationsReport {
  /** lines in the log (parsed), conversations found, Telegram ones skipped */
  lines: number; conversations: number; telegramSkipped: number;
  /** turns written now, dividers written now, turns already there (a re-run), running turns their finished turn replaced */
  inserted: number; dividers: number; existing: number; superseded: number;
  /** offer answers folded onto their offer turn; unreadable lines */
  answersFolded: number; badLines: number;
}

const KINDS = new Set<TurnKind>(['chat', 'result', 'offer', 'running']);

function dayLabel(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

class Rollback extends Error {}

/** Move the log's conversations into General. `dryRun`: everything inside a transaction that is rolled back (the counts
 *  are the ones a real run would produce). */
export function migrateConversations(o: { file: string; d?: AppDb; record?: boolean; dryRun?: boolean }): ConversationsReport {
  const d = o.d ?? appDb();
  const report: ConversationsReport = { lines: 0, conversations: 0, telegramSkipped: 0, inserted: 0, dividers: 0, existing: 0, superseded: 0, answersFolded: 0, badLines: 0 };
  const all: ConversationTurn[] = [];
  if (existsSync(o.file)) {
    for (const line of readFileSync(o.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line) as ConversationTurn;
        if (t && typeof t.session === 'string' && typeof t.ts === 'number') { all.push(t); report.lines++; } else report.badLines++;
      } catch { report.badLines++; }
    }
  }
  const bySession = new Map<string, ConversationTurn[]>();
  for (const t of all) { const a = bySession.get(t.session); if (a) a.push(t); else bySession.set(t.session, [t]); }
  // conversations in the order they began, so General reads oldest to newest
  const sessions = [...bySession.entries()].map(([s, ts]) => [s, ts.sort((a, b) => a.ts - b.ts)] as const).sort((a, b) => a[1][0].ts - b[1][0].ts);

  try {
    d.transaction(() => {
      for (const [session, turns] of sessions) {
        if (session.startsWith('tg-')) { report.telegramSkipped++; continue; }
        report.conversations++;
        const legacy = session.slice(0, 80);
        const answers = new Map<number, ConversationTurn['offer']>();
        for (const t of turns) if (t.kind === 'offer-answer' && t.answers !== undefined && t.offer) { answers.set(t.answers, t.offer); report.answersFolded++; }
        const finished = new Set(turns.filter((t) => t.kind !== 'running' && t.kind !== 'offer-answer' && t.runId).map((t) => t.runId));
        const kept = turns.filter((t) => {
          if (t.kind === 'offer-answer') return false;
          if (t.kind === 'running' && finished.has(t.runId)) { report.superseded++; return false; }
          return true;
        });
        if (!kept.length) continue;
        const first = kept[0].ts;
        const typed = kept.find((t) => t.kind !== 'result');
        const title = typed ? titleOf(typed.message) : 'Results';
        // ord: the conversation's first moment, plus a sliver per turn — its turns stay together under the divider
        const div = insertTurn({ projectId: GENERAL, legacySession: legacy, ts: first, ord: first, kind: 'divider', message: `Conversation from ${dayLabel(first)}: ${title}`, reply: '', migrated: true }, d);
        if (div) report.dividers++;
        kept.forEach((t, i) => {
          const kind = (t.kind && KINDS.has(t.kind as TurnKind) ? t.kind : 'chat') as TurnKind;
          const offer = kind === 'offer' ? answers.get(t.ts) ?? t.offer : undefined;
          const row = insertTurn({
            projectId: GENERAL, legacySession: legacy, ts: t.ts, ord: first + (i + 1) / 1000, kind, message: String(t.message ?? ''), reply: String(t.reply ?? ''),
            reason: t.reason ?? null, tainted: t.tainted ?? null, runId: t.runId ?? null,
            meta: { ...(offer ? { offer } : {}), ...(t.resumes !== undefined ? { resumes: t.resumes } : {}) }, migrated: true,
          }, d);
          if (row) report.inserted++; else report.existing++;
        });
      }
      if (o.dryRun) throw new Rollback('dry run');
      if (o.record !== false) d.prepare('INSERT OR REPLACE INTO migrations (name, at, report) VALUES (?, ?, ?)').run(CONVERSATIONS_MIGRATION, Date.now(), JSON.stringify(report));
    }).immediate();
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
  return report;
}

/** Once (recorded as data-008-projects). Null when it already ran. */
export function migrateConversationsOnce(o: { file: string; d?: AppDb }): ConversationsReport | null {
  const d = o.d ?? appDb();
  if (d.prepare('SELECT 1 FROM migrations WHERE name = ?').get(CONVERSATIONS_MIGRATION)) return null;
  return migrateConversations({ ...o, d, record: true });
}

export function describeConversationsReport(r: ConversationsReport): string {
  return `Conversations: ${r.conversations} moved into General (${r.dividers} dividers, ${r.inserted} turns; ${r.existing} already there), ${r.telegramSkipped} Telegram skipped, `
    + `${r.superseded} running turns replaced by their finished turn, ${r.answersFolded} offer answers folded, ${r.badLines} unreadable lines.`;
}
