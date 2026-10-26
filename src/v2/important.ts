/**
 * The Important list ("Worth a look", v2 build, slice A9, 2026-10-26): the data. What matters from every source —
 * important mail, dated facts found inside newsletters, calendar double-bookings, job results, approvals waiting,
 * an account that needs reconnecting — one row per thing, grouped Today / This week / Earlier when read.
 *
 *   items            one row per thing worth a look. `dedupe_key` is stable per source thing (mail:<mail id>,
 *                    conflict:<a>|<b>, job:<id>:<try>, approval:<id>, reconnect:<account>:<resource>,
 *                    fact:<mail id>:<date>:<title>), so recomputing never duplicates. `state` is the person's
 *                    (open / handled / not-important / snoozed); `gone` is the source's (the conflict was resolved,
 *                    the approval answered, the mail is skipped by a rule now): a gone item is not listed, and comes
 *                    back with its state intact when its source does.
 *   item_qa          "Ask about this" answers kept under an item (slice A6 writes them; stored here so they attach).
 *   triage_verdicts  one per message: important or skip, the kind (newsletter, receipt…) and why (reason_code).
 *   triage_rules     the person's own teaching: sender / domain / list-id / kind → important or skip. Rules come
 *                    ONLY from the person's taps (Not important, This was important) — never from content.
 *   triage_calls     every model call triage made, with its cost: the daily budget is read from here.
 *
 * Every write records an event in the same transaction (entity 'item'), which drives /stream and /sync
 * (collection `important`).
 */
import { createHash } from 'node:crypto';
import { appDb, recordEvent, registerMigrations, type AppDb } from './db.js';
import { ownerOwns } from './jobs.js';
import { localDate, addDays } from '../sync/tz.js';

registerMigrations([{
  name: '007-important',
  sql: `
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('mail','newsletter','pdf','calendar-conflict','calendar-change','deadline','waiting-reply','job-result','approval','connection')),
      source_ref TEXT, dedupe_key TEXT NOT NULL UNIQUE, project_id TEXT, group_day TEXT NOT NULL, ts INTEGER NOT NULL,
      from_label TEXT, title TEXT NOT NULL, why TEXT, trust TEXT NOT NULL DEFAULT 'untrusted' CHECK (trust IN ('trusted','untrusted')),
      action_kind TEXT CHECK (action_kind IS NULL OR action_kind IN ('review-reply','add-to-calendar','draft-note','remind','open-job','reconnect','review-approval')),
      action_payload TEXT,
      state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','handled','not-important','snoozed')),
      handled_at INTEGER, person TEXT, kind TEXT, gone INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_seq INTEGER);
    CREATE INDEX IF NOT EXISTS items_ts ON items(ts);
    CREATE INDEX IF NOT EXISTS items_state ON items(state, gone);
    CREATE INDEX IF NOT EXISTS items_ref ON items(source_ref);
    CREATE TABLE IF NOT EXISTS item_qa (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, q TEXT NOT NULL, a TEXT,
      try_id TEXT, ts INTEGER NOT NULL, tainted INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS item_qa_item ON item_qa(item_id, ts);
    CREATE TABLE IF NOT EXISTS triage_verdicts (
      mail_id TEXT PRIMARY KEY, verdict TEXT NOT NULL CHECK (verdict IN ('important','skip')),
      kind TEXT NOT NULL CHECK (kind IN ('newsletter','promotion','receipt','notification','personal','work','social','other')),
      reason_code TEXT NOT NULL, why TEXT, model TEXT, cost_usd REAL NOT NULL DEFAULT 0, ts INTEGER NOT NULL, deep_read_at INTEGER);
    CREATE TABLE IF NOT EXISTS triage_rules (
      id TEXT PRIMARY KEY, match_kind TEXT NOT NULL CHECK (match_kind IN ('sender','domain','list-id','kind')), value TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('important','skip')), created_by TEXT NOT NULL DEFAULT 'person' CHECK (created_by = 'person'),
      ts INTEGER NOT NULL, UNIQUE (match_kind, value));
    CREATE TABLE IF NOT EXISTS triage_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT NOT NULL, purpose TEXT NOT NULL, model TEXT,
      n INTEGER NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS triage_calls_day ON triage_calls(day);`,
}, {
  // A9 review: a verdict remembers how often the model was asked (an unsure answer is asked again, a few times) and
  // its flags ('phishing:<reason>', 'low-trust'); an item carries a caution and the sender's address.
  name: '010-important-review',
  sql: `
    ALTER TABLE triage_verdicts ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE triage_verdicts ADD COLUMN flags TEXT;
    ALTER TABLE items ADD COLUMN caution TEXT CHECK (caution IS NULL OR caution IN ('phishing','unverified'));
    ALTER TABLE items ADD COLUMN from_addr TEXT;`,
}]);

