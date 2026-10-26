/**
 * v2 slice A5: the conversations kept before Projects are imported into General's thread — and kept imported.
 *
 * Each conversation in conversations.jsonl gets a dated divider ("Conversation from Oct 22: <title>") with its turns
 * under it, in their order, kept together. Every turn keeps its conversation id (`legacy_session`), so the older
 * client still opens that conversation by its id, and its folder's files (serve/<id>) are listed under General.
 * Telegram conversations (`tg-…`) are not the app's and are skipped.
 *
 * Review of A5, what this guarantees:
 *   - Incremental. It runs at every start, from where it stopped: a byte offset and a line count per log, advanced in
 *     the same transaction as each batch it commits. Lines an older build appends later (a rollback, a second server,
 *     an old server still running after `mwa migrate-v2`) arrive at the next start. A partial last line (still being
 *     written) is left for next time. A log that was replaced (its first bytes differ, or it is shorter) is read again
 *     from the start, and the line keys below make that harmless.
 *   - Nothing lost, nothing doubled. Each line's key is a hash of its bytes plus its line number, so two different
 *     results posted in the same millisecond are two turns, and a line seen before is "already there" — truthfully.
 *     A finished turn fills in its run's running turn (by run id) whether the running line came in this pass or an
 *     earlier one; an offer's recorded answer rides on its offer; a conversation never gets a second divider.
 *   - Any size. The log is streamed in chunks and committed in batches; memory stays flat. Serve runs it in the
 *     background: progress is in /meta and /projects ("Importing older conversations…").
 * Lossless: the log is only read.
 */
