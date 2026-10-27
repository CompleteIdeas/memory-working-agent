/**
 * /api/v1/ask (v2 slice A6): one place to ask from — the Ask bar, "Ask about this", the mic.
 *
 *   POST /ask                   {text, projectId?, about?, files?, mode?, capUsd?, source?} → 202 {askId, projectId, route, kind}
 *                               kind 'answer': it runs now in the project's thread (the projects send path; progress on
 *                               /stream); 'plan': a big ask, not started — choose how; 'job': handed to the background
 *   POST /ask/{id}/choose       {mode: 'now'|'background'} or {narrowIndex}, capUsd? — a plan's choice, made once
 *   GET  /ask/{id}              the ask as it stands (its plan, its choice, its answer)
 *   GET  /ask?about=kind:id     the asks about one thing, oldest first: the answers shown under it
 *   GET  /ask/suggestions?about=kind:id   2–3 questions specific to that thing (templates, no model call)
 *
 * v1 is POST only for asking: the legacy GET /api/chat?message= is not carried over, so what the person asks never sits
 * in a query string (proxy and access logs). Voice: the browser turns speech into text; `source: 'voice'` is recorded
 * on the ask and the turn. There is no server speech route.
 *
 * Every caller of /api/v1 acts for the owner (standing decision); a thing that is not the owner's is "not found".
 */
import { ApiError, type Route } from '../router.js';
import { stat, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  insertAsk, updateAsk, getAsk, asksAbout, apiAsk, buildPlan, withModelNarrow, loadAbout, parseAbout, aboutRun, suggestionsFor,
  startItemQa, clockText, expireIfStale, focusOf, focusNote, focusCarried, filesCarried, filesNote, nowBudget, PLAN_LIMITS,
  type AttachedFile, type AskMode, type AskSource, type Route as AskRoute, type AboutContext, type Plan, type AskRow, type Focus,
} from '../../v2/ask.js';
import { GENERAL, getProject, suggestProject, getTurn, apiTurn } from '../../v2/projects.js';
import { appDb } from '../../v2/db.js';
import { projectRouteDeps, type ChatExtras, type ChatStart } from './projects.js';
import { insideRoot } from '../../files.js';
import { documentSize, sizeFromBytes } from '../../tools/builtins.js';
import { aboutTime, aboutUsd, usdText, CAP_MAX_USD } from '../../v2/estimate.js';
import { appendTurn } from '../../conversations.js';
import type { HistoryStats } from '../../v2/estimate.js';

export interface AskRouteDeps {
  /** the workspace root (attached files are workspace paths) */
  workspace: () => string;
  /** hand an ask to the background: a goal and a Job on the background tier with a spending limit (handoff.ts).
   *  `attachments`: the attached files' paths, given to the job fenced; `suggestedFocus`: a model's label, fenced, and
   *  the job starts tainted */
  startBackground?: (projectId: string, o: { message: string; person?: string; capUsd: number; attachments?: string; suggestedFocus?: string }) => Promise<{ jobId: string; goalId?: string } | null>;
  /** an email's body as sanitised text (A8's reader), for an ask about it */
  mailBody?: (account: string, providerId: string) => Promise<string>;
  /** the configured models (the background tier is priced by its list price where history has nothing) */
  models?: () => { fetch?: string; background?: string } | null;
  /** tests: fixed history and clock; how long a page count may take */
  history?: () => HistoryStats;
  now?: () => number;
  tz?: () => string;
  countTimeoutMs?: number;
  /** tests: how a file is counted (default read_document's documentSize) — e.g. one that never finishes */
  documentSize?: (src: string, buf: Buffer) => Promise<{ pages: number; reads: number }>;
}
let deps: AskRouteDeps | null = null;
export function setAskRouteDeps(d: AskRouteDeps | null): void { deps = d; }

const bodyOf = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {});
const MODES: readonly AskMode[] = ['auto', 'now', 'background'];
export const MAX_FILES = 10;
/** The largest file an ask counts (an upload is at most 25 MB). */
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
const nowMs = () => (deps?.now ?? Date.now)();
const histOpt = () => (deps?.history ? { history: deps.history() } : {});

