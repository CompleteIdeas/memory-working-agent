/**
 * /api/v1/projects and /api/v1/turns (v2 slice A5): the person's projects, each with one thread, its files and the jobs
 * working for it; a routing suggestion for a message; moving a message (and its answer) to another project.
 *
 * MWA has one owner (standing decision): every v1 caller acts for the owner, and projects and threads are the
 * owner's. Telegram conversations are not threads. A project's jobs use the jobs ownership filter (visibleJob).
 *
 * Sending a message into a project (POST /projects/{id}/messages) starts the same chat run as the legacy /api/chat with
 * the session `p-<id>`; the answer arrives on /stream (`live` events for the run, `change` events for the turn) and in
 * the thread.
 */
import { resolve } from 'node:path';
import { ApiError, type Route } from '../router.js';
import type { ServerResponse } from 'node:http';
import {
  GENERAL, apiProject, apiTurn, createProject, updateProject, getProject, listProjects, threadPage, moveTurn, getTurn,
  suggestProject, sessionOf, decodeCursor, ProjectError, MoveError,
} from '../../v2/projects.js';
import { importProgress } from '../../v2/migrate-conversations.js';
import type { LiveEvent } from '../../live-runs.js';
import { projectJobs, viewJobs } from '../../v2/jobs.js';
import { apiJob, visibleJob, viewCtx } from './jobs.js';
import { listFiles, sessionFolder, type FileRow } from '../../files.js';
import { appDb } from '../../v2/db.js';

/** What a project send gets back as soon as it is known: the run started, an offer to work in the background, or busy. */
export type ChatStart =
  | { state: 'started'; runId: string; turnId?: string }
  | { state: 'offer'; turnId?: string; message: string }
  | { state: 'busy'; message: string };

/** What an ask (A6, src/api/routes/ask.ts) adds to a project send: the run is the same, these shape it. */
export interface ChatExtras {
  /** the ask this run answers (its answer is kept on the ask, and under an item) */
  askId?: string;
  /** what it is about: recorded on the turn */
  about?: { kind: string; id: string };
  /** said before the person's words in the instruction (never the thing's own text) */
  framing?: string;
  /** fenced context (the thing an item-scoped ask is about), and whether the run starts tainted */
  carried?: string;
  startTainted?: boolean;
  /** a tighter budget than a chat's (an item-scoped ask: 8 steps, 5¢; a big ask done now: its spending limit) */
  budget?: { maxSteps?: number; maxUsd?: number };
  /** voice: the words came from the browser's speech recognition (recorded on the turn) */
  source?: 'voice' | 'typed';
  /** files attached to the ask (workspace paths), named in the instruction */
  files?: { path: string; pages: number }[];
}

export interface ProjectRouteDeps {
  /** the workspace root (files are listed under it) */
  workspace: () => string;
  /** start a chat run in a project's thread (serve.ts) */
  startChat?: (projectId: string, text: string, o: { stay?: boolean; person?: string; extras?: ChatExtras }) => Promise<ChatStart>;
  /** a turn moved: the server forgets what it carried for both threads (and the older conversation it left), so their
   *  next run reads them again */
  onTurnMoved?: (fromProjectId: string, toProjectId: string, legacySession: string | null) => void;
  /** the run going in a project's thread, if any; Stop; add a note to it; follow it (serve.ts, live-runs) */
  live?: (projectId: string) => { session: string; run: unknown } | null;
  stop?: (projectId: string) => boolean;
  steer?: (projectId: string, text: string) => boolean;
  attach?: (projectId: string, fn: (e: LiveEvent) => void) => (() => void) | null;
  finalEvents?: Set<string>;
  /** "Work on it" on a waiting offer in the thread: a goal and a background job (serve.ts) */
  acceptOffer?: (projectId: string, o: { message?: string; person?: string }) => Promise<{ goal: string; message: string } | null>;
}
let deps: ProjectRouteDeps | null = null;
export function setProjectRouteDeps(d: ProjectRouteDeps | null): void { deps = d; }
/** The send path an ask reuses (A6). */
export function projectRouteDeps(): ProjectRouteDeps | null { return deps; }

function load(id: string) {
  const p = getProject(id);
  if (!p) throw new ApiError(404, 'not_found', 'No such project.');
  return p;
}
function asApi(e: unknown): never {
  if (e instanceof ProjectError) throw new ApiError(e.code === 'not_found' ? 404 : e.code === 'bad_name' ? 400 : 409, e.code, e.message);
  if (e instanceof MoveError) throw new ApiError(e.code === 'not_found' ? 404 : 409, e.code, e.message);
  throw e;
}
const bodyOf = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {});

