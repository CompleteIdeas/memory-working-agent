/**
 * v2 slice A5: Projects and their threads.
 *
 * A Project is one of the person's groupings — Eventing, Family & school, AI newsletter — plus General, which always
 * exists and catches whatever has no better home. Each project has ONE continuous thread (its `turns`), its notes and
 * files (the thread's folder), and the jobs working for it (jobs.project_id). A thread's session is `p-<projectId>`:
 * the live run, the working folder (serve/p-<id>) and the memory's `session=` tag all use it, so a memory written
 * during a project's runs says which project it came from.
 *
 * Turns live in app.db (they were conversations.jsonl, which src/conversations.ts still reads for the one-time
 * migration). A chat turn holds the person's message AND the reply, so moving it moves both. A `running` turn is the
 * same row its finished turn later fills in (by run id), so a turn keeps its id from the moment it is sent.
 *
 * Routing (suggestProject): the message is embedded with the model AWM already loads for recall and compared with
 * each project's name and the centroid of its last 20 messages. Inside a project the answer is that project unless
 * another matches strongly — then a hint, never a switch. From Now/Today or General: a suggestion, or "not sure"
 * (General) when the match is weak or two projects are close.
 *
 * Cross-talk provenance (crossTalk): the memories a run actually used carry the `session=` of the run that wrote
 * them; each project other than the current one is counted on the turn, and the app shows a quiet "using what I know
 * from Eventing" under the answer.
 *
 * Every write records an event (the sync cursor) in the same transaction.
 */
import { randomBytes } from 'node:crypto';
import { appDb, registerMigrations, recordEvent, type AppDb, type Migration } from './db.js';
import { loadEmbeddings } from '../awm-api.js';

export const GENERAL = 'general';

export const PROJECTS_MIGRATION: Migration = {
  name: '008-projects',
  sql: `
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      created_at INTEGER NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      -- decision D6 (a project kept out of cross-talk) is deferred: the column exists, nothing reads it yet
      private INTEGER NOT NULL DEFAULT 0,
      updated_seq INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS projects_seq ON projects(updated_seq);
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      -- p-<projectId>; a turn from an older client keeps its own conversation id in legacy_session
      session TEXT NOT NULL,
      legacy_session TEXT,
      ts INTEGER NOT NULL,
      -- the thread's order: the time it was sent, except migrated conversations, which stay together under their divider
      ord REAL NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('chat','result','offer','running','divider')),
      message TEXT NOT NULL DEFAULT '',
      reply TEXT NOT NULL DEFAULT '',
      reason TEXT,
      -- 1: it read outside content (carried back only fenced); NULL: no record (older turns count as tainted)
      tainted INTEGER,
      run_id TEXT,
      try_id TEXT,
      about_kind TEXT,
      about_id TEXT,
      -- [{projectId, n}]: other projects whose memories this answer used
      provenance TEXT,
      -- {offer, resumes}: how an offer was answered; which stopped turn a resume continued
      meta TEXT,
      moved_from TEXT,
      migrated INTEGER NOT NULL DEFAULT 0,
      updated_seq INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS turns_project ON turns(project_id, ord);
    CREATE INDEX IF NOT EXISTS turns_session ON turns(session, ord);
    CREATE INDEX IF NOT EXISTS turns_legacy ON turns(legacy_session, ord);
    CREATE INDEX IF NOT EXISTS turns_run ON turns(run_id);
    CREATE INDEX IF NOT EXISTS turns_seq ON turns(updated_seq);
    -- the conversation migration's key: a second run finds what the first one wrote
    CREATE UNIQUE INDEX IF NOT EXISTS turns_legacy_key ON turns(legacy_session, ts, kind, COALESCE(run_id, '')) WHERE migrated = 1;
    INSERT OR IGNORE INTO projects (id, name, icon, created_at, sort) VALUES ('general', 'General', 'chat', CAST(strftime('%s','now') AS INTEGER) * 1000, 0);
    INSERT INTO events (ts, entity, entity_id, op) VALUES (CAST(strftime('%s','now') AS INTEGER) * 1000, 'project', 'general', 'upsert');
    UPDATE projects SET updated_seq = last_insert_rowid() WHERE id = 'general';`,
};
registerMigrations([PROJECTS_MIGRATION]);

