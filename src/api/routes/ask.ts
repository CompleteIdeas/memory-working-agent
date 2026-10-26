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
import { statSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  insertAsk, updateAsk, getAsk, asksAbout, apiAsk, buildPlan, withModelNarrow, loadAbout, parseAbout, aboutRun, suggestionsFor,
  startItemQa, clockText, PLAN_LIMITS, type AttachedFile, type AskMode, type AskSource, type Route as AskRoute, type AboutContext, type Plan, type AskRow,
} from '../../v2/ask.js';
import { getProject, suggestProject, getTurn, apiTurn } from '../../v2/projects.js';
import { appDb } from '../../v2/db.js';
import { projectRouteDeps, type ChatExtras, type ChatStart } from './projects.js';
import { insideRoot } from '../../files.js';
import { documentSize } from '../../tools/builtins.js';
import { aboutTime, aboutUsd, usdText, CAP_MAX_USD } from '../../v2/estimate.js';
import { appendTurn } from '../../conversations.js';
import type { HistoryStats } from '../../v2/estimate.js';

export interface AskRouteDeps {
  /** the workspace root (attached files are workspace paths) */
  workspace: () => string;
  /** hand an ask to the background: a goal and a Job on the background tier with a spending limit (handoff.ts) */
  startBackground?: (projectId: string, o: { message: string; person?: string; capUsd: number }) => Promise<{ jobId: string; goalId?: string } | null>;
  /** an email's body as sanitised text (A8's reader), for an ask about it */
  mailBody?: (account: string, providerId: string) => Promise<string>;
  /** the configured models (the background tier is priced by its list price where history has nothing) */
  models?: () => { fetch?: string; background?: string } | null;
  /** tests: fixed history and clock */
  history?: () => HistoryStats;
  now?: () => number;
  tz?: () => string;
}
let deps: AskRouteDeps | null = null;
export function setAskRouteDeps(d: AskRouteDeps | null): void { deps = d; }

const bodyOf = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {});
const MODES: readonly AskMode[] = ['auto', 'now', 'background'];
const MAX_FILES = 10;
const nowMs = () => (deps?.now ?? Date.now)();

function capOf(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (typeof v !== 'number' || !Number.isFinite(n) || n < 0.01 || n > CAP_MAX_USD) throw new ApiError(400, 'bad_cap', `\`capUsd\` is a dollar amount from 0.01 to ${CAP_MAX_USD}.`);
  return Math.round(n * 100) / 100;
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
    const abs = insideRoot(root, rel);
    let ok = false;
    try { ok = !!abs && statSync(abs).isFile(); } catch { ok = false; }
    if (!abs || !ok) throw new ApiError(400, 'bad_file', `No such file: ${rel.slice(0, 200)}`);
    const size = await documentSize(abs, readFileSync(abs));
    out.push({ path: rel, name: basename(rel), pages: size.pages, reads: size.reads });
  }
  return out;
}

/** Where an ask goes: the project given; the project of the thing it is about; else a suggestion. */
async function routeOf(text: string, projectId: unknown, about: AboutContext | null): Promise<AskRoute> {
  if (projectId !== undefined && projectId !== null) {
    const p = getProject(String(projectId));
    if (!p) throw new ApiError(404, 'not_found', 'No such project.');
    if (p.archived) throw new ApiError(409, 'archived', `${p.name} is archived. Restore it first.`);
    return { projectId: p.id, name: p.name, confidence: 'given', alternatives: [] };
  }
  const own = about?.projectId ? getProject(about.projectId) : undefined;
  if (own && !own.archived) return { projectId: own.id, name: own.name, confidence: 'about', alternatives: [] };
  // routing only reads the words (an embedding and shared words); the chip's text helps it place a vague question
  const s = await suggestProject(about ? `${about.label} ${text}` : text, null);
  const p = getProject(s.projectId);
  return { projectId: s.projectId, name: p?.name ?? 'General', confidence: s.confidence === 'suggested' ? 'suggested' : 'not sure', alternatives: s.alternatives };
}

const filesNote = (files: AttachedFile[]) => (files.length
  ? `\n\nFiles attached to this request (workspace paths; read them with read_document): ${files.map((f) => `${f.path} (${f.pages} page${f.pages === 1 ? '' : 's'})`).join(', ')}.` : '');

function startChat(): NonNullable<NonNullable<ReturnType<typeof projectRouteDeps>>['startChat']> {
  const s = projectRouteDeps()?.startChat;
  if (!s) throw new ApiError(503, 'unavailable', 'Chat is not available on this server.', true);
  return s;
}