/** The files of a project's thread: its own folder, and (General, or a project a message was moved into) the folders
 *  of the older conversations its turns came from. Paths are relative to the workspace, as /api/files serves them. */
export function projectFiles(projectId: string, root: string): FileRow[] {
  const legacy = (appDb().prepare(`SELECT DISTINCT origin_session s FROM turns WHERE project_id = ? AND origin_session IS NOT NULL`).all(projectId) as { s: string }[]).map((r) => r.s);
  const folders = [...new Set([sessionFolder(sessionOf(projectId)), ...legacy.map(sessionFolder)])];
  const out: FileRow[] = [];
  for (const f of folders) {
    for (const row of listFiles(resolve(root, f))) out.push({ ...row, path: `${f}/${row.path}` });
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 500);
}

export const projectRoutes: Route[] = [
  {
    method: 'GET', path: '/projects', scope: 'read',
    handler: ({ url }) => ({ body: { projects: listProjects({ archived: url.searchParams.get('archived') === '1' }).map(apiProject), importing: importingNow() } }),
  },
  {
    method: 'POST', path: '/projects', scope: 'act',
    handler: ({ body }) => {
      const b = bodyOf(body);
      try { return { status: 201, body: { project: apiProject(createProject({ name: String(b.name ?? ''), icon: b.icon == null ? null : String(b.icon) })) } }; } catch (e) { asApi(e); }
    },
  },
  {
    method: 'GET', path: '/projects/suggest', scope: 'read',
    handler: async ({ url }) => {
      const text = (url.searchParams.get('text') ?? '').slice(0, 2000);
      if (!text.trim()) throw new ApiError(400, 'bad_text', 'Send the message as `text`.');
      const from = url.searchParams.get('from') || undefined;
      if (from && !getProject(from)) throw new ApiError(404, 'not_found', 'No such project.');
      return { body: await suggestProject(text, from) };
    },
  },
  {
    method: 'PATCH', path: '/projects/{id}', scope: 'act',
    handler: ({ params, body }) => {
      load(params.id);
      const b = bodyOf(body);
      const f: { name?: string; icon?: string | null; archived?: boolean; sort?: number } = {};
      if (b.name !== undefined) f.name = String(b.name);
      if (b.icon !== undefined) f.icon = b.icon === null ? null : String(b.icon);
      if (b.archived !== undefined) { if (typeof b.archived !== 'boolean') throw new ApiError(400, 'bad_body', '`archived` is true or false.'); f.archived = b.archived; }
      if (b.sort !== undefined) { if (!Number.isInteger(b.sort)) throw new ApiError(400, 'bad_body', '`sort` is a whole number.'); f.sort = b.sort as number; }
      if (!Object.keys(f).length) throw new ApiError(400, 'bad_body', 'Nothing to change: send name, icon, archived or sort.');
      try { return { body: { project: apiProject(updateProject(params.id, f)) } }; } catch (e) { asApi(e); }
    },
  },
  {
    method: 'GET', path: '/projects/{id}/thread', scope: 'read',
    handler: ({ params, url }) => {
      const p = load(params.id);
      const before = url.searchParams.get('before') || undefined;
      if (before && !decodeCursor(before)) throw new ApiError(400, 'bad_cursor', '`before` is the `next` the previous page gave.');
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw == null ? 50 : Number.parseInt(limitRaw, 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, 'bad_limit', '`limit` is 1 to 200.');
      const page = threadPage(p.id, { before, limit });
      return { body: { project: apiProject(p), turns: page.turns.map((t) => apiTurn(t)), next: page.next } };
    },
  },
  {
    method: 'POST', path: '/projects/{id}/messages', scope: 'act',
    handler: async ({ params, body }) => {
      const p = load(params.id);
      if (p.archived) throw new ApiError(409, 'archived', `${p.name} is archived. Restore it first.`);
      const b = bodyOf(body);
      const text = String(b.text ?? '').trim().slice(0, 8000);
      if (!text) throw new ApiError(400, 'bad_text', 'Nothing to send.');
      if (!deps?.startChat) throw new ApiError(503, 'unavailable', 'Chat is not available on this server.', true);
      const out = await deps.startChat(p.id, text, { stay: b.stay === true, person: typeof b.person === 'string' ? b.person : undefined });
      if (out.state === 'busy') throw new ApiError(409, 'busy', out.message, true);
      return { status: 202, body: { session: sessionOf(p.id), ...out } };
    },
  },
  {
    method: 'GET', path: '/projects/{id}/work', scope: 'read',
    handler: ({ params }) => {
      const p = load(params.id);
      const jobs = projectJobs(p.id).filter(visibleJob);
      return { body: { jobs: viewJobs(jobs, viewCtx()).map(apiJob) } };
    },
  },
  {
    method: 'GET', path: '/projects/{id}/files', scope: 'read',
    handler: ({ params }) => {
      const p = load(params.id);
      if (!deps) throw new ApiError(503, 'unavailable', 'Files are not available on this server.', true);
      return { body: { files: projectFiles(p.id, deps.workspace()), folder: sessionFolder(sessionOf(p.id)) } };
    },
  },
  {
    method: 'POST', path: '/projects/{id}/stop', scope: 'act',
    handler: ({ params }) => {
      const p = load(params.id);
      if (!deps?.stop?.(p.id)) throw new ApiError(409, 'nothing_running', 'Nothing is running in this project.');
      return { body: { stopped: true, message: 'Stopping. The step that is running finishes; nothing new starts.' } };
    },
  },
  {
    method: 'POST', path: '/projects/{id}/steer', scope: 'act',
    handler: ({ params, body }) => {
      const p = load(params.id);
      const text = String(bodyOf(body).text ?? '').trim().slice(0, 4000);
      if (!text) throw new ApiError(400, 'bad_text', 'Nothing to add.');
      if (!deps?.steer?.(p.id, text)) throw new ApiError(409, 'nothing_running', 'Nothing is running in this project. Send it as a message.');
      return { body: { added: true, message: 'Added to the running answer. It is taken into account from the next step.' } };
    },
  },
  {
    method: 'GET', path: '/projects/{id}/live', scope: 'read',
    handler: ({ params }) => {
      const p = load(params.id);
      return {
        stream: (res: ServerResponse, req) => {
          const write = (type: string, data: unknown) => { try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* gone */ } };
          let detach: (() => void) | null = null;
          let hb: ReturnType<typeof setInterval> | undefined;
          const done = () => { detach?.(); if (hb) clearInterval(hb); try { res.end(); } catch { /* */ } };
          detach = deps?.attach?.(p.id, (e) => { write(e.type, e.data); if (deps?.finalEvents?.has(e.type)) done(); }) ?? null;
          if (!detach) { write('gone', { projectId: p.id }); res.end(); return; }
          hb = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* */ } }, 15_000);
          hb.unref?.();
          req.on('close', done);
        },
      };
    },
  },
  {
    method: 'POST', path: '/projects/{id}/offer/accept', scope: 'act',
    handler: async ({ params, body }) => {
      const p = load(params.id);
      const b = bodyOf(body);
      if (!deps?.acceptOffer) throw new ApiError(503, 'unavailable', 'Background work is not available on this server.', true);
      const out = await deps.acceptOffer(p.id, { message: typeof b.message === 'string' ? b.message : undefined, person: typeof b.person === 'string' ? b.person : undefined });
      if (!out) throw new ApiError(409, 'no_offer', 'There is no waiting offer to accept here.');
      return { status: 202, body: out };
    },
  },
  {
    method: 'POST', path: '/turns/{id}/move', scope: 'act',
    handler: ({ params, body }) => {
      const to = String(bodyOf(body).projectId ?? '');
      if (!to) throw new ApiError(400, 'bad_body', 'Send the project to move it to as `projectId`.');
      if (!getTurn(params.id)) throw new ApiError(404, 'not_found', 'No such message.');
      try {
        const { turn, from, legacySession } = moveTurn(params.id, to);
        deps?.onTurnMoved?.(from, to, legacySession);
        const name = getProject(to)?.name ?? to;
        return { body: { turn: apiTurn(turn), from, message: `Moved to ${name}.`, undo: { projectId: from } } };
      } catch (e) { asApi(e); }
    },
  },
];

/** The older-conversations import, while it runs (shown as "Importing older conversations…"). */
export function importingNow(): { done: number; total: number } | null {
  const pr = importProgress();
  return pr.running ? { done: pr.bytesDone, total: pr.bytesTotal } : null;
}

export { GENERAL };
