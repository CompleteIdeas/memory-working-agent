/**
 * Fixture mode for slice W4 (v2 build): projects and their threads, and Ask — answered like the server answers them
 * (src/api/routes/projects.ts, src/api/routes/ask.ts, src/v2/ask.ts), from the prototype's example day. Everything
 * here is example data; tests/web-v2-fixtures.test.ts validates every response against api/openapi.yaml.
 *
 * What it does:
 *   - projects: create (409 name_taken), rename / icon / archive / restore (409 general), the thread a page at a time
 *     (`before` = a position "ts:<ts>:<id>", still valid after a move), its work, its files;
 *   - a message or an ask that is answered now: a `running` turn, two `live` step events on the stream, then the
 *     answer as a NEW turn with the same runId (the running turn retires, as on the server); Stop and Steer while it
 *     runs (409 nothing_running otherwise, 409 busy for a second message meanwhile);
 *   - routing: GET /projects/suggest by keywords (horse/Willow/rules → Eventing, Riley/school/book fair → Family…);
 *   - a big ask comes back as a plan (N04): files over 40 pages, or "learn everything / go through all / review all /
 *     triage / read all" — "This is a big read — 149 pages, about 20 minutes…", "Do it now · about 40¢", "In the
 *     background · about 15¢ · ready around 10:10 AM", narrower asks as the server labels them (one per file; a
 *     model's proposal without pages or price), the limit 30¢;
 *   - choose: now (an answer), background (a job "Learning your 2 eventing PDFs" and the thread's line), narrow (the
 *     narrower ask, answered); the same choice again replays (200), another is 409 already_chosen; a plan more than a
 *     day old is 410 expired (ask with "[old]" in the text to get one); a file that is gone is 409 files_gone (a file
 *     whose name has "gone" in it, or `forgetFile`); an archived project is 409 archived;
 *   - the older offer ("research …" asks): an offer turn, accepted with POST /projects/{id}/offer/accept;
 *   - "Ask about this": suggestions and the asks about a thing; canned answers ("4¢ so far.", the book fair's "Sam’s
 *     family is going…" using what I know from Eventing);
 *   - scenario `thread-long`: Eventing has 80 older turns (paging).
 * Tests: `answerDelay = 0` answers at once; `answerDelay = -1` holds every run until `flushRuns(fx)`.
 */
import type { FixtureResponse, FixtureServer } from './fixtures';
import { job, turn } from './fixtures';
import { EMAILS, ITEMS, PROJECTS } from './fixture-data';
import type { Job, Project, Schemas, Turn } from '../api/client';

type Ask = Schemas['Ask'];
type AskStart = Schemas['AskStart'];
type AskChosen = Schemas['AskChosen'];
type AskPlan = Schemas['AskPlan'];
type AskFile = Schemas['AskFile'];
type Route = Schemas['AskRoute'];
type AboutKind = Schemas['AskAbout']['kind'];

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const err = (status: number, code: string, message: string): FixtureResponse => ({ status, body: { error: { code, message } } });
const ok = (body: unknown, status = 200): FixtureResponse => ({ status, body });

/** The prototype's two eventing PDFs (data.js D.PAGES); any other file counts 40 pages. */
export const FIXTURE_PAGES: Record<string, number> = { 'icp-eventing-handbook.pdf': 76, 'usef-eventing-rules-2025.pdf': 73 };
const OFFER_TEXT = 'This could take a while. Want me to work on it in the background and tell you when it’s done?';

interface Run { runId: string; turnId: string; projectId: string; text: string; askId?: string; about?: { kind: string; id: string } | null; steered: string[]; stopped: boolean; n: number }
interface W4State {
  n: number;
  lastTs: number;                      // the fixture clock is frozen: new turns still come in order
  runs: Map<string, Run>;              // by project id: the answer being written there
  held: (() => void)[];                // answerDelay < 0: steps waiting for flushRuns
  gone: Set<string>;                   // files that are no longer there
  files: Map<string, { path: string; size: number; mtime: number }[]>;
  results: Map<string, { choice: string; res: AskChosen }>;
}
const STATE = new WeakMap<FixtureServer, W4State>();
function st(fx: FixtureServer): W4State {
  let s = STATE.get(fx);
  if (!s) { s = { n: 0, lastTs: 0, runs: new Map(), held: [], gone: new Set(), files: new Map(), results: new Map() }; STATE.set(fx, s); }
  return s;
}
/** A turn's time: the (frozen) clock, but always after the last turn made here, so a thread keeps its order. */
function tick(fx: FixtureServer): number { const s = st(fx); s.lastTs = Math.max(fx.now(), s.lastTs + 1_000); return s.lastTs; }
/** Tests: a file the plan reads disappears. */
export function forgetFile(fx: FixtureServer, path: string) { st(fx).gone.add(path); }
/** Tests (answerDelay < 0): run every step waiting, in order, until none is left. */
export function flushRuns(fx: FixtureServer) { const s = st(fx); for (let i = 0; i < 100 && s.held.length; i++) { const f = s.held.shift()!; f(); } }
function later(fx: FixtureServer, fn: () => void, frac: number) {
  if (fx.answerDelay < 0) { st(fx).held.push(fn); return; }
  fx.later(fn, fx.answerDelay <= 0 ? 0 : Math.round(fx.answerDelay * frac));
}