function capOf(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (typeof v !== 'number' || !Number.isFinite(n) || n < 0.01 || n > CAP_MAX_USD) throw new ApiError(400, 'bad_cap', `\`capUsd\` is a dollar amount from 0.01 to ${CAP_MAX_USD}.`);
  return Math.round(n * 100) / 100;
}

/** Count one file the way read_document reads it — with a time limit (a PDF is parsed): past it, its size in bytes
 *  stands in (about 25 KB a page). Null when it is not there (or not a file); too big is refused. */
async function countFile(root: string, rel: string): Promise<AttachedFile | null> {
  const abs = insideRoot(root, rel);
  if (!abs) return null;
  let size: number;
  try { const st = await stat(abs); if (!st.isFile()) return null; size = st.size; } catch { return null; }
  if (size > MAX_FILE_BYTES) throw new ApiError(400, 'file_too_large', `That file is too large to read here: ${basename(rel).slice(0, 80)}`);
  const buf = await readFile(abs);
  // unreadable or too slow: the same size rule either way (sizeFromBytes)
  const { pages, reads } = sizeFromBytes(size);
  const guess = { pages, reads };
  const count = deps?.documentSize ?? documentSize;
  const counted = await Promise.race([
    count(abs, buf).then((s) => ({ pages: s.pages, reads: s.reads })).catch(() => guess),
    new Promise<typeof guess>((r) => { const t = setTimeout(() => r(guess), deps?.countTimeoutMs ?? 15_000); (t as { unref?: () => void }).unref?.(); }),
  ]);
  return { path: rel, name: basename(rel), ...counted };
}

/** The attached files: workspace paths of files the person added (uploads), counted the way read_document reads them. */
async function attached(v: unknown): Promise<AttachedFile[]> {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_FILES || v.some((x) => typeof x !== 'string' || !x.trim())) throw new ApiError(400, 'bad_files', `\`files\` is a list of up to ${MAX_FILES} file paths (as an upload returns them).`);
  if (!deps) throw new ApiError(503, 'unavailable', 'Files are not available on this server.', true);
  const root = deps.workspace();
  const out: AttachedFile[] = [];
  for (const raw of new Set(v as string[])) {
    const rel = raw.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    const f = await countFile(root, rel);
    if (!f) throw new ApiError(400, 'bad_file', `No such file: ${rel.slice(0, 200)}`);
    out.push(f);
  }
  return out;
}

/** Where an ask goes: the project given; for an ask about one thing, that thing's project or General (never routed by
 *  its text: a title can be someone else's words); else the routing suggestion on the person's own words. */
async function routeOf(text: string, projectId: unknown, about: AboutContext | null): Promise<AskRoute> {
  if (projectId !== undefined && projectId !== null) {
    const p = getProject(String(projectId));
    if (!p) throw new ApiError(404, 'not_found', 'No such project.');
    if (p.archived) throw new ApiError(409, 'archived', `${p.name} is archived. Restore it first.`);
    return { projectId: p.id, name: p.name, confidence: 'given', alternatives: [] };
  }
  if (about) {
    const own = about.projectId ? getProject(about.projectId) : undefined;
    const p = own && !own.archived ? own : getProject(GENERAL);
    return { projectId: p?.id ?? GENERAL, name: p?.name ?? 'General', confidence: 'about', alternatives: [] };
  }
  const s = await suggestProject(text, null);
  const p = getProject(s.projectId);
  return { projectId: s.projectId, name: p?.name ?? 'General', confidence: s.confidence === 'suggested' ? 'suggested' : 'not sure', alternatives: s.alternatives };
}

function startChat(): NonNullable<NonNullable<ReturnType<typeof projectRouteDeps>>['startChat']> {
  const s = projectRouteDeps()?.startChat;
  if (!s) throw new ApiError(503, 'unavailable', 'Chat is not available on this server.', true);
  return s;
}
const focusOfRow = (a: AskRow): Focus | null => { try { return a.focus ? JSON.parse(a.focus) as Focus : null; } catch { return null; } };