export type ItemSource = 'mail' | 'newsletter' | 'pdf' | 'calendar-conflict' | 'calendar-change' | 'deadline' | 'waiting-reply' | 'job-result' | 'approval' | 'connection';
export type ActionKind = 'review-reply' | 'add-to-calendar' | 'draft-note' | 'remind' | 'open-job' | 'reconnect' | 'review-approval';
export type ItemState = 'open' | 'handled' | 'not-important' | 'snoozed';
export type MailKind = 'newsletter' | 'promotion' | 'receipt' | 'notification' | 'personal' | 'work' | 'social' | 'other';
export const MAIL_KINDS: readonly MailKind[] = ['newsletter', 'promotion', 'receipt', 'notification', 'personal', 'work', 'social', 'other'];
export type Group = 'today' | 'week' | 'earlier';
export const GROUPS: readonly Group[] = ['today', 'week', 'earlier'];
export const GROUP_LABEL: Record<Group, string> = { today: 'Today', week: 'This week', earlier: 'Earlier' };

export interface ItemRow {
  id: string; source: ItemSource; source_ref: string | null; dedupe_key: string; project_id: string | null; group_day: string;
  ts: number; from_label: string | null; title: string; why: string | null; trust: 'trusted' | 'untrusted';
  action_kind: ActionKind | null; action_payload: string | null; state: ItemState; handled_at: number | null;
  person: string | null; kind: string | null; gone: number; created_at: number; updated_seq: number | null;
  caution: 'phishing' | 'unverified' | null; from_addr: string | null;
}
export interface VerdictRow {
  mail_id: string; verdict: 'important' | 'skip'; kind: MailKind; reason_code: string; why: string | null; model: string | null;
  cost_usd: number; ts: number; deep_read_at: number | null; attempts: number; flags: string | null;
}
export type RuleMatch = 'sender' | 'domain' | 'list-id' | 'kind';
export interface RuleRow { id: string; match_kind: RuleMatch; value: string; verdict: 'important' | 'skip'; created_by: 'person'; ts: number }

/** An item's API id: derived from its dedupe key, so the same thing always has the same id. */
export function itemId(dedupeKey: string): string {
  return 'it_' + createHash('sha256').update(dedupeKey).digest('base64url').slice(0, 20);
}

// ── items ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a source says an item is now. The person's state is never part of it. */
export interface ItemIn {
  source: ItemSource; sourceRef?: string | null; dedupeKey: string; projectId?: string | null; ts: number;
  from?: string | null; title: string; why?: string | null; trust: 'trusted' | 'untrusted';
  action?: { kind: ActionKind; payload?: Record<string, unknown> } | null; person?: string | null; kind?: string | null;
  /** kept with the item whether or not it has an action (a fact's parsed date, so a refresh can rebuild it) */
  data?: Record<string, unknown>;
  /** 'phishing': the deterministic signal fired; 'unverified': urgent language from a bulk or no-reply sender */
  caution?: 'phishing' | 'unverified' | null;
  /** the sender's address, shown beside the display name on anything from outside */
  fromAddr?: string | null;
}

const CONTENT = ['source', 'source_ref', 'project_id', 'group_day', 'ts', 'from_label', 'title', 'why', 'trust', 'action_kind', 'action_payload', 'person', 'kind', 'caution', 'from_addr'] as const;

export function getItem(id: string, d: AppDb = appDb()): ItemRow | null {
  return (d.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined) ?? null;
}
export function itemByKey(key: string, d: AppDb = appDb()): ItemRow | null {
  return (d.prepare('SELECT * FROM items WHERE dedupe_key = ?').get(key) as ItemRow | undefined) ?? null;
}

/**
 * Insert or refresh one item from its source (and bring it back if it was gone). The person's state, the time it
 * first appeared and its id are kept; an unchanged item writes nothing and records no event. Returns the row.
 */