/** Run an ask now, in its project's thread. */
async function runNow(ask: AskRow, o: { files: AttachedFile[]; stay: boolean; person?: string; extras?: ChatExtras }): Promise<Record<string, unknown>> {
  const out: ChatStart = await startChat()(ask.project_id, ask.text, {
    stay: o.stay, ...(o.person ? { person: o.person } : {}),
    extras: { askId: ask.id, ...(ask.source === 'voice' ? { source: 'voice' as const } : {}), ...(o.files.length ? { files: o.files.map((f) => ({ path: f.path, pages: f.pages })) } : {}), ...o.extras },
  });
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

/** Hand an ask to the background: a Job on the background tier, its limit, its first estimate, and a line in the thread. */
async function runInBackground(ask: AskRow, o: { files: AttachedFile[]; capUsd: number; usd: number; ms: number; person?: string }): Promise<Record<string, unknown>> {
  if (!deps?.startBackground) throw new ApiError(503, 'unavailable', 'Background work is not available on this server.', true);
  const message = ask.text + filesNote(o.files);
  const made = await deps.startBackground(ask.project_id, { message, capUsd: o.capUsd, ...(o.person ? { person: o.person } : {}) });
  if (!made) throw new ApiError(503, 'unavailable', 'That could not be handed over just now. Try again in a moment.', true);
  const now = nowMs();
  const readyAt = now + o.ms;
  // the plan's estimate is the job's first guess ("I guessed about 15¢ · it cost 17¢")
  try {
    appDb().prepare('UPDATE jobs SET est_usd_first = ?, est_ms_first = ?, model_tier = ? WHERE id = ?').run(o.usd, o.ms, 'background', made.jobId);
  } catch { /* bookkeeping */ }
  const reply = `On it. I'll work on this in the background — ${aboutUsd(o.usd)}, ready around ${clockText(readyAt, deps.tz?.())} — and post the result here when it's done. I'll stop and ask if it would cost more than ${usdText(o.capUsd)}.`;
  const turnId = appendTurn({ ts: now, session: `p-${ask.project_id}`, message: ask.text, reply, kind: 'offer', offer: { answered: 'background', ...(made.goalId ? { goal: made.goalId.slice(0, 8) } : {}), at: now }, job: made.jobId });
  updateAsk(ask.id, { state: 'queued', kind: ask.kind === 'plan' ? 'plan' : 'job', job_id: made.jobId, cap_usd: o.capUsd, ...(turnId ? { turn_id: turnId } : {}) });
  return { jobId: made.jobId, tier: 'background', capUsd: o.capUsd, estimate: { usd: o.usd, ms: o.ms }, readyAt, message: reply, ...(turnId ? { turnId } : {}) };
}

export interface AskInput {
  text: string; projectId?: unknown; about?: { kind: AboutContext['kind']; id: string } | null; files: AttachedFile[];
  mode: AskMode; capUsd?: number; source: AskSource; person?: string; parentId?: string;
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
    const ask = insertAsk({ text: i.text, projectId: route.projectId, route, kind: 'answer', mode: 'now', person: i.person, about: { kind: about.kind, id: about.id }, source: i.source, state: 'running', parentId: i.parentId });
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
  const built = buildPlan({ text: i.text, files: i.files, now: nowMs(), tz, models: deps.models?.() ?? null, ...(deps.history ? { history: deps.history() } : {}) });
  if (i.mode === 'background') {
    const ask = insertAsk({ text: i.text, projectId: route.projectId, route, kind: 'job', mode: i.mode, person: i.person, files: i.files, source: i.source, plan: built.plan ?? null, state: 'choosing', parentId: i.parentId });
    try {
      const job = await runInBackground(ask, { files: i.files, capUsd: i.capUsd ?? built.caps.background, usd: built.bgEstimate.usd, ms: built.bgEstimate.ms, person: i.person });
      return { ...head(getAsk(ask.id)!), ...job };
    } catch (e) { updateAsk(ask.id, { state: 'failed' }); throw e; }
  }
  if (i.mode === 'auto' && built.plan) {
    const plan = await withModelNarrow(built.plan, { text: i.text, files: i.files, models: deps.models?.() ?? null, ...(deps.history ? { history: deps.history() } : {}) });
    const ask = insertAsk({ text: i.text, projectId: route.projectId, route, kind: 'plan', mode: i.mode, person: i.person, files: i.files, source: i.source, plan, state: 'planned', capUsd: i.capUsd ?? null, parentId: i.parentId });
    return { ...head(ask), plan };
  }
  // an ordinary ask, or a big one the person wants done now (then with its spending limit)
  const ask = insertAsk({ text: i.text, projectId: route.projectId, route, kind: 'answer', mode: i.mode, person: i.person, files: i.files, source: i.source, plan: built.plan ?? null, state: 'running', capUsd: i.capUsd ?? null, parentId: i.parentId });
  const cap = i.capUsd ?? (built.plan ? built.caps.now : undefined);
  const out = await runNow(ask, { files: i.files, stay: i.mode === 'now', person: i.person, extras: cap ? { budget: { maxUsd: cap } } : {} });
  return { ...head(getAsk(ask.id)!), ...out, ...(cap ? { capUsd: cap } : {}) };
}

/** A plan's choice, made once: the second time the same choice answers what the first did; another choice is refused. */
function claimChoice(id: string, choice: Record<string, unknown>): { replay: Record<string, unknown> } | { ask: AskRow } {
  const d = appDb();
  return d.transaction(() => {
    const a = getAsk(id, d);
    if (!a) throw new ApiError(404, 'not_found', 'No such ask.');
    if (a.kind !== 'plan') throw new ApiError(409, 'not_a_plan', 'That ask is not waiting for a choice.');
    const same = a.choice === JSON.stringify(choice);
    if (a.state === 'planned') { updateAsk(id, { state: 'choosing', choice: JSON.stringify(choice) }, d); return { ask: getAsk(id, d)! }; }
    if (a.state === 'choosing') throw new ApiError(409, 'in_progress', 'That choice is still being made. Try again in a moment.', true);
    if (same && a.result) return { replay: JSON.parse(a.result) as Record<string, unknown> };
    throw new ApiError(409, 'already_chosen', 'A choice was already made for this ask.');
  }).immediate();
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
      const a = getAsk(params.id);
      if (!a) throw new ApiError(404, 'not_found', 'No such ask.');
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
      const got = claimChoice(params.id, choice);
      if ('replay' in got) return { body: got.replay };
      const ask = got.ask;
      const files = (JSON.parse(ask.files ?? '[]') as AttachedFile[]);
      const person = ask.person ?? undefined;
      try {
        let out: Record<string, unknown>;
        if (hasNarrow) {
          // The person saw its price on the button and picked it: a narrower ask that is small (40 pages or fewer of
          // reading) is done now, with its own limit ("That's small — 15 pages — so I'll do it now."); one still big
          // comes back as a plan of its own.
          const n = plan!.narrow[b.narrowIndex as number];
          const its = files.filter((f) => n.files.includes(f.path));
          const total = its.reduce((s, f) => s + f.pages, 0);
          const pages = n.pages && n.pages < total ? n.pages : total;
          const small = pages <= PLAN_LIMITS.PAGES;
          // priced on the part it reads: the files scaled down to its pages
          const scaled = its.map((f) => (pages < total ? { ...f, pages: Math.max(1, Math.round((f.pages * pages) / total)), reads: Math.max(1, Math.round((f.reads * pages) / total)) } : f));
          const cap = capUsd ?? (small ? buildPlan({ text: n.text, files: scaled, now: nowMs(), tz: deps?.tz?.(), models: deps?.models?.() ?? null, ...(deps?.history ? { history: deps.history() } : {}) }).caps.now : undefined);
          const sub = await submit({ text: n.text, projectId: ask.project_id, files: its, mode: small ? 'now' : 'auto', capUsd: cap, source: (ask.source as AskSource) ?? 'typed', person, parentId: ask.id });
          out = { askId: ask.id, chosen: 'narrow', narrowed: sub, ...(small ? { message: `That's small — ${pages} page${pages === 1 ? '' : 's'} — so I'll do it now.` } : {}) };
          updateAsk(ask.id, { state: 'narrowed', result: JSON.stringify(out) });
        } else if (b.mode === 'background') {
          const job = await runInBackground(ask, { files, capUsd: capUsd ?? plan?.background.capDefault ?? plan?.capDefault ?? 0.5, usd: plan?.background.usd ?? 0, ms: plan?.background.ms ?? 0, person });
          out = { askId: ask.id, chosen: 'background', kind: 'job', ...job };
          updateAsk(ask.id, { result: JSON.stringify(out) });
        } else {
          const cap = capUsd ?? plan?.now.capDefault;
          const ran = await runNow(ask, { files, stay: true, person, extras: cap ? { budget: { maxUsd: cap } } : {} });
          out = { askId: ask.id, chosen: 'now', kind: 'answer', ...ran, ...(cap ? { capUsd: cap } : {}), message: `Doing it now${plan ? ` — ${aboutUsd(plan.now.usd)}, ${aboutTime(plan.now.ms)}` : ''}.` };
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