/** What a run of an ask with files or a focus is given: the instruction says how many files and the fixed focus note;
 *  their paths and a model's suggested focus go fenced; a model's focus starts the run tainted. */
function askExtras(ask: AskRow, files: AttachedFile[]): ChatExtras {
  const focus = focusOfRow(ask);
  const carried = [filesCarried(files), focus ? focusCarried(focus) : ''].filter(Boolean).join('\n\n');
  const note = (focus ? focusNote(focus) : '') + filesNote(files.length);
  return {
    askId: ask.id, ...(ask.source === 'voice' ? { source: 'voice' as const } : {}),
    ...(files.length ? { files: files.map((f) => ({ path: f.path, pages: f.pages })) } : {}),
    ...(note ? { note } : {}), ...(carried ? { carried } : {}), ...(focus?.suggested ? { startTainted: true } : {}),
  };
}

/** Run an ask now, in its project's thread. */
async function runNow(ask: AskRow, o: { files: AttachedFile[]; stay: boolean; person?: string; extras?: ChatExtras }): Promise<Record<string, unknown>> {
  const base = askExtras(ask, o.files);
  const extras: ChatExtras = { ...base, ...o.extras, ...(base.carried && o.extras?.carried ? { carried: `${base.carried}\n\n${o.extras.carried}` } : {}),
    ...(base.startTainted || o.extras?.startTainted ? { startTainted: true } : {}) };
  const out: ChatStart = await startChat()(ask.project_id, ask.text, { stay: o.stay, ...(o.person ? { person: o.person } : {}), extras });
  if (out.state === 'busy') {
    updateAsk(ask.id, { state: 'failed', result: JSON.stringify({ busy: out.message }) });
    throw new ApiError(409, 'busy', out.message, true);
  }
  if (out.state === 'offer') {
    updateAsk(ask.id, { state: 'offered', ...(out.turnId ? { turn_id: out.turnId } : {}) });
    return { state: 'offer', message: out.message, ...(out.turnId ? { turnId: out.turnId } : {}) };
  }
  // a run that already ended (its answer is kept by finishAsk) keeps its state and turn
  const cur = getAsk(ask.id);
  const ended = cur?.state === 'answered' || cur?.state === 'failed';
  updateAsk(ask.id, { ...(ended ? {} : { state: 'running' as const }), run_id: cur?.run_id ?? out.runId, ...(out.turnId && !cur?.turn_id ? { turn_id: out.turnId } : {}) });
  return { state: 'started', runId: out.runId, ...(out.turnId ? { turnId: out.turnId } : {}) };
}

/** Hand an ask to the background: a Job on the background tier, its limit, its size and first estimate, and a line in
 *  the thread. File paths and a model's focus reach the job fenced, never in its request. */
async function runInBackground(ask: AskRow, o: { files: AttachedFile[]; capUsd: number; usd: number; ms: number; person?: string }): Promise<Record<string, unknown>> {
  if (!deps?.startBackground) throw new ApiError(503, 'unavailable', 'Background work is not available on this server.', true);
  const focus = focusOfRow(ask);
  const message = ask.text + (focus ? focusNote(focus) : '') + filesNote(o.files.length);
  const made = await deps.startBackground(ask.project_id, { message, capUsd: o.capUsd, ...(o.person ? { person: o.person } : {}),
    ...(o.files.length ? { attachments: filesCarried(o.files) } : {}), ...(focus?.suggested ? { suggestedFocus: focusCarried(focus) } : {}) });
  if (!made) throw new ApiError(503, 'unavailable', 'That could not be handed over just now. Try again in a moment.', true);
  const now = nowMs();
  const readyAt = now + o.ms;
  // the plan's estimate is the job's first guess ("I guessed about 15¢ · it cost 17¢"); its size prices a Continue
  const sizeReads = o.files.reduce((s, f) => s + f.reads, 0), sizePages = o.files.reduce((s, f) => s + f.pages, 0);
  try {
    appDb().prepare('UPDATE jobs SET est_usd_first = ?, est_ms_first = ?, model_tier = ?, size_reads = ?, size_pages = ? WHERE id = ?')
      .run(o.usd, o.ms, 'background', sizeReads || null, sizePages || null, made.jobId);
  } catch { /* bookkeeping */ }
  const reply = `On it. I'll work on this in the background — ${aboutUsd(o.usd)}, ready around ${clockText(readyAt, deps.tz?.())} — and post the result here when it's done. I'll stop and ask if it would cost more than ${usdText(o.capUsd)}.`;
  const turnId = appendTurn({ ts: now, session: `p-${ask.project_id}`, message: ask.text, reply, kind: 'offer', offer: { answered: 'background', ...(made.goalId ? { goal: made.goalId.slice(0, 8) } : {}), at: now }, job: made.jobId });
  updateAsk(ask.id, { state: 'queued', kind: ask.kind === 'plan' ? 'plan' : 'job', job_id: made.jobId, cap_usd: o.capUsd, ...(turnId ? { turn_id: turnId } : {}) });
  return { jobId: made.jobId, tier: 'background', capUsd: o.capUsd, estimate: { usd: o.usd, ms: o.ms }, readyAt, message: reply, ...(turnId ? { turnId } : {}) };
}