// ---------- seed ----------
export function w4Seed(fx: FixtureServer, now: number) {
  const s = st(fx);
  // Family & school: a question asked about the book fair (N11), answered with what was known from Eventing
  fx.putTurn(turn({ id: 't_family_about', projectId: 'family', ts: now - 2 * HOUR, message: 'Who else is going?', about: { kind: 'item', id: 'it_bookfair' },
    reply: 'Sam’s family is going — they’re heading over after the schooling day, so 3pm works.', provenance: [{ projectId: 'eventing', name: 'Eventing', n: 1 }], runId: 'run_seed_about' }));
  // Eventing: a conversation from before projects, imported (a divider, then its turns)
  const old = now - 18 * DAY;
  fx.putTurn(turn({ id: 't_eventing_div', projectId: 'eventing', kind: 'divider', ts: old, message: 'Conversation from Oct 22: Willow’s lessons', reply: '', legacySession: 'web-1022' }));
  fx.putTurn(turn({ id: 't_eventing_old1', projectId: 'eventing', ts: old + MINUTE, message: 'What did Ellen say about Willow’s canter?', reply: 'Keep the canter rhythm steady before the fences, and shorten your reins a hole on cross-country.', legacySession: 'web-1022' }));
  fx.putTurn(turn({ id: 't_eventing_old2', projectId: 'eventing', ts: old + 2 * MINUTE, message: 'Remind me what studs she likes.', reply: 'Small road studs behind for the dressage; the grass studs for cross-country if it rained.', legacySession: 'web-1022' }));
  if (fx.scenario === 'thread-long') {
    for (let i = 0; i < 80; i++) {
      fx.putTurn(turn({ id: `t_eventing_long${String(i).padStart(2, '0')}`, projectId: 'eventing', ts: old - (80 - i) * HOUR, message: `Old question ${i + 1}`, reply: `Old answer ${i + 1}.`, legacySession: 'web-1001' }));
    }
  }
  // files: the eventing notes; the AI newsletter's draft
  s.files.set('eventing', [
    { path: 'serve/p-eventing/willow-lesson-notes-nov3.md', size: 2_140, mtime: now - 6 * DAY },
    { path: 'serve/web-1022/uploads/stable-view-schedule.pdf', size: 184_320, mtime: now - 18 * DAY },
  ]);
  s.files.set('ainews', [{ path: 'serve/p-ainews/candidates-week45.md', size: 3_870, mtime: now - 30 * MINUTE }]);
}

// ---------- reads ----------
export function w4Read(fx: FixtureServer, path: string, q: URLSearchParams): FixtureResponse | null {
  let m: RegExpExecArray | null;
  if (path === '/projects/suggest') {
    const text = q.get('text') ?? '';
    if (!text.trim()) return err(400, 'bad_text', 'Send the words to route.');
    return ok(suggest(fx, text, q.get('from')));
  }
  if ((m = /^\/projects\/([^/]+)\/thread$/.exec(path))) {
    const p = fx.projects.get(decodeURIComponent(m[1]));
    if (!p) return err(404, 'not_found', 'No such project.');
    const limit = Math.min(200, Math.max(1, Number(q.get('limit') ?? 50) || 50));
    let turns = threadOf(fx, p.id);
    const before = q.get('before');
    if (before) {
      const c = /^ts:(\d+):(.+)$/.exec(before);
      if (!c) return err(400, 'bad_cursor', 'That `before` is not a thread position.');
      const ts = Number(c[1]), id = c[2];
      turns = turns.filter((t) => t.ts < ts || (t.ts === ts && t.id < id));
    }
    const page = turns.slice(-limit);
    const first = page[0];
    const next = first && turns.length > page.length ? `ts:${first.ts}:${first.id}` : null;
    return ok({ project: p, turns: page, next });
  }
  if ((m = /^\/projects\/([^/]+)\/files$/.exec(path))) {
    const id = decodeURIComponent(m[1]);
    if (!fx.projects.get(id)) return err(404, 'not_found', 'No such project.');
    const files = [...(st(fx).files.get(id) ?? [])].sort((a, b) => b.mtime - a.mtime);
    return ok({ folder: `serve/p-${id}`, files });
  }
  if ((m = /^\/projects\/([^/]+)\/work$/.exec(path))) {
    const id = decodeURIComponent(m[1]);
    const p = fx.projects.get(id);
    if (!p) return err(404, 'not_found', 'No such project.');
    return ok({ jobs: [...fx.jobs.values()].filter((j) => !j.archived && (j.projectId === id || (p.general && !j.projectId))).sort((a, b) => b.updatedSeq - a.updatedSeq) });
  }
  if (path === '/ask/suggestions' || path === '/ask') {
    const about = parseAbout(q.get('about'));
    if (!about) return err(400, 'bad_about', '`about` is kind:id.');
    const ctx = aboutOf(fx, about.kind, about.id);
    if (!ctx) return err(404, 'not_found', 'No such thing to ask about.');
    const head = { kind: about.kind, id: about.id, label: ctx.label };
    if (path === '/ask/suggestions') return ok({ about: head, suggestions: suggestionsFor(about.kind, about.id) });
    const asks = [...fx.asks.values()].filter((a) => a.about?.kind === about.kind && a.about?.id === about.id).sort((a, b) => a.createdAt - b.createdAt);
    return ok({ about: head, asks });
  }
  if ((m = /^\/ask\/([^/]+)$/.exec(path))) {
    const a = fx.asks.get(decodeURIComponent(m[1]));
    if (!a) return err(404, 'not_found', 'No such ask.');
    expireIfStale(fx, a);
    const t = a.turnId ? fx.turns.get(a.turnId) ?? null : null;
    return ok({ ask: fx.asks.get(a.id), turn: t });
  }
  return null;
}