// ── Rows and shapes ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ProjectRow { id: string; name: string; icon: string | null; created_at: number; sort: number; archived: number; private: number; updated_seq: number }
export type TurnKind = 'chat' | 'result' | 'offer' | 'running' | 'divider';
export interface TurnRow {
  id: string; project_id: string; session: string; legacy_session: string | null; ts: number; ord: number; kind: TurnKind;
  message: string; reply: string; reason: string | null; tainted: number | null; run_id: string | null; try_id: string | null;
  about_kind: string | null; about_id: string | null; provenance: string | null; meta: string | null; moved_from: string | null;
  migrated: number; updated_seq: number;
}
export interface Provenance { projectId: string; n: number }
export interface TurnMeta {
  offer?: { answered: 'background' | 'now'; goal?: string; at: number };
  resumes?: number;
}

export const sessionOf = (projectId: string) => `p-${projectId}`;
/** The project a thread session names (`p-<id>`), or null for any other session. */
export function projectOfSession(session: string | null | undefined): string | null {
  return session && session.startsWith('p-') && session.length > 2 ? session.slice(2) : null;
}

const MAX_TEXT = 20_000;
const newId = (p: 'pr' | 'tu') => `${p}_${randomBytes(6).toString('hex')}`;
const parse = <T>(s: string | null): T | null => { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } };

export function apiProject(p: ProjectRow) {
  return { id: p.id, name: p.name, icon: p.icon, createdAt: p.created_at, sort: p.sort, archived: p.archived === 1, general: p.id === GENERAL, updatedSeq: p.updated_seq };
}
export function apiTurn(t: TurnRow, d: AppDb = appDb()) {
  const meta = parse<TurnMeta>(t.meta) ?? {};
  const prov = parse<Provenance[]>(t.provenance) ?? [];
  return {
    id: t.id, projectId: t.project_id, kind: t.kind, ts: t.ts, message: t.message, reply: t.reply, reason: t.reason,
    tainted: t.tainted == null ? null : t.tainted === 1, runId: t.run_id, tryId: t.try_id,
    about: t.about_kind && t.about_id ? { kind: t.about_kind, id: t.about_id } : null,
    // the names travel with the ids: "using what I know from Eventing" needs no second request
    provenance: prov.map((p) => ({ projectId: p.projectId, name: getProject(p.projectId, d)?.name ?? p.projectId, n: p.n })),
    offer: meta.offer ?? null, legacySession: t.legacy_session, movedFrom: t.moved_from, updatedSeq: t.updated_seq,
  };
}

// ── Projects ────────────────────────────────────────────────────────────────────────────────────────────────────

function bumpProject(d: AppDb, id: string): void {
  const seq = recordEvent({ entity: 'project', id }, d);
  d.prepare('UPDATE projects SET updated_seq = ? WHERE id = ?').run(seq, id);
}
function bumpTurn(d: AppDb, id: string, projectId: string, op: 'upsert' | 'delete' = 'upsert'): void {
  const seq = recordEvent({ entity: 'turn', id, op, payload: { project: projectId } }, d);
  if (op === 'upsert') d.prepare('UPDATE turns SET updated_seq = ? WHERE id = ?').run(seq, id);
}

export function getProject(id: string, d: AppDb = appDb()): ProjectRow | undefined {
  return d.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
}
/** Projects in the person's order (General first), archived ones only when asked. */
export function listProjects(o: { archived?: boolean } = {}, d: AppDb = appDb()): ProjectRow[] {
  return d.prepare(`SELECT * FROM projects ${o.archived ? '' : 'WHERE archived = 0'} ORDER BY (id = 'general') DESC, sort, created_at`).all() as ProjectRow[];
}

export class ProjectError extends Error { constructor(public code: 'bad_name' | 'name_taken' | 'not_found' | 'general' | 'archived', message: string) { super(message); } }

const cleanName = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
const cleanIcon = (s: unknown) => { const v = String(s ?? '').trim(); return /^[a-z0-9-]{1,24}$/i.test(v) ? v : null; };
function nameTaken(d: AppDb, name: string, except?: string): boolean {
  return !!d.prepare(`SELECT 1 FROM projects WHERE archived = 0 AND lower(name) = lower(?) AND id != ?`).get(name, except ?? '');
}

export function createProject(p: { name: string; icon?: string | null; now?: number }, d: AppDb = appDb()): ProjectRow {
  const name = cleanName(p.name);
  if (!name) throw new ProjectError('bad_name', 'Give the project a name.');
  return d.transaction(() => {
    if (nameTaken(d, name)) throw new ProjectError('name_taken', `You already have a project called ${name}.`);
    const id = newId('pr');
    const sort = ((d.prepare('SELECT MAX(sort) m FROM projects').get() as { m: number | null }).m ?? 0) + 1;
    d.prepare('INSERT INTO projects (id, name, icon, created_at, sort) VALUES (?, ?, ?, ?, ?)').run(id, name, cleanIcon(p.icon), p.now ?? Date.now(), sort);
    bumpProject(d, id);
    return getProject(id, d)!;
  }).immediate();
}