export function upsertItem(x: ItemIn, tz: string, now = Date.now(), d: AppDb = appDb()): ItemRow {
  const cur = itemByKey(x.dedupeKey, d);
  const ts = cur ? cur.ts : Math.round(x.ts);
  const next = {
    source: x.source, source_ref: x.sourceRef ?? null, project_id: x.projectId ?? cur?.project_id ?? null, group_day: localDate(ts, tz), ts,
    from_label: x.from ?? null, title: x.title.slice(0, 300), why: x.why ? x.why.slice(0, 300) : null, trust: x.trust,
    action_kind: x.action?.kind ?? null,
    action_payload: x.data || x.action?.payload ? JSON.stringify({ ...(x.data ?? {}), ...(x.action?.payload ?? {}) }) : null,
    person: x.person ?? null, kind: x.kind ?? null, caution: x.caution ?? null, from_addr: x.fromAddr ?? null,
  };
  if (cur && cur.gone === 0 && CONTENT.every((k) => cur[k] === next[k])) return cur;
  const id = cur?.id ?? itemId(x.dedupeKey);
  const seq = recordEvent({ entity: 'item', id }, d);
  if (cur) {
    d.prepare(`UPDATE items SET ${CONTENT.map((k) => `${k} = @${k}`).join(', ')}, gone = 0, updated_seq = @seq WHERE id = @id`).run({ ...next, seq, id });
  } else {
    d.prepare(`INSERT INTO items (id, dedupe_key, ${CONTENT.join(', ')}, state, gone, created_at, updated_seq)
               VALUES (@id, @dedupe_key, ${CONTENT.map((k) => `@${k}`).join(', ')}, 'open', 0, @now, @seq)`).run({ ...next, id, dedupe_key: x.dedupeKey, now, seq });
  }
  return getItem(id, d)!;
}

/** The source no longer applies: the item leaves the list (its state is kept for when it comes back). */
export function markGone(id: string, d: AppDb = appDb()): boolean {
  const r = d.prepare('UPDATE items SET gone = 1 WHERE id = ? AND gone = 0').run(id);
  if (!r.changes) return false;
  const seq = recordEvent({ entity: 'item', id }, d);
  d.prepare('UPDATE items SET updated_seq = ? WHERE id = ?').run(seq, id);
  return true;
}

/** Items of these sources (or whose key starts with a prefix) that are not gone: what a recompute must account for. */
export function liveItemsWhere(o: { sources?: ItemSource[]; keyPrefix?: string }, d: AppDb = appDb()): ItemRow[] {
  const where: string[] = ['gone = 0'];
  const args: unknown[] = [];
  if (o.sources?.length) { where.push(`source IN (${o.sources.map(() => '?').join(',')})`); args.push(...o.sources); }
  if (o.keyPrefix) { where.push('dedupe_key LIKE ?'); args.push(`${o.keyPrefix.replace(/[%_]/g, '')}%`); }
  return d.prepare(`SELECT * FROM items WHERE ${where.join(' AND ')}`).all(...args) as ItemRow[];
}

/** The person's state change on an item, with its event. Returns the row after, or null when there is no such item. */
export function setItemState(id: string, state: ItemState, now = Date.now(), d: AppDb = appDb()): ItemRow | null {
  return d.transaction((): ItemRow | null => {
    const cur = getItem(id, d);
    if (!cur) return null;
    if (cur.state === state) return cur;
    const seq = recordEvent({ entity: 'item', id }, d);
    d.prepare('UPDATE items SET state = ?, handled_at = ?, updated_seq = ? WHERE id = ?').run(state, state === 'open' ? null : now, seq, id);
    return getItem(id, d);
  }).immediate();
}

/** Items in a state (not gone), newest first. */
export function itemsInState(state: ItemState, d: AppDb = appDb()): ItemRow[] {
  return d.prepare('SELECT * FROM items WHERE state = ? AND gone = 0 ORDER BY ts DESC, id').all(state) as ItemRow[];
}

/** Every v1 caller acts for the owner: the owner's items only (a person column of null is the owner's). */
export function visibleItem(r: Pick<ItemRow, 'person'>): boolean { return ownerOwns(r.person); }

/** Today / This week (the six days before today) / Earlier, by the local date the item appeared. */
export function groupOf(groupDay: string, now: number, tz: string): Group {
  const today = localDate(now, tz);
  if (groupDay >= today) return 'today';
  if (groupDay >= addDays(today, -6)) return 'week';
  return 'earlier';
}

export const ACTION_LABEL: Record<ActionKind, string> = {
  'review-reply': 'Open', 'add-to-calendar': 'Add to calendar', 'draft-note': 'Draft the note', remind: 'Remind me',
  'open-job': 'Open', reconnect: 'Reconnect', 'review-approval': 'Review',
};