export interface AskInput {
  text: string; projectId?: unknown; about?: { kind: AboutContext['kind']; id: string } | null; files: AttachedFile[];
  mode: AskMode; capUsd?: number; source: AskSource; person?: string; parentId?: string; focus?: Focus;
}

/** An ask: routed, then answered now, planned, or handed to the background. The 202 body. */
async function submit(i: AskInput): Promise<Record<string, unknown>> {
  if (!deps) throw new ApiError(503, 'unavailable', 'Asking is not available on this server.', true);
  const about = i.about ? await loadAbout(i.about.kind, i.about.id, { mailBody: deps.mailBody, tz: deps.tz?.() }) : null;
  if (i.about && !about) throw new ApiError(404, 'not_found', i.about.kind === 'item' ? 'No such item.' : `No such ${i.about.kind}.`);
  const route = await routeOf(i.text, i.projectId, about);
  const head = (ask: AskRow) => ({ askId: ask.id, projectId: ask.project_id, route, kind: ask.kind, ...(about ? { about: { kind: about.kind, id: about.id, label: about.label } } : {}) });

  // "Ask about this": small, fenced, answered in place — never a plan or a job
  if (about) {
    if (i.mode === 'background') throw new ApiError(400, 'bad_mode', 'A question about one thing is answered now.');
    const run = aboutRun(i.text, about);
    const ask = insertAsk({ text: i.text, projectId: route.projectId, route, kind: 'answer', mode: 'now', person: i.person, about: { kind: about.kind, id: about.id }, source: i.source, state: 'running', parentId: i.parentId, createdAt: nowMs() });
    const qa = about.kind === 'item' ? startItemQa(about.id, i.text) : null;
    if (qa) updateAsk(ask.id, { result: JSON.stringify({ qa }) });
    try {
      const out = await runNow(getAsk(ask.id)!, { files: [], stay: true, person: i.person, extras: { about: { kind: about.kind, id: about.id }, framing: run.framing, carried: run.carried, startTainted: run.startTainted, budget: run.budget } });
      return { ...head(getAsk(ask.id)!), ...out, budget: run.budget, tainted: run.startTainted };
    } catch (e) {
      if (qa) { try { appDb().prepare('DELETE FROM item_qa WHERE id = ? AND a IS NULL').run(qa); } catch { /* */ } }
      throw e;
    }
  }

  const tz = deps.tz?.();
  const built = buildPlan({ text: i.text, files: i.files, now: nowMs(), tz, models: deps.models?.() ?? null, noNarrow: !!i.focus, ...histOpt() });
  const reads = i.files.reduce((s, f) => s + f.reads, 0) || undefined;
  const common = { text: i.text, projectId: route.projectId, route, person: i.person, files: i.files, source: i.source, parentId: i.parentId, focus: i.focus ?? null, createdAt: nowMs() };
  if (i.mode === 'background') {
    const ask = insertAsk({ ...common, kind: 'job', mode: i.mode, plan: built.plan ?? null, state: 'choosing' });
    try {
      const job = await runInBackground(ask, { files: i.files, capUsd: i.capUsd ?? built.caps.background, usd: built.bgEstimate.usd, ms: built.bgEstimate.ms, person: i.person });
      return { ...head(getAsk(ask.id)!), ...job };
    } catch (e) { updateAsk(ask.id, { state: 'failed' }); throw e; }
  }
  if (i.mode === 'auto' && built.plan) {
    const plan = i.focus ? built.plan : await withModelNarrow(built.plan, { text: i.text, files: i.files, models: deps.models?.() ?? null, ...histOpt() });
    const ask = insertAsk({ ...common, kind: 'plan', mode: i.mode, plan, state: 'planned', capUsd: i.capUsd ?? null });
    return { ...head(ask), plan };
  }
  // an ordinary ask, or a big one the person wants done now: then with its spending limit, and room for every read
  const ask = insertAsk({ ...common, kind: 'answer', mode: i.mode, plan: built.plan ?? null, state: 'running', capUsd: i.capUsd ?? null });
  const cap = i.capUsd ?? (built.plan ? built.caps.now : undefined);
  const budget = { ...(cap ? { maxUsd: cap } : {}), ...(reads ? nowBudget(reads, built.nowEstimate.ms) : {}) };
  const out = await runNow(ask, { files: i.files, stay: i.mode === 'now', person: i.person, extras: Object.keys(budget).length ? { budget } : {} });
  return { ...head(getAsk(ask.id)!), ...out, ...(cap ? { capUsd: cap } : {}) };
}