/** Rename, change the icon, archive or restore. General can be renamed but never archived. */
export function updateProject(id: string, f: { name?: string; icon?: string | null; archived?: boolean; sort?: number }, d: AppDb = appDb()): ProjectRow {
  return d.transaction(() => {
    const p = getProject(id, d);
    if (!p) throw new ProjectError('not_found', 'No such project.');
    const sets: string[] = [], vals: unknown[] = [];
    if (f.name !== undefined) {
      const name = cleanName(f.name);
      if (!name) throw new ProjectError('bad_name', 'Give the project a name.');
      if (nameTaken(d, name, id)) throw new ProjectError('name_taken', `You already have a project called ${name}.`);
      sets.push('name = ?'); vals.push(name);
    }
    if (f.icon !== undefined) { sets.push('icon = ?'); vals.push(f.icon === null ? null : cleanIcon(f.icon)); }
    if (f.sort !== undefined && Number.isInteger(f.sort)) { sets.push('sort = ?'); vals.push(f.sort); }
    if (f.archived !== undefined) {
      if (id === GENERAL && f.archived) throw new ProjectError('general', 'General is where everything without a project goes. It cannot be archived.');
      if (!f.archived && nameTaken(d, p.name, id)) throw new ProjectError('name_taken', `Another project is called ${p.name} now. Rename one of them first.`);
      sets.push('archived = ?'); vals.push(f.archived ? 1 : 0);
    }
    if (sets.length) {
      d.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
      bumpProject(d, id);
    }
    return getProject(id, d)!;
  }).immediate();
}

// ── Turns ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface NewTurn {
  projectId: string; ts: number; kind: TurnKind; message: string; reply: string; reason?: string | null; tainted?: boolean | null;
  runId?: string | null; tryId?: string | null; about?: { kind: string; id: string } | null; provenance?: Provenance[] | null;
  meta?: TurnMeta | null; legacySession?: string | null; ord?: number; migrated?: boolean;
}

export function getTurn(id: string, d: AppDb = appDb()): TurnRow | undefined {
  return d.prepare('SELECT * FROM turns WHERE id = ?').get(id) as TurnRow | undefined;
}