export function payloadOf(r: Pick<ItemRow, 'action_payload'>): Record<string, unknown> | null {
  if (!r.action_payload) return null;
  try { const p = JSON.parse(r.action_payload); return p && typeof p === 'object' ? p as Record<string, unknown> : null; } catch { return null; }
}

/** Q&A kept under an item (slice A6 writes them). */
export function itemQa(itemId: string, d: AppDb = appDb()): { id: string; q: string; a: string | null; ts: number; tainted: boolean }[] {
  return (d.prepare('SELECT id, q, a, ts, tainted FROM item_qa WHERE item_id = ? ORDER BY ts, id').all(itemId) as { id: string; q: string; a: string | null; ts: number; tainted: number }[])
    .map((r) => ({ ...r, tainted: r.tainted === 1 }));
}

/** The API shape (api/openapi.yaml ImportantItem). */
export function apiItem(r: ItemRow, now: number, tz: string, d: AppDb = appDb()) {
  const p = payloadOf(r);
  const label = r.action_kind === 'remind' && typeof p?.label === 'string' ? p.label : r.action_kind ? ACTION_LABEL[r.action_kind] : null;
  return {
    id: r.id, source: r.source, sourceRef: r.source_ref, group: groupOf(r.group_day, now, tz), day: r.group_day, ts: r.ts,
    from: r.from_label, fromAddress: r.from_addr, caution: r.caution, title: r.title, why: r.why, trust: r.trust, kind: r.kind,
    action: r.action_kind ? { kind: r.action_kind, label: label!, ...(p?.preview && typeof p.preview === 'object' ? { preview: p.preview as Record<string, unknown> } : {}) } : null,
    state: r.state, handledAt: r.handled_at, projectId: r.project_id,
    mailId: typeof p?.mailId === 'string' ? p.mailId : r.source_ref?.startsWith('m_') ? r.source_ref : null,
    qa: itemQa(r.id, d), updatedSeq: r.updated_seq ?? 0,
  };
}
export type ApiItem = ReturnType<typeof apiItem>;

// ── verdicts ───────────────────────────────────────────────────────────────────────────────────────────────────