/** A plan's choice, made once: the second time the same choice answers what the first did; another choice is refused. */
function claimChoice(id: string, choice: Record<string, unknown>): { replay: Record<string, unknown> } | { ask: AskRow } {
  const d = appDb();
  return d.transaction(() => {
    const a = getAsk(id, d);
    if (!a) throw new ApiError(404, 'not_found', 'No such ask.');
    if (a.kind !== 'plan') throw new ApiError(409, 'not_a_plan', 'That ask is not waiting for a choice.');
    if (expireIfStale(a, nowMs(), d).state === 'expired') throw new ApiError(410, 'expired', 'That plan is more than a day old. Ask again for a fresh one.');
    const same = a.choice === JSON.stringify(choice);
    if (a.state === 'planned') { updateAsk(id, { state: 'choosing', choice: JSON.stringify(choice) }, d); return { ask: getAsk(id, d)! }; }
    if (a.state === 'choosing') throw new ApiError(409, 'in_progress', 'That choice is still being made. Try again in a moment.', true);
    if (same && a.result) return { replay: JSON.parse(a.result) as Record<string, unknown> };
    throw new ApiError(409, 'already_chosen', 'A choice was already made for this ask.');
  }).immediate();
}

/** The plan's files as they are now: each still there, counted again (they may have changed since the plan). */
async function filesNow(ask: AskRow): Promise<AttachedFile[]> {
  const was = JSON.parse(ask.files ?? '[]') as AttachedFile[];
  if (!was.length) return [];
  if (!deps) throw new ApiError(503, 'unavailable', 'Files are not available on this server.', true);
  const out: AttachedFile[] = [];
  for (const f of was) {
    const now = await countFile(deps.workspace(), f.path);
    if (!now) throw new ApiError(409, 'files_gone', `A file this plan reads is no longer there: ${basename(f.path).slice(0, 80)}. Ask again.`);
    out.push(now);
  }
  return out;
}