/** Insert one turn (inside the caller's transaction, or its own). Returns it, or undefined when a migrated key exists. */
export function insertTurn(t: NewTurn, d: AppDb = appDb()): TurnRow | undefined {
  const id = newId('tu');
  const r = d.prepare(`INSERT ${t.migrated ? 'OR IGNORE ' : ''}INTO turns (id, project_id, session, legacy_session, ts, ord, kind, message, reply, reason, tainted, run_id, try_id, about_kind, about_id, provenance, meta, migrated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, t.projectId, sessionOf(t.projectId), t.legacySession ?? null, t.ts, t.ord ?? t.ts, t.kind,
    String(t.message ?? '').slice(0, MAX_TEXT), String(t.reply ?? '').slice(0, MAX_TEXT), t.reason ?? null, t.tainted == null ? null : t.tainted ? 1 : 0,
    t.runId ?? null, t.tryId ?? null, t.about?.kind ?? null, t.about?.id ?? null, t.provenance?.length ? JSON.stringify(t.provenance) : null,
    t.meta && Object.keys(t.meta).length ? JSON.stringify(t.meta) : null, t.migrated ? 1 : 0);
  if (!r.changes) return undefined;
  bumpTurn(d, id, t.projectId);
  return getTurn(id, d);
}

/**
 * Write a turn. A finished turn whose run already has a `running` turn fills that same row in (its id stays, its
 * place in the thread stays — and a move made while the answer was being written is kept).
 */
export function writeTurn(t: NewTurn, d: AppDb = appDb()): TurnRow | undefined {
  return d.transaction(() => {
    if (t.runId && t.kind !== 'running') {
      const running = d.prepare(`SELECT * FROM turns WHERE run_id = ? AND kind = 'running' ORDER BY ord DESC LIMIT 1`).get(t.runId) as TurnRow | undefined;
      if (running) {
        const meta = { ...(parse<TurnMeta>(running.meta) ?? {}), ...(t.meta ?? {}) };
        d.prepare(`UPDATE turns SET kind = ?, ts = ?, message = ?, reply = ?, reason = ?, tainted = ?, try_id = COALESCE(?, try_id), provenance = ?, meta = ? WHERE id = ?`)
          .run(t.kind, t.ts, String(t.message ?? '').slice(0, MAX_TEXT), String(t.reply ?? '').slice(0, MAX_TEXT), t.reason ?? null, t.tainted == null ? null : t.tainted ? 1 : 0,
            t.tryId ?? null, t.provenance?.length ? JSON.stringify(t.provenance) : null, Object.keys(meta).length ? JSON.stringify(meta) : null, running.id);
        bumpTurn(d, running.id, running.project_id);
        return getTurn(running.id, d);
      }
    }
    return insertTurn(t, d);
  }).immediate();
}

/** Set an offer turn's answer (how the person chose: background or here). */
export function setTurnMeta(id: string, meta: TurnMeta, d: AppDb = appDb()): void {
  d.transaction(() => {
    const t = getTurn(id, d);
    if (!t) return;
    d.prepare('UPDATE turns SET meta = ? WHERE id = ?').run(JSON.stringify({ ...(parse<TurnMeta>(t.meta) ?? {}), ...meta }), id);
    bumpTurn(d, id, t.project_id);
  }).immediate();
}

/** Record which other projects' memories an answer used. */
export function setProvenance(id: string, prov: Provenance[], d: AppDb = appDb()): void {
  d.transaction(() => {
    const t = getTurn(id, d);
    if (!t) return;
    d.prepare('UPDATE turns SET provenance = ? WHERE id = ?').run(prov.length ? JSON.stringify(prov) : null, id);
    bumpTurn(d, id, t.project_id);
  }).immediate();
}

/** A project's thread, oldest first: the `limit` turns before `before` (a turn id), or the latest. `next` pages back. */
export function threadPage(projectId: string, o: { before?: string; limit?: number } = {}, d: AppDb = appDb()): { turns: TurnRow[]; next: string | null } {
  const limit = Math.max(1, Math.min(200, o.limit ?? 50));
  let rows: TurnRow[];
  if (o.before) {
    const b = d.prepare('SELECT ord, rowid r FROM turns WHERE id = ? AND project_id = ?').get(o.before, projectId) as { ord: number; r: number } | undefined;
    if (!b) return { turns: [], next: null };
    rows = d.prepare(`SELECT * FROM turns WHERE project_id = ? AND (ord < ? OR (ord = ? AND rowid < ?)) ORDER BY ord DESC, rowid DESC LIMIT ?`).all(projectId, b.ord, b.ord, b.r, limit + 1) as TurnRow[];
  } else {
    rows = d.prepare(`SELECT * FROM turns WHERE project_id = ? ORDER BY ord DESC, rowid DESC LIMIT ?`).all(projectId, limit + 1) as TurnRow[];
  }
  const more = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  return { turns: page, next: more && page.length ? page[0].id : null };
}

/** The latest turns of every active project (the /sync snapshot). */
export function recentTurns(perProject = 50, d: AppDb = appDb()): TurnRow[] {
  return listProjects({}, d).flatMap((p) => threadPage(p.id, { limit: perProject }, d).turns);
}

export class MoveError extends Error { constructor(public code: 'not_found' | 'not_movable' | 'running' | 'archived' | 'same', message: string) { super(message); } }

/**
 * Move a turn — the person's message and its answer, which are one row — to another project. The thread it leaves
 * and the one it joins both see the change; `moved_from` remembers where it was, so Undo is a move back.
 */
export function moveTurn(id: string, toProjectId: string, d: AppDb = appDb()): { turn: TurnRow; from: string } {
  return d.transaction(() => {
    const t = getTurn(id, d);
    if (!t) throw new MoveError('not_found', 'No such message.');
    if (t.kind === 'divider') throw new MoveError('not_movable', 'That is a divider, not a message.');
    if (t.kind === 'running') throw new MoveError('running', 'The answer is still being written. Move it once it is done.');
    const to = getProject(toProjectId, d);
    if (!to) throw new MoveError('not_found', 'No such project.');
    if (to.archived) throw new MoveError('archived', `${to.name} is archived. Restore it first.`);
    if (t.project_id === to.id) throw new MoveError('same', `It is already in ${to.name}.`);
    d.prepare('UPDATE turns SET project_id = ?, session = ?, moved_from = ? WHERE id = ?').run(to.id, sessionOf(to.id), t.project_id, id);
    bumpTurn(d, id, to.id);
    return { turn: getTurn(id, d)!, from: t.project_id };
  }).immediate();
}

// ── Cross-talk provenance ───────────────────────────────────────────────────────────────────────────────────────

/** The project a memory came from, by the `session=` its writing run had: a thread session names it; an older
 *  conversation's session is found among the migrated turns (General, unless a turn of it was moved). */
export function projectOfMemorySession(session: string | null | undefined, d: AppDb = appDb()): string | null {
  if (!session) return null;
  const p = projectOfSession(session);
  if (p) return getProject(p, d) ? p : null;
  const row = d.prepare(`SELECT project_id FROM turns WHERE legacy_session = ? GROUP BY project_id ORDER BY COUNT(*) DESC LIMIT 1`).get(session) as { project_id: string } | undefined;
  return row?.project_id ?? null;
}

/** The other projects whose memories a run used, with how many of each — most first. */
export function crossTalk(used: { id: string; session?: string | null }[], currentProjectId: string, d: AppDb = appDb()): Provenance[] {
  const counts = new Map<string, Set<string>>();
  for (const u of used) {
    const p = projectOfMemorySession(u.session, d);
    if (!p || p === currentProjectId) continue;
    const s = counts.get(p) ?? new Set<string>();
    s.add(u.id); counts.set(p, s);
  }
  return [...counts.entries()].map(([projectId, s]) => ({ projectId, n: s.size })).sort((a, b) => b.n - a.n || a.projectId.localeCompare(b.projectId));
}

// ── Routing suggestion ──────────────────────────────────────────────────────────────────────────────────────────

export type Embedder = (text: string) => Promise<number[]>;
let embedder: Embedder | null = null;
/** Tests: a stub embedder (null restores the model AWM loads for recall). */
export function setEmbedder(e: Embedder | null): void { embedder = e; vecCache.clear(); }
async function embed(text: string): Promise<number[]> {
  if (embedder) return embedder(text);
  return (await loadEmbeddings()).embed(text);
}

const vecCache = new Map<string, number[]>();
const VEC_CACHE_MAX = 4000;
async function cachedVec(key: string, text: string): Promise<number[]> {
  const hit = vecCache.get(key);
  if (hit) return hit;
  const v = await embed(text);
  if (vecCache.size >= VEC_CACHE_MAX) vecCache.delete(vecCache.keys().next().value as string);
  vecCache.set(key, v);
  return v;
}
function cos(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** What a project's thread is about: the person's last 20 messages there. */
function recentMessages(projectId: string, d: AppDb): { id: string; text: string }[] {
  return (d.prepare(`SELECT id, message FROM turns WHERE project_id = ? AND kind IN ('chat','offer','running') AND message != '' ORDER BY ord DESC, rowid DESC LIMIT 20`)
    .all(projectId) as { id: string; message: string }[]).map((r) => ({ id: r.id, text: r.message.slice(0, 500) }));
}

const STOP = new Set(('about after again also and any are been before being but can could did does doing done for from get got had has have '
  + 'her here him his how into its just know like make many more most much need next now off once only other our out over own please same '
  + 'she should some still such than that the their them then there these they thing things this those through today tomorrow too under until '
  + 'very want was week were what when where which while who why will with would you your yours yes okay thanks thank help tell find show '
  + 'remind give send write check look let me my mine ours we us it').split(' '));
/** The words that can tell projects apart: lower case, 3+ letters, no common words, a plural's "s" dropped. */
export function routingTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of String(text).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z][a-z0-9]{2,}/g) ?? []) {
    if (STOP.has(w)) continue;
    out.add(w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
  }
  return out;
}

/**
 * The weights and thresholds, tuned on tests/fixtures/routing-40.json with bge-small-en-v1.5 (AWM's recall model);
 * scripts/tune-routing.mts prints the grid. A project's score is
 *   NAME_WEIGHT·cos(message, name) + (1−NAME_WEIGHT)·cos(message, centroid of its last 20 messages)
 *   + LEX_WEIGHT·Σ idf(word) over the message's words its name or thread also uses (idf = ln(projects / projects using it)).
 * The lexical part is what lets a vague message stay vague: the embedding alone scores "Thanks, that's helpful" as
 * close to some project as a real request. Then:
 *   SUGGEST — the best score must reach this to be suggested at all;
 *   MARGIN  — and lead the runner-up by this much, or it is "not sure" (General);
 *   HINT    — inside a project, another project is hinted only when it beats this one by this much (and is suggestable).
 */
export const ROUTING = { NAME_WEIGHT: 0.2, LEX_WEIGHT: 0.06, SUGGEST: 0.5, MARGIN: 0.04, HINT: 0.06 };

export interface Suggestion {
  projectId: string;
  confidence: 'suggested' | 'not sure' | 'this project';
  alternatives: { projectId: string; name: string; score: number }[];
}
export interface ProjectScore { project: ProjectRow; byName: number; byThread: number | null; lex: number; score: number }

/** The parts of every active project's score (General aside). Null when the embedding model is unavailable. */
export async function scoreProjects(text: string, d: AppDb = appDb(), w: typeof ROUTING = ROUTING): Promise<ProjectScore[] | null> {
  const projects = listProjects({}, d).filter((p) => p.id !== GENERAL);
  if (!projects.length) return [];
  try {
    const q = await embed(text.slice(0, 1000));
    const words = routingTokens(text);
    const parts: Omit<ProjectScore, 'lex' | 'score'>[] = [];
    const vocab = new Map<string, Set<string>>();
    for (const p of projects) {
      const nameVec = await cachedVec(`name:${p.name}`, p.name);
      const msgs = recentMessages(p.id, d);
      let byThread: number | null = null;
      if (msgs.length) {
        const vecs = await Promise.all(msgs.map((m) => cachedVec(`turn:${m.id}:${m.text.length}`, m.text)));
        byThread = cos(q, vecs[0].map((_, i) => vecs.reduce((s, v) => s + v[i], 0) / vecs.length));
      }
      vocab.set(p.id, routingTokens([p.name, ...msgs.map((m) => m.text)].join(' ')));
      parts.push({ project: p, byName: cos(q, nameVec), byThread });
    }
    const df = (t: string) => projects.filter((p) => vocab.get(p.id)!.has(t)).length;
    const out = parts.map((x) => {
      let lex = 0;
      for (const t of words) if (vocab.get(x.project.id)!.has(t)) lex += Math.log(projects.length / df(t));
      const emb = x.byThread == null ? x.byName : w.NAME_WEIGHT * x.byName + (1 - w.NAME_WEIGHT) * x.byThread;
      return { ...x, lex, score: Math.round((emb + w.LEX_WEIGHT * lex) * 10_000) / 10_000 };
    });
    return out.sort((a, b) => b.score - a.score);
  } catch {
    return null;
  }
}

/** The decision on scored projects (pure: the tuning script and the tests call it with other thresholds). */
export function decide(scored: ProjectScore[] | null, inside: ProjectRow | undefined, w: typeof ROUTING = ROUTING): Suggestion {
  const alt = (x: ProjectScore) => ({ projectId: x.project.id, name: x.project.name, score: x.score });
  if (inside) {
    if (!scored?.length) return { projectId: inside.id, confidence: 'this project', alternatives: [] };
    const here = scored.find((x) => x.project.id === inside.id)?.score ?? 0;
    const others = scored.filter((x) => x.project.id !== inside.id);
    const best = others[0];
    const strong = !!best && best.score >= w.SUGGEST && best.score - here >= w.HINT && best.score - (others[1]?.score ?? 0) >= w.MARGIN;
    return { projectId: inside.id, confidence: 'this project', alternatives: strong ? [alt(best)] : [] };
  }
  if (!scored?.length) return { projectId: GENERAL, confidence: 'not sure', alternatives: [] };
  const [first, second] = scored;
  if (first.score >= w.SUGGEST && (!second || first.score - second.score >= w.MARGIN)) {
    return { projectId: first.project.id, confidence: 'suggested', alternatives: scored.slice(1, 3).map(alt) };
  }
  return { projectId: GENERAL, confidence: 'not sure', alternatives: scored.slice(0, 2).map(alt) };
}

/**
 * Where a message should go. From inside a project (`fromProjectId`, not General) it stays there ('this project'); a
 * strong match for another project comes back as the one alternative — a hint the person may take, never a switch.
 * From Now/Today or General: the best project when it is clearly best ('suggested'), else General ('not sure') with
 * the closest projects as alternatives.
 */
export async function suggestProject(text: string, fromProjectId?: string | null, d: AppDb = appDb()): Promise<Suggestion> {
  const from = fromProjectId && fromProjectId !== GENERAL ? getProject(fromProjectId, d) : undefined;
  const inside = from && !from.archived ? from : undefined;
  const t = String(text ?? '').trim();
  return decide(t ? await scoreProjects(t, d) : [], inside);
}