export function getVerdict(mailId: string, d: AppDb = appDb()): VerdictRow | null {
  return (d.prepare('SELECT * FROM triage_verdicts WHERE mail_id = ?').get(mailId) as VerdictRow | undefined) ?? null;
}
export function verdictsFor(mailIds: string[], d: AppDb = appDb()): Map<string, VerdictRow> {
  const out = new Map<string, VerdictRow>();
  for (let i = 0; i < mailIds.length; i += 500) {
    const chunk = mailIds.slice(i, i + 500);
    if (!chunk.length) continue;
    for (const r of d.prepare(`SELECT * FROM triage_verdicts WHERE mail_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as VerdictRow[]) out.set(r.mail_id, r);
  }
  return out;
}
/** Store a verdict (keeps when it was deep-read unless told otherwise). No event: a verdict is not on any list by
 *  itself — the item it makes or removes records the change. */
export function putVerdict(v: Omit<VerdictRow, 'deep_read_at' | 'attempts' | 'flags'> & { deep_read_at?: number | null; attempts?: number; flags?: string | null }, d: AppDb = appDb()): void {
  d.prepare(`INSERT INTO triage_verdicts (mail_id, verdict, kind, reason_code, why, model, cost_usd, ts, deep_read_at, attempts, flags)
             VALUES (@mail_id, @verdict, @kind, @reason_code, @why, @model, @cost_usd, @ts, @deep_read_at, @attempts, @flags)
             ON CONFLICT (mail_id) DO UPDATE SET verdict = excluded.verdict, kind = excluded.kind, reason_code = excluded.reason_code,
               why = excluded.why, model = excluded.model, cost_usd = triage_verdicts.cost_usd + excluded.cost_usd, ts = excluded.ts,
               deep_read_at = COALESCE(excluded.deep_read_at, triage_verdicts.deep_read_at),
               attempts = triage_verdicts.attempts + excluded.attempts, flags = excluded.flags`)
    .run({ ...v, deep_read_at: v.deep_read_at ?? null, attempts: v.attempts ?? 0, flags: v.flags ?? null });
}
/** Forget a verdict: the message is decided again on the next refresh (a rule that decided it was deleted). */
export function dropVerdict(mailId: string, d: AppDb = appDb()): void {
  d.prepare('DELETE FROM triage_verdicts WHERE mail_id = ?').run(mailId);
}
export function markDeepRead(mailId: string, at: number, cost: number, d: AppDb = appDb()): void {
  d.prepare('UPDATE triage_verdicts SET deep_read_at = ?, cost_usd = cost_usd + ? WHERE mail_id = ?').run(at, cost, mailId);
}

// ── rules ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function listRules(d: AppDb = appDb()): RuleRow[] {
  return d.prepare('SELECT * FROM triage_rules ORDER BY ts DESC, id').all() as RuleRow[];
}
/**
 * The person's teaching: one rule per (kind of match, value) — the latest tap wins. Called only from the person's
 * own actions in the API (Not important, This was important); nothing a message says reaches here.
 */
export function putRule(match: RuleMatch, value: string, verdict: 'important' | 'skip', now = Date.now(), d: AppDb = appDb()): RuleRow {
  const v = value.trim().toLowerCase().slice(0, 300);
  if (!v) throw new Error('A rule needs a value.');
  const id = ruleIdFor(match, v);
  d.prepare(`INSERT INTO triage_rules (id, match_kind, value, verdict, created_by, ts) VALUES (?, ?, ?, ?, 'person', ?)
             ON CONFLICT (match_kind, value) DO UPDATE SET verdict = excluded.verdict, ts = excluded.ts`).run(id, match, v, verdict, now);
  return d.prepare('SELECT * FROM triage_rules WHERE match_kind = ? AND value = ?').get(match, v) as RuleRow;
}
/** A rule's id: stable per (kind of match, value). */
export function ruleIdFor(match: RuleMatch, value: string): string {
  return 'tr_' + createHash('sha256').update(`${match}\n${value.trim().toLowerCase()}`).digest('base64url').slice(0, 16);
}
export function getRule(id: string, d: AppDb = appDb()): RuleRow | null {
  return (d.prepare('SELECT * FROM triage_rules WHERE id = ?').get(id) as RuleRow | undefined) ?? null;
}
/** Undo a rule (the person's own action). Returns the rule removed, or null. */
export function deleteRule(id: string, d: AppDb = appDb()): RuleRow | null {
  const r = getRule(id, d);
  if (r) d.prepare('DELETE FROM triage_rules WHERE id = ?').run(id);
  return r;
}

// ── spend ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function recordTriageCall(c: { ts: number; day: string; purpose: string; model: string | null; n: number; tokensIn: number; tokensOut: number; costUsd: number }, d: AppDb = appDb()): void {
  d.prepare('INSERT INTO triage_calls (ts, day, purpose, model, n, tokens_in, tokens_out, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(c.ts, c.day, c.purpose, c.model, c.n, c.tokensIn, c.tokensOut, c.costUsd);
}
export function spentOn(day: string, d: AppDb = appDb()): number {
  return (d.prepare('SELECT COALESCE(SUM(cost_usd), 0) s FROM triage_calls WHERE day = ?').get(day) as { s: number }).s;
}

// ── /sync ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** How long handled and not-important items stay in the offline snapshot. */
export const HANDLED_KEEP_MS = 30 * 86_400_000;

function inSnapshot(r: ItemRow, now: number): boolean {
  if (r.gone || !visibleItem(r)) return false;
  if (r.state === 'open' || r.state === 'snoozed') return true;
  return r.handled_at != null && now - r.handled_at <= HANDLED_KEEP_MS;
}

/** The `important` collection's full snapshot. */
export function importantSnapshot(now: number, tz: string): ApiItem[] {
  const d = appDb();
  return (d.prepare('SELECT * FROM items WHERE gone = 0 ORDER BY ts DESC, id').all() as ItemRow[]).filter((r) => inSnapshot(r, now)).map((r) => apiItem(r, now, tz, d));
}

/** Item changes in a span of events, as current objects (or deletions: gone, someone else's, or aged out). */
export function importantDelta(rows: { entity: string; entity_id: string }[], now: number, tz: string): { upserts: ApiItem[]; deletes: string[] } {
  const ids = [...new Set(rows.filter((e) => e.entity === 'item').map((e) => e.entity_id))];
  const upserts: ApiItem[] = [], deletes: string[] = [];
  for (const id of ids) {
    const r = getItem(id);
    if (r && inSnapshot(r, now)) upserts.push(apiItem(r, now, tz)); else if (!r || visibleItem(r)) deletes.push(id);
  }
  return { upserts, deletes };
}

/** One item as the live stream sends it (null: send a deletion; undefined: send nothing — someone else's). */
export function itemForStream(id: string, now: number, tz: string): ApiItem | null | undefined {
  const r = getItem(id);
  if (r && !visibleItem(r)) return undefined;
  return r && inSnapshot(r, now) ? apiItem(r, now, tz) : null;
}