// ---------- writes ----------
export function w4Write(fx: FixtureServer, method: string, path: string, body: unknown): FixtureResponse | null {
  let m: RegExpExecArray | null;
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (method === 'POST' && path === '/projects') {
    const name = String(b.name ?? '').trim();
    if (!name || name.length > 60) return err(400, 'bad_name', 'A project needs a name of 1 to 60 letters.');
    if ([...fx.projects.values()].some((p) => !p.archived && p.name.toLowerCase() === name.toLowerCase())) return err(409, 'name_taken', `You already have a project called ${name}.`);
    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'project'}-${++st(fx).n}`;
    const sort = Math.max(0, ...[...fx.projects.values()].map((p) => p.sort)) + 1;
    fx.putProject({ id, name, icon: typeof b.icon === 'string' ? b.icon : null, createdAt: fx.now(), sort, archived: false, general: false, updatedSeq: 0 });
    return ok({ project: fx.projects.get(id) }, 201);
  }
  if (method === 'PATCH' && (m = /^\/projects\/([^/]+)$/.exec(path))) {
    const p = fx.projects.get(decodeURIComponent(m[1]));
    if (!p) return err(404, 'not_found', 'No such project.');
    if (!Object.keys(b).length) return err(400, 'bad_body', 'Send what to change.');
    if (b.archived === true && p.general) return err(409, 'general', 'General can’t be archived.');
    const next: Project = { ...p };
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name || name.length > 60) return err(400, 'bad_name', 'A project needs a name of 1 to 60 letters.');
      if ([...fx.projects.values()].some((x) => x.id !== p.id && !x.archived && x.name.toLowerCase() === name.toLowerCase())) return err(409, 'name_taken', `You already have a project called ${name}.`);
      next.name = name;
    }
    if (b.icon !== undefined) next.icon = typeof b.icon === 'string' ? b.icon : null;
    if (typeof b.archived === 'boolean') next.archived = b.archived;
    if (typeof b.sort === 'number') next.sort = b.sort;
    fx.putProject(next);
    return ok({ project: fx.projects.get(p.id) });
  }
  if (method === 'POST' && (m = /^\/projects\/([^/]+)\/messages$/.exec(path))) {
    const p = fx.projects.get(decodeURIComponent(m[1]));
    if (!p) return err(404, 'not_found', 'No such project.');
    const text = String(b.text ?? '').trim();
    if (!text) return err(400, 'bad_text', 'Write something to send.');
    if (st(fx).runs.has(p.id)) return err(409, 'busy', `I’m still writing an answer in ${p.name}. Add this to it, or wait a moment.`);
    if (!b.stay && /\bresearch\b/i.test(text)) { const o = offer(fx, p, text); return ok({ session: `p-${p.id}`, state: 'offer', turnId: o, message: OFFER_TEXT }, 202); }
    const r = startRun(fx, p, text, {});
    return ok({ session: `p-${p.id}`, state: 'started', runId: r.runId, turnId: r.turnId }, 202);
  }
  if (method === 'POST' && (m = /^\/projects\/([^/]+)\/(stop|steer)$/.exec(path))) {
    const p = fx.projects.get(decodeURIComponent(m[1]));
    if (!p) return err(404, 'not_found', 'No such project.');
    const run = st(fx).runs.get(p.id);
    if (m[2] === 'steer') {
      const text = String(b.text ?? '').trim();
      if (!text) return err(400, 'bad_text', 'Nothing to add.');
      if (!run) return err(409, 'nothing_running', 'Nothing is running in this project. Send it as a message.');
      run.steered.push(text);
      return ok({ added: true, message: 'Added to the running answer. It is taken into account from the next step.' });
    }
    if (!run) return err(409, 'nothing_running', 'Nothing is running in this project.');
    run.stopped = true;
    fx.live(`p-${p.id}`, 'stopping', {}, (fx.turns.get(run.turnId)?.ts ?? fx.now()) + 3_000);
    later(fx, () => finishRun(fx, run), 0.2);
    return ok({ stopped: true, message: 'Stopping. The step that is running finishes; nothing new starts.' });
  }
  if (method === 'POST' && (m = /^\/projects\/([^/]+)\/offer\/accept$/.exec(path))) {
    const p = fx.projects.get(decodeURIComponent(m[1]));
    if (!p) return err(404, 'not_found', 'No such project.');
    const waiting = threadOf(fx, p.id).filter((t) => t.kind === 'offer' && !t.offer && (!b.message || t.message === b.message));
    const t = waiting[waiting.length - 1];
    if (!t) return err(409, 'no_offer', 'There is no waiting offer to accept here.');
    const now = fx.now();
    const goal = `g_${++st(fx).n}`;
    fx.putTurn({ ...t, offer: { answered: 'background', goal, at: now } });
    fx.putJob(job({ id: `j_offer_${st(fx).n}`, title: titleFor(t.message), projectId: p.id, createdAt: now, request: t.message, capUsd: 0.5,
      status: { state: 'working', label: 'Working', detail: 'Working on it now.', primaryAction: { action: 'stop', label: 'Stop' } } }));
    return ok({ goal, message: 'Started in the background. I’ll post the result here when it’s done.' }, 202);
  }
  if (method === 'POST' && (m = /^\/turns\/([^/]+)\/move$/.exec(path))) {
    const t = fx.turns.get(decodeURIComponent(m[1]));
    if (!t) return err(404, 'not_found', 'No such message.');
    const to = fx.projects.get(String(b.projectId ?? ''));
    if (!to) return err(404, 'not_found', 'No such project.');
    if (to.archived) return err(409, 'archived', `${to.name} is archived. Restore it first.`);
    if (t.kind === 'running') return err(409, 'running', 'Its answer is still being written. Move it once it is done.');
    if (t.kind === 'divider') return err(400, 'bad_turn', 'A divider stays where it is.');
    const from = t.projectId;
    if (from !== to.id) fx.putTurn({ ...t, projectId: to.id, movedFrom: from });
    return ok({ turn: fx.turns.get(t.id), from, message: `Moved to ${to.name}.`, undo: { projectId: from } });
  }
  if (method === 'POST' && path === '/ask') return askPost(fx, b);
  if (method === 'POST' && (m = /^\/ask\/([^/]+)\/choose$/.exec(path))) return choose(fx, decodeURIComponent(m[1]), b);
  return null;
}

// ---------- runs ----------
function threadOf(fx: FixtureServer, projectId: string): Turn[] {
  return [...fx.turns.values()].filter((t) => t.projectId === projectId).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
}

function startRun(fx: FixtureServer, p: Project, text: string, o: { askId?: string; about?: { kind: AboutKind; id: string } | null; pages?: number; focus?: string }): Run {
  const s = st(fx);
  const n = ++s.n;
  const run: Run = { runId: `run_w4_${n}`, turnId: `t_${p.id}_r${n}`, projectId: p.id, text, askId: o.askId, about: o.about ?? null, steered: [], stopped: false, n };
  s.runs.set(p.id, run);
  const startedAt = tick(fx);
  fx.putTurn(turn({ id: run.turnId, projectId: p.id, ts: startedAt, kind: 'running', message: text, reply: '', runId: run.runId, about: o.about ?? null }));
  const of = o.pages ? Math.min(120, Math.ceil(o.pages / 3) + 2) : 8;
  later(fx, () => { if (s.runs.get(p.id) === run && !run.stopped) fx.live(`p-${p.id}`, 'step', { n: 1, of, tool: 'recall', detail: 'what I know', elapsedMs: 900 }, startedAt + 900); }, 0.3);
  later(fx, () => { if (s.runs.get(p.id) === run && !run.stopped) fx.live(`p-${p.id}`, 'step', { n: 2, of, tool: o.pages ? 'read_document' : 'think', detail: '', elapsedMs: 2_100 }, startedAt + 2_100); }, 0.6);
  later(fx, () => finishRun(fx, run, o), 1);
  return run;
}

function finishRun(fx: FixtureServer, run: Run, o: { pages?: number; focus?: string } = {}) {
  const s = st(fx);
  if (s.runs.get(run.projectId) !== run) return;
  s.runs.delete(run.projectId);
  const p = fx.projects.get(run.projectId);
  const canned = answerFor(fx, run.text, run.about ?? null, p, o);
  let reply = canned.reply;
  if (run.steered.length) reply += ` (You added: ${run.steered.join('; ')} — I took that into account.)`;
  if (run.stopped) reply = `Stopped by you. Here’s what I had so far: ${canned.reply.slice(0, 120)}`;
  // the running turn retires; the answer is a new turn with the same run (as the server does)
  fx.turns.delete(run.turnId);
  fx.emit('turn', run.turnId, 'delete');
  const id = `t_${run.projectId}_a${run.n}`;
  fx.putTurn(turn({ id, projectId: run.projectId, ts: tick(fx), message: run.text, reply, runId: run.runId, about: run.about ?? null, provenance: canned.provenance, reason: run.stopped ? 'stopped' : 'done' }));
  if (run.askId) {
    const a = fx.asks.get(run.askId);
    if (a) fx.putAsk({ ...a, state: 'answered', turnId: id, runId: run.runId, answer: reply });
  }
}

function offer(fx: FixtureServer, p: Project, text: string): string {
  const id = `t_${p.id}_o${++st(fx).n}`;
  fx.putTurn(turn({ id, projectId: p.id, ts: tick(fx), kind: 'offer', message: text, reply: OFFER_TEXT }));
  return id;
}

/** Canned answers: the prototype's where it has one, otherwise the example app saying so. */
function answerFor(fx: FixtureServer, text: string, about: { kind: string; id: string } | null, p: Project | undefined, o: { pages?: number; focus?: string }): { reply: string; provenance: Turn['provenance'] } {
  const t = text.toLowerCase();
  const eventing = (p?.id !== 'eventing' ? [{ projectId: 'eventing', name: 'Eventing', n: 2 }] : []);
  if (about?.kind === 'job') {
    const j = fx.jobs.get(about.id);
    if (j && /cost/.test(t)) return { reply: `${centsText(j.costUsd)} so far.`, provenance: [] };
    if (j && /done|when/.test(t)) return { reply: j.progress ? `About 10 minutes more: ${j.progress.done} of ${j.progress.total} ${j.progress.unit} are done.` : 'Soon — it’s on its last step.', provenance: [] };
    if (j && /left/.test(t)) return { reply: j.remaining ?? (j.progress ? `${j.progress.total - j.progress.done} ${j.progress.unit} are left.` : 'Just the write-up.'), provenance: [] };
  }
  if (about?.kind === 'item' && about.id === 'i-bookfair' && /who/.test(t)) return { reply: 'Sam’s family is going — they’re heading over after the schooling day, so 3pm works.', provenance: [{ projectId: 'eventing', name: 'Eventing', n: 1 }] };
  if (o.pages) return { reply: `I read all ${o.pages} pages${o.focus ? `, focusing on ${o.focus}` : ''} and kept notes with page numbers. (Example app: nothing was really read.)`, provenance: [] };
  if (o.focus) return { reply: `I read ${o.focus} and kept notes with page numbers. (Example app: nothing was really read.)`, provenance: [] };
  if (/move up|moving up|level|rule/.test(t)) return { reply: 'To move up you need qualifying results at your current level within the last 12 months — USEF rules, Appendix 2, pages 49–55.', provenance: eventing };
  if (/bring|pack/.test(t)) return { reply: 'Willow’s studs and the cross-country vest — you noted that after last week’s lesson.', provenance: eventing };
  return { reply: `This is the example app, so nothing was really asked. In the real app your helper answers “${text.slice(0, 80)}” here, in ${p?.name ?? 'General'}.`, provenance: [] };
}
function centsText(usd: number): string { return usd < 1 ? `${Math.round(usd * 100)}¢` : `$${usd.toFixed(2)}`; }
function clockText(ms: number): string { return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
function titleFor(text: string): string { const t = text.trim().replace(/[.?!]+$/, ''); return t.length > 60 ? `${t.slice(0, 57)}…` : t[0].toUpperCase() + t.slice(1); }

// ---------- routing ----------
const KEYWORDS: [string, RegExp][] = [
  ['eventing', /\b(horse|willow|eventing|ellen|stable view|schooling|dressage|cross[- ]country|farrier|studs?|usef|icp|rules?|move up|level)\b/i],
  ['family', /\b(riley|school|book fair|pta|dentist|library|soccer|kids?|oakwood|family)\b/i],
  ['ainews', /\b(newsletter|ai news|dana|stor(y|ies)|the batch|issue)\b/i],
  ['house', /\b(gutter|garden|house|quote|hillside|roof|plumb)/i],
  ['health', /\b(doctor|health|prescription|pharmacy|checkup|gym)\b/i],
];
function suggest(fx: FixtureServer, text: string, from: string | null): Schemas['Suggestion'] {
  const live = [...fx.projects.values()].filter((p) => !p.archived);
  const scores = KEYWORDS.map(([id, re]) => [id, (text.match(new RegExp(re.source, 'gi')) ?? []).length] as const)
    .filter(([id, n]) => n > 0 && live.some((p) => p.id === id)).sort((a, b) => b[1] - a[1]);
  const name = (id: string) => fx.projects.get(id)?.name ?? id;
  if (from && from !== 'general' && fx.projects.get(from)) {
    const alt = scores.find(([id]) => id !== from);
    return { projectId: from, confidence: 'this project', alternatives: alt ? [{ projectId: alt[0], name: name(alt[0]), score: 0.6 }] : [] };
  }
  if (!scores.length) return { projectId: 'general', confidence: 'not sure', alternatives: [] };
  const [best, ...rest] = scores;
  if (rest.length && rest[0][1] === best[1]) return { projectId: 'general', confidence: 'not sure', alternatives: scores.slice(0, 2).map(([id]) => ({ projectId: id, name: name(id), score: 0.5 })) };
  return { projectId: best[0], confidence: 'suggested', alternatives: rest.slice(0, 1).map(([id]) => ({ projectId: id, name: name(id), score: 0.4 })) };
}

// ---------- about ----------
function parseAbout(raw: string | null): { kind: AboutKind; id: string } | null {
  const m = /^(item|mail|event|draft|job|conflict):(.+)$/.exec(raw ?? '');
  return m ? { kind: m[1] as AboutKind, id: m[2] } : null;
}
function aboutOf(fx: FixtureServer, kind: AboutKind, id: string): { label: string; projectId: string | null } | null {
  if (kind === 'job') { const j = fx.jobs.get(id); return j ? { label: j.title, projectId: j.projectId } : null; }
  if (kind === 'item') { const i = ITEMS.find((x) => x.id === id); return i ? { label: i.title, projectId: i.project ?? null } : null; }
  if (kind === 'mail') { const e = EMAILS.find((x) => `m_${x.id}` === id || x.id === id); return e ? { label: e.subject, projectId: e.project ?? null } : null; }
  if (kind === 'event' || kind === 'draft') { const c = fx.calendar.get(id); return c ? { label: c.title, projectId: null } : null; }
  if (kind === 'conflict') { const [a, b] = id.split('|').map((x) => fx.calendar.get(x)); return a && b ? { label: `${a.title} / ${b.title}`, projectId: null } : null; }
  return null;
}
function suggestionsFor(kind: AboutKind, id: string): string[] {
  if (kind === 'job') return ['When will it be done?', 'What’s left?', 'What has it cost?'];
  if (kind === 'item' && id === 'i-bookfair') return ['Who else is going?', 'Remind me the day before', 'What did the newsletter say about volunteers?'];
  if (kind === 'item') return ['Why does this matter?', 'What should I do about it?'];
  if (kind === 'mail') return ['Why does this matter?', 'What did they ask last time?'];
  if (kind === 'event') return ['What should I bring?', 'Remind me the day before'];
  if (kind === 'draft') return ['Where did this come from?', 'Is the time right?'];
  return ['Which one should move?', 'Draft a note to fix it'];
}

// ---------- Ask ----------
function askRecord(fx: FixtureServer, a: Partial<Ask> & Pick<Ask, 'text' | 'projectId' | 'route' | 'kind'>): Ask {
  const id = `ask_${++st(fx).n}`;
  const rec: Ask = { id, createdAt: fx.now(), mode: 'auto', about: null, files: [], source: 'typed', plan: null, state: 'running', choice: null, jobId: null, runId: null,
    turnId: null, answer: null, tainted: null, capUsd: null, parentId: null, focus: null, updatedSeq: 0, ...a };
  fx.putAsk(rec);
  return fx.asks.get(id)!;
}

function routeOf(fx: FixtureServer, text: string, projectId: unknown, about: { projectId: string | null } | null): Route | FixtureResponse {
  if (projectId !== undefined && projectId !== null) {
    const p = fx.projects.get(String(projectId));
    if (!p) return err(404, 'not_found', 'No such project.');
    if (p.archived) return err(409, 'archived', `${p.name} is archived. Restore it first.`);
    return { projectId: p.id, name: p.name, confidence: 'given', alternatives: [] };
  }
  if (about) {
    const own = about.projectId ? fx.projects.get(about.projectId) : undefined;
    const p = own && !own.archived ? own : fx.projects.get('general')!;
    return { projectId: p.id, name: p.name, confidence: 'about', alternatives: [] };
  }
  const s = suggest(fx, text, null);
  return { projectId: s.projectId, name: fx.projects.get(s.projectId)?.name ?? 'General', confidence: s.confidence === 'suggested' ? 'suggested' : 'not sure', alternatives: s.alternatives };
}

const BIG = /\b(learn everything|go through all|review all|triage|read all|read everything)\b/i;
function filesOf(paths: unknown): AskFile[] | FixtureResponse {
  if (paths === undefined || paths === null) return [];
  if (!Array.isArray(paths) || paths.length > 10 || paths.some((x) => typeof x !== 'string' || !x)) return err(400, 'bad_files', '`files` is a list of up to 10 file paths (as an upload returns them).');
  return [...new Set(paths as string[])].map((path) => {
    const name = path.split('/').pop() ?? path;
    const pages = FIXTURE_PAGES[name] ?? 40;
    return { path, name, pages, reads: Math.max(1, Math.ceil(pages / 3)) };
  });
}
/** As the server says a file's name in a narrower ask (src/v2/ask.ts prettyName): no extension, dashes as spaces. */
const prettyName = (n: string) => n.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[-_]+/g, ' ').trim().slice(0, 40) || 'the file';

function buildPlan(fx: FixtureServer, text: string, files: AskFile[]): AskPlan {
  const now = fx.now();
  const pages = files.reduce((s, f) => s + f.pages, 0);
  const guess = !files.length;
  const said = (usd: number) => `${guess ? 'a first guess, ' : ''}about ${centsText(usd)}`;
  const nowUsd = guess ? 0.6 : 0.4, bgUsd = guess ? 0.2 : 0.15, readyAt = now + 60 * MINUTE;
  // one per file when there are two or more (the server's narrowFromFiles); a narrower ask keeps only its own file,
  // so its focus is "the first attached file"
  const narrow: AskPlan['narrow'] = files.length < 2 ? [] : files.slice(0, 3).map((f) => ({ label: `Only ${prettyName(f.name)} · ${f.pages} pages, about 8¢`, focus: `the first attached file (${f.pages} pages)`, files: [f.path], pages: f.pages, usd: 0.08, by: 'file' as const }));
  if (files.length && /rule|level|learn/i.test(text)) narrow.push({ label: 'Just the rules for moving up a level', focus: 'Just the rules for moving up a level', files: files.map((f) => f.path), by: 'model' });
  return {
    size: pages ? { pages } : { sources: 12 },
    message: pages ? `This is a big read — ${pages} pages, about 20 minutes. Do it now, or in the background for less and I’ll tell you when it’s done?`
      : 'This is a big job — about 12 sources to go through, about 20 minutes. Do it now, or in the background for less and I’ll tell you when it’s done?',
    reasons: pages > 40 ? ['pages'] : ['wording'],
    now: { usd: nowUsd, ms: 20 * MINUTE, label: `Do it now · ${said(nowUsd)}`, firstGuess: guess, capDefault: 0.5, steps: Math.min(120, Math.max(40, Math.ceil(pages / 3) + 2)), fits: true },
    background: { usd: bgUsd, ms: 60 * MINUTE, label: `In the background · ${said(bgUsd)} · ready around ${clockText(readyAt)}`, firstGuess: guess, capDefault: 0.3, readyAt },
    narrow: narrow.slice(0, 3), capDefault: 0.3, basis: guess ? 'default' : 'history',
  };
}

function askPost(fx: FixtureServer, b: Record<string, unknown>): FixtureResponse {
  const text = String(b.text ?? '').trim();
  if (!text) return err(400, 'bad_text', 'Nothing to ask.');
  const mode = (b.mode ?? 'auto') as 'auto' | 'now' | 'background';
  if (!['auto', 'now', 'background'].includes(mode)) return err(400, 'bad_mode', '`mode` is auto, now or background.');
  const cap = b.capUsd;
  if (cap !== undefined && (typeof cap !== 'number' || cap < 0.01 || cap > 20)) return err(400, 'bad_cap', '`capUsd` is a dollar amount from 0.01 to 20.');
  const aboutIn = b.about && typeof b.about === 'object' ? b.about as { kind?: unknown; id?: unknown } : null;
  const about = aboutIn ? parseAbout(`${String(aboutIn.kind)}:${String(aboutIn.id)}`) : null;
  if (aboutIn && !about) return err(400, 'bad_about', '`about` is {kind, id}: kind is item, mail, event, draft, job or conflict.');
  if (about && b.files != null) return err(400, 'bad_files', 'A question about one thing takes no files.');
  const ctx = about ? aboutOf(fx, about.kind, about.id) : null;
  if (about && !ctx) return err(404, 'not_found', about.kind === 'item' ? 'No such item.' : `No such ${about.kind}.`);
  const files = filesOf(b.files);
  if (!Array.isArray(files)) return files;
  const route = routeOf(fx, text, b.projectId, ctx);
  if ('status' in route) return route;
  const p = fx.projects.get(route.projectId)!;
  const head = (a: Ask): AskStart => ({ askId: a.id, projectId: a.projectId, route, kind: a.kind, ...(about && ctx ? { about: { kind: about.kind, id: about.id, label: ctx.label } } : {}) });
  const busy = () => err(409, 'busy', `I’m still writing an answer in ${p.name}. Add this to it, or wait a moment.`);

  if (about) {
    if (mode === 'background') return err(400, 'bad_mode', 'A question about one thing is answered now.');
    if (st(fx).runs.has(p.id)) return busy();
    const a = askRecord(fx, { text, projectId: p.id, route, kind: 'answer', mode: 'now', about: { kind: about.kind, id: about.id }, tainted: true });
    const run = startRun(fx, p, text, { askId: a.id, about });
    fx.putAsk({ ...fx.asks.get(a.id)!, runId: run.runId, turnId: run.turnId });
    return ok({ ...head(a), state: 'started', runId: run.runId, turnId: run.turnId, budget: { maxSteps: 8, maxUsd: 0.05 }, tainted: true }, 202);
  }
  const pages = files.reduce((s, f) => s + f.pages, 0);
  const big = pages > 40 || BIG.test(text);
  const old = /\[old\]/i.test(text);
  if (mode === 'background') {
    const plan = big ? buildPlan(fx, text, files) : null;
    const a = askRecord(fx, { text, projectId: p.id, route, kind: 'job', mode, files, plan, state: 'choosing' });
    const res = background(fx, a, p, files, typeof cap === 'number' ? cap : 0.3, plan);
    return ok({ ...head(fx.asks.get(a.id)!), ...res }, 202);
  }
  if (mode === 'auto' && big) {
    const plan = buildPlan(fx, text, files);
    const a = askRecord(fx, { text, projectId: p.id, route, kind: 'plan', mode, files, plan, state: 'planned', capUsd: typeof cap === 'number' ? cap : null, ...(old ? { createdAt: fx.now() - 25 * HOUR } : {}) });
    return ok({ ...head(a), plan }, 202);
  }
  if (st(fx).runs.has(p.id)) return busy();
  if (mode === 'auto' && /\bresearch\b/i.test(text)) {
    const a = askRecord(fx, { text, projectId: p.id, route, kind: 'answer', mode, files, state: 'offered' });
    const t = offer(fx, p, text);
    fx.putAsk({ ...fx.asks.get(a.id)!, turnId: t });
    return ok({ ...head(a), state: 'offer', message: OFFER_TEXT, turnId: t }, 202);
  }
  const a = askRecord(fx, { text, projectId: p.id, route, kind: 'answer', mode, files, capUsd: typeof cap === 'number' ? cap : null });
  const run = startRun(fx, p, text, { askId: a.id, pages: pages || undefined });
  fx.putAsk({ ...fx.asks.get(a.id)!, runId: run.runId, turnId: run.turnId });
  return ok({ ...head(fx.asks.get(a.id)!), state: 'started', runId: run.runId, turnId: run.turnId, ...(typeof cap === 'number' ? { capUsd: cap } : {}) }, 202);
}

/** Hand an ask to the background: a Job on the background tier with its limit, and the thread's line. */
function background(fx: FixtureServer, a: Ask, p: Project, files: AskFile[], capUsd: number, plan: AskPlan | null) {
  const now = fx.now();
  const pages = files.reduce((s, f) => s + f.pages, 0);
  const usd = plan?.background.usd ?? 0.15, ms = plan?.background.ms ?? 60 * MINUTE, readyAt = now + ms;
  const n = ++st(fx).n;
  const title = files.length && /eventing|icp|usef/i.test(files.map((f) => f.name).join(' ')) ? `Learning your ${files.length} eventing PDF${files.length === 1 ? '' : 's'}` : titleFor(a.text);
  const j: Job = job({ id: `j_ask_${n}`, title, projectId: p.id, createdAt: now, request: a.text, capUsd, costUsd: 0.01, progress: pages ? { done: 0, total: pages, unit: 'pages' } : null,
    estimate: { startOver: { usd, ms }, basis: plan?.basis ?? 'default', samples: 0 },
    status: { state: 'working', label: 'Working', detail: pages ? `Working on it — 0 of ${pages} pages read so far.` : 'Working on it now.', primaryAction: { action: 'stop', label: 'Stop' } } });
  fx.putJob(j);
  const reply = `On it. I’ll work on this in the background — about ${centsText(usd)}, ready around ${clockText(readyAt)} — and post the result here when it’s done. I’ll stop and ask if it would cost more than $${capUsd.toFixed(2)}.`;
  const turnId = `t_${p.id}_b${n}`;
  fx.putTurn(turn({ id: turnId, projectId: p.id, ts: tick(fx), kind: 'offer', message: a.text, reply, offer: { answered: 'background', goal: `g_${n}`, at: now } }));
  fx.putAsk({ ...fx.asks.get(a.id)!, state: 'queued', jobId: j.id, capUsd, turnId });
  // files added to the ask are kept in the project's folder
  if (files.length) st(fx).files.set(p.id, [...(st(fx).files.get(p.id) ?? []), ...files.map((f) => ({ path: `serve/p-${p.id}/uploads/${f.name}`, size: f.pages * 25_000, mtime: now }))]);
  return { jobId: j.id, tier: 'background' as const, capUsd, estimate: { usd, ms }, readyAt, message: reply, turnId };
}

function expireIfStale(fx: FixtureServer, a: Ask): Ask {
  if (a.kind === 'plan' && a.state === 'planned' && fx.now() - a.createdAt > DAY) { fx.putAsk({ ...a, state: 'expired' }); return fx.asks.get(a.id)!; }
  return a;
}

function choose(fx: FixtureServer, id: string, b: Record<string, unknown>): FixtureResponse {
  const hasNarrow = b.narrowIndex !== undefined && b.narrowIndex !== null;
  if (hasNarrow === (b.mode !== undefined && b.mode !== null)) return err(400, 'bad_choice', 'Choose `mode` (now or background) or `narrowIndex`.');
  if (!hasNarrow && b.mode !== 'now' && b.mode !== 'background') return err(400, 'bad_choice', '`mode` is now or background.');
  const cap = b.capUsd;
  if (cap !== undefined && (typeof cap !== 'number' || cap < 0.01 || cap > 20)) return err(400, 'bad_cap', '`capUsd` is a dollar amount from 0.01 to 20.');
  const a0 = fx.asks.get(id);
  if (!a0) return err(404, 'not_found', 'No such ask.');
  if (a0.kind !== 'plan' || !a0.plan) return err(409, 'not_a_plan', 'That ask is not waiting for a choice.');
  const plan = a0.plan;
  if (hasNarrow && (!Number.isInteger(b.narrowIndex) || (b.narrowIndex as number) < 0 || (b.narrowIndex as number) >= plan.narrow.length)) return err(400, 'bad_choice', 'There is no narrower ask at that position.');
  const choice = JSON.stringify(hasNarrow ? { narrowIndex: b.narrowIndex, ...(cap ? { capUsd: cap } : {}) } : { mode: b.mode, ...(cap ? { capUsd: cap } : {}) });
  const a = expireIfStale(fx, a0);
  if (a.state === 'expired') return err(410, 'expired', 'That plan is more than a day old. Ask again for a fresh one.');
  const done = st(fx).results.get(id);
  if (done) return done.choice === choice ? ok(done.res, 200) : err(409, 'already_chosen', 'A choice was already made for this ask.');
  const p = fx.projects.get(a.projectId);
  if (!p) return err(404, 'not_found', 'Its project is gone. Ask again.');
  if (p.archived) return err(409, 'archived', `${p.name} is archived. Restore it first.`);
  const gone = a.files.find((f) => st(fx).gone.has(f.path) || /gone/i.test(f.name));
  if (gone) return err(409, 'files_gone', `A file this plan reads is no longer there: ${gone.name}. Ask again.`);
  let res: AskChosen;
  if (hasNarrow) {
    const nr = plan.narrow[b.narrowIndex as number];
    const files = a.files.filter((f) => nr.files.includes(f.path));
    const child = askRecord(fx, { text: a.text, projectId: p.id, route: a.route, kind: 'answer', mode: 'now', files, parentId: a.id, focus: { note: nr.focus, ...(nr.by === 'model' ? { suggested: nr.label } : {}) }, tainted: nr.by === 'model' });
    const run = startRun(fx, p, a.text, { askId: child.id, pages: nr.pages, focus: nr.by === 'file' ? nr.focus : `“${nr.label}”` });
    fx.putAsk({ ...fx.asks.get(child.id)!, runId: run.runId, turnId: run.turnId });
    const narrowed: AskStart = { askId: child.id, projectId: p.id, route: a.route ?? { projectId: p.id, name: p.name, confidence: 'given', alternatives: [] }, kind: 'answer', state: 'started', runId: run.runId, turnId: run.turnId };
    fx.putAsk({ ...fx.asks.get(a.id)!, state: 'narrowed', choice: JSON.parse(choice) });
    res = { askId: a.id, chosen: 'narrow', narrowed };
  } else if (b.mode === 'now') {
    const capUsd = typeof cap === 'number' ? cap : plan.now.capDefault;
    const pages = a.files.reduce((s, f) => s + f.pages, 0);
    const run = startRun(fx, p, a.text, { askId: a.id, pages: pages || undefined });
    fx.putAsk({ ...fx.asks.get(a.id)!, state: 'running', choice: JSON.parse(choice), runId: run.runId, turnId: run.turnId, capUsd });
    res = { askId: a.id, chosen: 'now', kind: 'answer', state: 'started', runId: run.runId, turnId: run.turnId, capUsd };
  } else {
    const capUsd = typeof cap === 'number' ? cap : plan.background.capDefault;
    fx.putAsk({ ...fx.asks.get(a.id)!, choice: JSON.parse(choice) });
    const r = background(fx, fx.asks.get(a.id)!, p, a.files, capUsd, plan);
    res = { askId: a.id, chosen: 'background', kind: 'job', ...r };
  }
  st(fx).results.set(id, { choice, res });
  return ok(res, 202);
}

export const W4_PROJECT_IDS = ['general', ...PROJECTS.map((p) => p.id)];