import { createReadStream, existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { appDb, type AppDb } from './db.js';
import { GENERAL, insertTurn, finishTurn, unfinishedTurnOf, legacyId, setTurnMeta, type TurnKind, type TurnRow, type TurnMeta } from './projects.js';
import { titleOf, type ConversationTurn } from '../conversations.js';

export const CONVERSATIONS_MIGRATION = 'data-008-projects';

export interface ConversationsReport {
  /** lines read in this pass (parsed), unreadable lines, Telegram lines skipped */
  lines: number; badLines: number; telegramSkipped: number;
  /** conversations newly started in General (one divider each), turns written, running turns filled in by their end */
  conversations: number; inserted: number; finished: number;
  /** lines already imported (a re-read), offer answers folded onto their offer, answers whose offer was not found */
  existing: number; answersFolded: number; answersOrphaned: number;
  /** bytes read in this pass; where the log now stands; whether the log was read again from the start */
  bytes: number; offset: number; restarted: boolean;
}

const KINDS = new Set<TurnKind>(['chat', 'result', 'offer', 'running']);
const HEAD_BYTES = 4096;

function dayLabel(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
/** A hash of the log's first `len` bytes (at most 4 KB): the same log still starts the same way. */
function headHash(file: string, len: number): string {
  const fd = openSync(file, 'r');
  try { const b = Buffer.alloc(Math.min(len, HEAD_BYTES)); const n = readSync(fd, b, 0, b.length, 0); return createHash('sha256').update(b.subarray(0, n)).digest('hex'); }
  finally { closeSync(fd); }
}

/** What serve shows while an import runs. */
export interface ImportProgress { running: boolean; bytesDone: number; bytesTotal: number; turns: number }
let progress: ImportProgress = { running: false, bytesDone: 0, bytesTotal: 0, turns: 0 };
export function importProgress(): ImportProgress { return { ...progress }; }

interface Line { buf: Buffer; no: number }

/** One batch, in one transaction: the lines, then where the log stands. */
function applyBatch(d: AppDb, lines: Line[], file: string, endOffset: number, endLine: number, r: ConversationsReport): void {
  const head = headHash(file, endOffset);
  const groups = new Map<string, { ord: number; grp: number; divider: TurnRow; untitled: boolean }>();
  const groupOf = (legacy: string, t: ConversationTurn): { ord: number; grp: number } => {
    let g = groups.get(legacy);
    if (!g) {
      const div = d.prepare(`SELECT * FROM turns WHERE legacy_session = ? AND kind = 'divider' LIMIT 1`).get(legacy) as TurnRow | undefined
        ?? d.prepare(`SELECT * FROM turns WHERE origin_session = ? AND kind = 'divider' LIMIT 1`).get(legacy) as TurnRow | undefined;
      if (div) {
        let meta: TurnMeta = {};
        try { meta = div.meta ? JSON.parse(div.meta) : {}; } catch { /* */ }
        g = { ord: div.ord, grp: div.grp, divider: div, untitled: meta.untitled === true };
      } else {
        const typed = t.kind !== 'result';
        const divider = insertTurn({ projectId: GENERAL, legacySession: legacy, ts: t.ts, ord: t.ts, grp: 'self', kind: 'divider',
          message: `Conversation from ${dayLabel(t.ts)}: ${typed ? titleOf(String(t.message ?? '')) : 'Results'}`, reply: '', meta: typed ? {} : { untitled: true } }, d);
        r.conversations++;
        g = { ord: divider.ord, grp: divider.grp, divider, untitled: !typed };
      }
      groups.set(legacy, g);
    }
    if (g.untitled && t.kind !== 'result' && String(t.message ?? '').trim()) {
      d.prepare(`UPDATE turns SET message = ?, meta = NULL WHERE id = ?`).run(`Conversation from ${dayLabel(g.ord)}: ${titleOf(String(t.message))}`, g.divider.id);
      g.untitled = false;
    }
    return g;
  };
  const seen = d.prepare('SELECT turn_id FROM conv_import_lines WHERE key = ?');
  const keep = d.prepare('INSERT OR IGNORE INTO conv_import_lines (key, turn_id) VALUES (?, ?)');
  d.transaction(() => {
    for (const { buf, no } of lines) {
      const key = `${createHash('sha256').update(buf).digest('hex').slice(0, 32)}:${no}`;
      let t: ConversationTurn;
      try { t = JSON.parse(buf.toString('utf8')) as ConversationTurn; } catch { r.badLines++; continue; }
      if (!t || typeof t.session !== 'string' || typeof t.ts !== 'number') { r.badLines++; continue; }
      r.lines++;
      if (t.session.startsWith('tg-')) { r.telegramSkipped++; continue; }
      if (seen.get(key)) { r.existing++; continue; }
      const legacy = legacyId(t.session);
      if (t.kind === 'offer-answer') {
        const offer = t.answers !== undefined
          ? d.prepare(`SELECT * FROM turns WHERE legacy_session = ? AND kind = 'offer' AND ts = ? ORDER BY n DESC LIMIT 1`).get(legacy, t.answers) as TurnRow | undefined
            ?? d.prepare(`SELECT * FROM turns WHERE origin_session = ? AND kind = 'offer' AND ts = ? ORDER BY n DESC LIMIT 1`).get(legacy, t.answers) as TurnRow | undefined
          : undefined;
        if (offer && t.offer) { setTurnMeta(offer.id, { offer: t.offer }, d); r.answersFolded++; keep.run(key, offer.id); } else { r.answersOrphaned++; keep.run(key, null); }
        continue;
      }
      const kind = (t.kind && KINDS.has(t.kind as TurnKind) ? t.kind : 'chat') as TurnKind;
      const meta: TurnMeta = { ...(t.offer ? { offer: t.offer } : {}), ...(t.resumes !== undefined ? { resumes: t.resumes } : {}) };
      if (t.runId) {
        const mine = (row?: TurnRow) => row && (row.legacy_session === legacy || row.origin_session === legacy) ? row : undefined;
        // its run's end, whenever it arrives: the running turn is filled in, never doubled
        if (kind !== 'running') {
          const open = mine(unfinishedTurnOf(t.runId, d));
          if (open) {
            finishTurn(open, { kind, ts: t.ts, message: String(t.message ?? ''), reply: String(t.reply ?? ''), reason: t.reason ?? null, tainted: t.tainted ?? null, meta }, d);
            r.finished++; keep.run(key, open.id); continue;
          }
        } else {
          // a running line whose run already ended here (read again after its end): the same turn
          const any = mine(d.prepare('SELECT * FROM turns WHERE run_id = ? ORDER BY n DESC LIMIT 1').get(t.runId) as TurnRow | undefined);
          if (any) { r.existing++; keep.run(key, any.id); continue; }
        }
      }
      const g = groupOf(legacy, t);
      const row = insertTurn({ projectId: GENERAL, legacySession: legacy, ts: t.ts, ord: g.ord, grp: g.grp, kind, message: String(t.message ?? ''),
        reply: String(t.reply ?? ''), reason: t.reason ?? null, tainted: t.tainted ?? null, runId: t.runId ?? null, meta }, d);
      r.inserted++;
      keep.run(key, row.id);
    }
    d.prepare(`INSERT INTO conv_import_state (file, offset, line, head, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(file) DO UPDATE SET offset = excluded.offset, line = excluded.line, head = excluded.head, updated_at = excluded.updated_at`).run(file, endOffset, endLine, head, Date.now());
  }).immediate();
}

/**
 * Import what the log holds past the last pass. Streams the file; commits every `batchLines` lines (or 4 MB),
 * yielding between batches so a server keeps answering. `dryRun`: reads and counts, writes nothing (the counts of
 * turns and dividers are what a real pass would write, except that a finished turn whose running turn is in the same
 * unwritten pass is counted as a new turn).
 */
export async function importConversations(o: { file: string; d?: AppDb; batchLines?: number; dryRun?: boolean }): Promise<ConversationsReport> {
  const d = o.d ?? appDb();
  const file = resolve(o.file);
  const r: ConversationsReport = { lines: 0, badLines: 0, telegramSkipped: 0, conversations: 0, inserted: 0, finished: 0, existing: 0, answersFolded: 0, answersOrphaned: 0, bytes: 0, offset: 0, restarted: false };
  if (!existsSync(file)) return r;
  const size = statSync(file).size;
  const st = d.prepare('SELECT offset, line, head FROM conv_import_state WHERE file = ?').get(file) as { offset: number; line: number; head: string | null } | undefined;
  let offset = st?.offset ?? 0, lineNo = st?.line ?? 0;
  // the log was replaced: read it again from the start (the line keys find what is already here)
  if (st && (size < st.offset || (st.head && st.head !== headHash(file, st.offset)))) { offset = 0; lineNo = 0; r.restarted = true; }
  const startOffset = offset;
  r.offset = offset;
  if (offset >= size) return r;
  const batchLines = Math.max(1, o.batchLines ?? 2000);
  progress = { running: true, bytesDone: offset, bytesTotal: size, turns: 0 };
  if (o.dryRun) d.exec('BEGIN IMMEDIATE');
  try {
    let pending: Line[] = [];
    let pendingBytes = 0, carry: Buffer = Buffer.alloc(0), pos = offset;
    const flush = async () => {
      if (!pending.length && pos === r.offset) return;
      applyBatch(d, pending, file, pos, lineNo, r);
      r.offset = pos;
      progress = { running: true, bytesDone: pos, bytesTotal: size, turns: r.inserted };
      pending = []; pendingBytes = 0;
      await new Promise((res) => setImmediate(res));
    };
    // up to the size seen now: a line an older build is appending at this moment is read next time
    for await (const chunk of createReadStream(file, { start: offset, end: size - 1, highWaterMark: 1 << 20 })) {
      let data = carry.length ? Buffer.concat([carry, chunk as Buffer]) : chunk as Buffer;
      let start = 0;
      for (let i = data.indexOf(0x0a); i !== -1; i = data.indexOf(0x0a, start)) {
        const raw = data.subarray(start, i);
        const lineBuf = raw.length && raw[raw.length - 1] === 0x0d ? raw.subarray(0, raw.length - 1) : raw;
        pos += i - start + 1; start = i + 1; lineNo++;
        if (lineBuf.length) { pending.push({ buf: Buffer.from(lineBuf), no: lineNo }); pendingBytes += lineBuf.length; }
        if (pending.length >= batchLines || pendingBytes >= 4 * 1024 * 1024) await flush();
      }
      carry = Buffer.from(data.subarray(start));
      data = Buffer.alloc(0);
    }
    await flush();
    r.bytes = r.offset - startOffset;
    if (!o.dryRun) d.prepare('INSERT OR REPLACE INTO migrations (name, at, report) VALUES (?, ?, ?)').run(CONVERSATIONS_MIGRATION, Date.now(), JSON.stringify(r));
  } finally {
    if (o.dryRun) d.exec('ROLLBACK');
    progress = { ...progress, running: false };
  }
  return r;
}

export function describeConversationsReport(r: ConversationsReport): string {
  return `Conversations: ${r.lines} lines read (${(r.bytes / 1048576).toFixed(1)} MB${r.restarted ? ', the log was replaced so it was read from the start' : ''}): `
    + `${r.conversations} conversations started in General, ${r.inserted} turns added, ${r.finished} running turns filled in by their end, `
    + `${r.existing} already there, ${r.answersFolded} offer answers folded (${r.answersOrphaned} without their offer), ${r.telegramSkipped} Telegram lines skipped, ${r.badLines} unreadable.`;
}