export const askRoutes: Route[] = [
  {
    method: 'POST', path: '/ask', scope: 'act',
    handler: async ({ body }) => {
      const b = bodyOf(body);
      const text = String(b.text ?? '').trim().slice(0, 8000);
      if (!text) throw new ApiError(400, 'bad_text', 'Nothing to ask.');
      const mode = (b.mode ?? 'auto') as AskMode;
      if (!MODES.includes(mode)) throw new ApiError(400, 'bad_mode', '`mode` is auto, now or background.');
      const source = (b.source ?? 'typed') as AskSource;
      if (source !== 'typed' && source !== 'voice') throw new ApiError(400, 'bad_source', '`source` is typed or voice.');
      const about = b.about === undefined || b.about === null ? null : parseAbout(b.about);
      if (b.about != null && !about) throw new ApiError(400, 'bad_about', '`about` is {kind, id}: kind is item, mail, event, draft, job or conflict.');
      if (b.projectId !== undefined && b.projectId !== null && typeof b.projectId !== 'string') throw new ApiError(400, 'bad_body', '`projectId` is a project id.');
      if (about && b.files != null) throw new ApiError(400, 'bad_files', 'A question about one thing takes no files.');
      const capUsd = capOf(b.capUsd);
      const files = await attached(b.files);
      const out = await submit({ text, projectId: b.projectId ?? undefined, about, files, mode, capUsd, source, person: typeof b.person === 'string' ? b.person : undefined });
      return { status: 202, body: out };
    },
  },
  {
    method: 'GET', path: '/ask/suggestions', scope: 'read',
    handler: async ({ url }) => {
      const about = parseAbout(url.searchParams.get('about') ?? '');
      if (!about) throw new ApiError(400, 'bad_about', '`about` is kind:id.');
      const ctx = await loadAbout(about.kind, about.id, { tz: deps?.tz?.() });
      if (!ctx) throw new ApiError(404, 'not_found', 'No such thing to ask about.');
      return { body: { about: { kind: ctx.kind, id: ctx.id, label: ctx.label }, suggestions: suggestionsFor(ctx) } };
    },
  },
  {
    method: 'GET', path: '/ask', scope: 'read',
    handler: async ({ url }) => {
      const about = parseAbout(url.searchParams.get('about') ?? '');
      if (!about) throw new ApiError(400, 'bad_about', 'Send `about` as kind:id.');
      const ctx = await loadAbout(about.kind, about.id, { tz: deps?.tz?.() });
      if (!ctx) throw new ApiError(404, 'not_found', 'No such thing to ask about.');
      return { body: { about: { kind: ctx.kind, id: ctx.id, label: ctx.label }, asks: asksAbout(about.kind, about.id).map(apiAsk) } };
    },
  },
  {
    method: 'GET', path: '/ask/{id}', scope: 'read',
    handler: ({ params }) => {
      const found = getAsk(params.id);
      if (!found) throw new ApiError(404, 'not_found', 'No such ask.');
      const a = expireIfStale(found, nowMs());
      const t = a.turn_id ? getTurn(a.turn_id) : undefined;
      return { body: { ask: apiAsk(a), turn: t ? apiTurn(t) : null } };
    },
  },
  {
    method: 'POST', path: '/ask/{id}/choose', scope: 'act',
    handler: async ({ params, body }) => {
      const b = bodyOf(body);
      const capUsd = capOf(b.capUsd);
      const hasNarrow = b.narrowIndex !== undefined && b.narrowIndex !== null;
      if (hasNarrow === (b.mode !== undefined && b.mode !== null)) throw new ApiError(400, 'bad_choice', 'Choose `mode` (now or background) or `narrowIndex`.');
      if (!hasNarrow && b.mode !== 'now' && b.mode !== 'background') throw new ApiError(400, 'bad_choice', '`mode` is now or background.');
      if (hasNarrow && !Number.isInteger(b.narrowIndex)) throw new ApiError(400, 'bad_choice', '`narrowIndex` is the position of a narrower ask in the plan.');
      const pre = getAsk(params.id);
      if (!pre) throw new ApiError(404, 'not_found', 'No such ask.');
      const plan = JSON.parse(pre.plan ?? 'null') as Plan | null;
      if (hasNarrow && (!plan || (b.narrowIndex as number) < 0 || (b.narrowIndex as number) >= plan.narrow.length)) throw new ApiError(400, 'bad_choice', 'There is no narrower ask at that position.');
      const choice = hasNarrow ? { narrowIndex: b.narrowIndex as number, ...(capUsd ? { capUsd } : {}) } : { mode: b.mode as string, ...(capUsd ? { capUsd } : {}) };
      // before anything is chosen: its project still takes work, and its files are still there
      if (pre.state === 'planned') {
        const p = getProject(pre.project_id);
        if (!p) throw new ApiError(404, 'not_found', 'Its project is gone. Ask again.');
        if (p.archived) throw new ApiError(409, 'archived', `${p.name} is archived. Restore it first.`, true);
      }
      const fresh = pre.state === 'planned' && !(nowMs() - pre.created_at > 24 * 3_600_000) ? await filesNow(pre) : null;
      const got = claimChoice(params.id, choice);
      if ('replay' in got) return { body: got.replay };
      const ask = got.ask;
      const files = fresh ?? (JSON.parse(ask.files ?? '[]') as AttachedFile[]);
      const person = ask.person ?? undefined;
      try {
        let out: Record<string, unknown>;
        if (hasNarrow) {
          // The narrower ask runs on the person's own words with a fixed note ("Focus only on: the first attached file
          // (76 pages)"); a model's label goes fenced and taints the run. Small — the files it is actually handed come
          // to 40 pages or fewer (counted, never the model's claim; a fixed page range of ours counts as its pages) —
          // it is done now with its own limit; still big, it is a plan of its own.
          const n = plan!.narrow[b.narrowIndex as number];
          const its = files.filter((f) => n.files.includes(f.path));
          const total = its.reduce((s, f) => s + f.pages, 0);
          const pages = n.by === 'file' && n.pages && n.pages < total ? n.pages : total;
          const small = pages <= PLAN_LIMITS.PAGES;
          const scaled = its.map((f) => (pages < total ? { ...f, pages: Math.max(1, Math.round((f.pages * pages) / total)), reads: Math.max(1, Math.round((f.reads * pages) / total)) } : f));
          const cap = capUsd ?? (small ? buildPlan({ text: ask.text, files: scaled, now: nowMs(), tz: deps?.tz?.(), models: deps?.models?.() ?? null, ...histOpt() }).caps.now : undefined);
          const sub = await submit({ text: ask.text, projectId: ask.project_id, files: its, mode: small ? 'now' : 'auto', capUsd: cap, source: (ask.source as AskSource) ?? 'typed', person, parentId: ask.id, focus: focusOf(n) });
          out = { askId: ask.id, chosen: 'narrow', narrowed: sub, ...(small ? { message: `That's small — ${pages} page${pages === 1 ? '' : 's'} — so I'll do it now.` } : {}) };
          updateAsk(ask.id, { state: 'narrowed', result: JSON.stringify(out) });
        } else if (b.mode === 'background') {
          const job = await runInBackground(ask, { files, capUsd: capUsd ?? plan?.background.capDefault ?? plan?.capDefault ?? 0.5, usd: plan?.background.usd ?? 0, ms: plan?.background.ms ?? 0, person });
          out = { askId: ask.id, chosen: 'background', kind: 'job', ...job };
          updateAsk(ask.id, { result: JSON.stringify(out) });
        } else {
          const cap = capUsd ?? plan?.now.capDefault;
          const reads = files.reduce((s, f) => s + f.reads, 0) || undefined;
          const budget = { ...(cap ? { maxUsd: cap } : {}), ...(reads ? nowBudget(reads, plan?.now.ms) : {}) };
          const ran = await runNow(ask, { files, stay: true, person, extras: { budget } });
          out = { askId: ask.id, chosen: 'now', kind: 'answer', ...ran, ...(cap ? { capUsd: cap } : {}),
            message: `Doing it now${plan ? ` — ${aboutUsd(plan.now.usd)}, ${aboutTime(plan.now.ms)}` : ''}.${plan?.now.note ? ` ${plan.now.note}` : ''}` };
          updateAsk(ask.id, { result: JSON.stringify(out), ...(cap ? { cap_usd: cap } : {}) });
        }
        return { status: 202, body: out };
      } catch (e) {
        // nothing was chosen after all: the plan waits again
        const now = getAsk(ask.id);
        if (now && (now.state === 'choosing' || now.state === 'failed')) updateAsk(ask.id, { state: 'planned', choice: null });
        throw e;
      }
    },
  },
];
