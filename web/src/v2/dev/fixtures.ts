/**
 * Fixture mode (v2 build, slice W1): an in-memory /api/v1 that answers with the approved prototype's Monday, so the
 * v2 screens can be built and tested before every backend slice is merged. Responses have the contract's shapes
 * (tests/web-v2-fixtures.test.ts validates them against api/openapi.yaml).
 *
 * One FixtureServer runs in two places:
 *   - the Vite dev/preview middleware (./vite-plugin.ts, `MWA_FIXTURES=1`): the real client and a real EventSource
 *     talk HTTP to it;
 *   - the browser itself (`?fixtures=1`): fixtureFetch + FixtureEventSource stand in for the network, so a built UI
 *     served from anywhere shows the example day.
 *
 * Scenarios (`?scenario=`): N00 (default: one job working), N06 (+ a job waiting for you at its 15¢ limit),
 * states (one job in each of the eight server states), old-client (the server wants a newer app: 426), sorting (W3:
 * sorting held back); W2's Today scenarios (N05 check-in, midday, N09 wrap, partial, not-connected,
 * reconnect) are ./fixtures-today.ts. Writes it acts on: jobs stop / continue / open, calendar drafts confirm / remove,
 * project messages (a simulated answer follows on the stream); W3's Important list, the reader's reply drafts and
 * about-asks are ./fixtures-important.ts; Today's marks and new calendar drafts are ./fixtures-today.ts. Everything
 * else answers 404 not_found. All of it is example data.
 */
import type { CalendarItem, Job, JobStatus, MailHeader, MailMessage, Meta, Project, Schemas, Turn } from '../api/client';
import { CATS, EMAILS, EVENTS, FIXTURE_NOW, PROJECTS, THREADS, at, dayStart } from './fixture-data';
import { w4Read, w4Seed, w4Write } from './fixtures-w4';
import { ImportantFixtures } from './fixtures-important';
import { SettingsFixtures } from './fixtures-settings';
import { TodayFixtures, TODAY_SCENARIOS } from './fixtures-today';
import { scenarioClock } from './fixture-clock';
import { ApprovalFixtures } from './fixtures-approvals';

export interface FixtureRequest { method: string; path: string; query: URLSearchParams; headers: Record<string, string | undefined>; body: unknown }
export interface FixtureResponse { status: number; body: unknown; headers?: Record<string, string> }
export interface StreamMessage { event: string; data: unknown; id?: number }
type Entity = 'job' | 'calendar' | 'project' | 'turn' | 'mail' | 'item' | 'ask' | 'approval';
interface Ev { seq: number; entity: Entity; id: string; op: 'upsert' | 'delete' }

export const FIXTURE_SCENARIOS = ['N00', 'N06', 'states', 'old-client', 'sorting', 'thread-long', ...TODAY_SCENARIOS, 'signed-out', 'unpaired', 'phone', 'first-run', 'npm-off', 'model-fixed', 'hosted', 'conn-setup', 'approvals'] as const;
export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number];
export const FIXTURE_SERVER_VERSION = 'fixtures';

const MINUTE = 60_000;
const err = (status: number, code: string, message: string): FixtureResponse => ({ status, body: { error: { code, message } } });

export class FixtureServer {
  readonly scenario: FixtureScenario;
  minClient = '1.0.0';
  /** the simulated answer's delay (ms); tests set 0 */
  answerDelay = 1_200;
  private seq = 0;
  private events: Ev[] = [];
  jobs = new Map<string, Job>();
  calendar = new Map<string, CalendarItem>();
  projects = new Map<string, Project>();
  turns = new Map<string, Turn>();
  mail = new Map<string, MailHeader>();
  /** W4: asks (POST /ask) and their plans, by id */
  asks = new Map<string, Schemas['Ask']>();
  private bodies = new Map<string, string>();
  private idem = new Map<string, { fp: string; res: FixtureResponse }>();
  private subs = new Set<(m: StreamMessage) => void>();
  private clock: () => number;
  /** W3: the Important list, the reader's extras and about-asks (./fixtures-important.ts) */
  readonly important: ImportantFixtures;
  /** W5: who is signed in, pairing, devices, Settings and files (./fixtures-settings.ts) */
  readonly settings: SettingsFixtures;
  /** W2: Today, the calendar's accounts and new drafts (./fixtures-today.ts) */
  readonly today: TodayFixtures;
  /** S4: approvals (./fixtures-approvals.ts) */
  readonly approvals: ApprovalFixtures;

  /** The clock defaults to the scenario's (./fixture-clock.ts): 9:10 AM, or 7:30 AM / 12:30 PM / 6:30 PM for Today's. */
  constructor(scenario: string | null = 'N00', clock?: () => number) {
    this.scenario = (FIXTURE_SCENARIOS as readonly string[]).includes(String(scenario)) ? (scenario as FixtureScenario) : 'N00';
    this.clock = clock ?? (() => scenarioClock(this.scenario));
    if (this.scenario === 'old-client') this.minClient = '99.0.0';
    this.important = new ImportantFixtures({
      clock: () => this.clock(), seq: () => this.seq, emit: (e, id, op) => this.emit(e, id, op),
      putMail: (m, b) => this.putMail(m, b), putCal: (c) => this.putCal(c), putTurn: (t) => this.putTurn(t), makeTurn: turn,
      later: (fn, ms) => this.later(fn, ms), answerDelay: () => this.answerDelay,
      mail: this.mail, projects: this.projects, turns: this.turns, bodyOf: (id) => this.bodies.get(id),
    }, this.scenario);
    this.settings = new SettingsFixtures(this.scenario, () => this.clock());
    this.today = new TodayFixtures({
      clock: () => this.clock(), jobs: this.jobs, calendar: this.calendar, putCal: (c) => this.putCal(c), later: (fn, ms) => this.later(fn, ms),
      important: () => this.important.snapshot(),
      approvals: () => this.approvals.needsYou(),
      notify: () => { for (const s of this.subs) s({ event: 'change', data: { seq: this.seq, entity: 'today', id: 'today', op: 'upsert' } }); },
    }, this.scenario);
    this.approvals = new ApprovalFixtures({
      clock: () => this.clock(), emitApproval: (id) => this.emit('approval', id), putJob: (j) => this.putJob(j), jobs: this.jobs,
      putApprovalItem: (id, title, phishing) => this.important.putApprovalItem(id, title, phishing),
      dropApprovalItem: (id) => this.important.dropApprovalItem(id),
    }, this.scenario);
    this.seed();
    this.today.seed();
  }

  // ---------- the world ----------
  /** @internal (also used by ./fixtures-w4.ts) */
  emit(entity: Entity, id: string, op: 'upsert' | 'delete' = 'upsert'): number {
    const e: Ev = { seq: ++this.seq, entity, id, op };
    this.events.push(e);
    const data = op === 'delete' ? undefined : entity === 'mail' ? undefined : this.current(entity, id);
    for (const s of this.subs) s({ event: 'change', id: e.seq, data: { seq: e.seq, entity, id, op: data || entity === 'mail' ? op : 'delete', ...(data ? { data } : {}) } });
    if (entity !== 'mail' && entity !== 'project') this.today?.changed(); // W2: what Today is made of changed
    return e.seq;
  }
  private current(entity: Entity, id: string): unknown {
    return entity === 'job' ? this.jobs.get(id) : entity === 'calendar' ? this.calendar.get(id) : entity === 'project' ? this.projects.get(id)
      : entity === 'turn' ? summary(this.turns.get(id)) : entity === 'item' ? this.important.current(id) : entity === 'ask' ? this.asks.get(id)
        : entity === 'approval' ? this.approvals.current(id) : this.mail.get(id);
  }
  // @internal: putJob, putProject, putTurn, putAsk, live and now are also used by ./fixtures-w4.ts
  putJob(j: Job) { j.updatedSeq = this.seq + 1; this.jobs.set(j.id, j); this.emit('job', j.id); }
  private putCal(c: CalendarItem) { this.calendar.set(c.id, c); this.emit('calendar', c.id); }
  putProject(p: Project) { p.updatedSeq = this.seq + 1; this.projects.set(p.id, p); this.emit('project', p.id); }
  putTurn(t: Turn) { t.updatedSeq = this.seq + 1; this.turns.set(t.id, t); this.emit('turn', t.id); }
  putAsk(a: Schemas['Ask']) { a.updatedSeq = this.seq + 1; this.asks.set(a.id, a); this.emit('ask', a.id); }
  /** a `live` event on the stream (a run's progress), as the server sends them */
  live(session: string, type: string, stage: unknown, at = this.clock()) { for (const s of this.subs) s({ event: 'live', data: { session, type, stage, at } }); }
  now(): number { return this.clock(); }
  private putMail(m: MailHeader, body: string) { m.updatedSeq = this.seq + 1; this.mail.set(m.id, m); this.bodies.set(m.id, body); this.emit('mail', m.id); }

  private seed() {
    const now = this.clock();
    // projects: General, then the prototype's five
    this.putProject({ id: 'general', name: 'General', icon: null, createdAt: now - 60 * 86_400_000, sort: 0, archived: false, general: true, updatedSeq: 0 });
    PROJECTS.forEach((p, i) => this.putProject({ id: p.id, name: p.name, icon: p.icon, createdAt: now - (50 - i) * 86_400_000, sort: i + 1, archived: false, general: false, updatedSeq: 0 }));
    // threads: each you/helper pair is one chat turn
    for (const [pid, msgs] of Object.entries(THREADS)) {
      for (let i = 0; i + 1 < msgs.length; i += 2) {
        const you = msgs[i], helper = msgs[i + 1];
        const cross = helper.cross ? PROJECTS.find((p) => p.name === helper.cross) : undefined;
        this.putTurn(turn({ id: `t_${pid}_${i / 2 + 1}`, projectId: pid, ts: now - (26 - i) * 60 * MINUTE, message: you.text, reply: helper.text,
          provenance: cross ? [{ projectId: cross.id, name: cross.name, n: 2 }] : [] }));
      }
    }
    // calendar: the week, with the dentist visit as the helper's draft
    for (const e of EVENTS) {
      const base = { title: e.title, start: new Date(at(e.day, e.start)).toISOString(), end: new Date(at(e.day, e.end)).toISOString(), allDay: false, location: e.where, provider: 'google' as const };
      if (e.draft) this.putCal({ id: `cd_${e.id}`, kind: 'draft', ...base, state: 'draft', confirmedAt: null, origin: 'helper-after-reading', originNote: `From a ${e.from ?? 'an email'}. Check it before confirming.` });
      else this.putCal({ id: `google:${e.id}`, kind: 'event', ...base, addedByHelper: false });
    }
    // mail: headers (bodies only through /mail/{id})
    EMAILS.forEach((m) => {
      const receivedAt = receivedAtOf(m.time, now);
      this.putMail({ id: `m_${m.id}`, account: 'gmail', provider: 'gmail', threadId: null, from: { name: m.from, addr: m.addr }, subject: m.subject, snippet: m.preview,
        receivedAt, unread: !!m.unread, labels: m.list ? ['INBOX', 'CATEGORY_UPDATES'] : ['INBOX'], listId: m.list ?? null, hasUnsub: !!m.list, alsoIn: [], updatedSeq: 0, caution: null }, m.body.join('\n\n'));
    });
    // jobs
    const month = (d: number) => new Date(new Date(now).getFullYear(), new Date(now).getMonth(), d, 10).getTime();
    // finished earlier this month and archived: they make the month line ($1.25 + 4¢ = $1.29, as in the prototype)
    this.putJob(job({ id: 'j_pdfs_nov2', title: 'Reading the stable’s two newsletters', projectId: 'eventing', createdAt: month(2), costUsd: 0.38, archived: true, ...st('done', 'Finished', 'Read both and saved the dates.') }));
    this.putJob(job({ id: 'j_news_nov5', title: 'Last week’s AI news', projectId: 'ainews', createdAt: month(5), costUsd: 0.52, archived: true, ...st('done', 'Finished', 'Five stories with blurbs.') }));
    this.putJob(job({ id: 'j_quotes_nov3', title: 'Comparing the gutter quotes', projectId: 'house', createdAt: month(3), costUsd: 0.35, archived: true, ...st('done', 'Finished', 'Hillside is $60 cheaper.') }));
    this.putJob(newsJob(now));
    if (this.scenario === 'N06') this.putJob(learnJob(now));
    if (this.scenario === 'states') for (const j of allStates(now)) this.putJob(j);
    this.important.seed();
    w4Seed(this, now);
    this.approvals.seed();
  }

  // ---------- requests ----------
  handle(req: FixtureRequest): FixtureResponse {
    const method = req.method.toUpperCase();
    const cv = /^[a-z]+\/(\d+(?:\.\d+){0,2})/i.exec(String(req.headers['x-mwa-client'] ?? ''))?.[1];
    if (cv && cmp(cv, this.minClient) < 0 && req.path !== '/meta') return err(426, 'client_too_old', 'A newer version of the app is needed. Reload to update.');
    // W5: signed out → 401 except the public routes; a phone → 403 on admin routes (./fixtures-settings.ts)
    const gate = this.settings.gate(method, req.path);
    if (gate) return gate;
    if (method === 'POST' && (req.path === '/session' || req.path === '/pair')) return this.settings.write(method, req.path, req.body)!; // public: no key needed
    if (method !== 'GET') {
      const key = String(req.headers['idempotency-key'] ?? '');
      if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return err(400, 'idempotency_key_required', 'Send an Idempotency-Key header (8–128 letters, digits, . _ : -).');
      const fp = `${method} ${req.path}\n${JSON.stringify(req.body ?? null)}`;
      const seen = this.idem.get(key);
      if (seen) return seen.fp === fp ? { ...seen.res, headers: { ...(seen.res.headers ?? {}), 'idempotent-replay': 'true' } } : err(409, 'idempotency_key_reused', 'That Idempotency-Key was already used for a different request.');
      const res = this.settings.write(method, req.path, req.body, req.query) ?? this.today.write(method, req.path, req.body) ?? this.approvals.write(method, req.path, req.body) ?? this.write(method, req.path, req.body);
      if (res.status < 500) this.idem.set(key, { fp, res });
      return res;
    }
    return this.today.read(req.path) ?? this.approvals.read(req.path) ?? this.read(req.path, req.query);
  }

  private read(path: string, q: URLSearchParams): FixtureResponse {
    let m: RegExpExecArray | null;
    const imp = this.important.read(path, q);
    if (imp) return imp;
    const w5 = this.settings.read(path, q);
    if (w5) return w5;
    if (path === '/meta') {
      const meta: Meta = { api: 'v1', server: FIXTURE_SERVER_VERSION, minClient: this.minClient, secure: true, features: ['jobs', 'calendar', 'mail', 'projects', 'important', 'ask', 'today', 'settings', 'files', 'approvals'], importing: null };
      return { status: 200, body: meta };
    }
    const w4 = w4Read(this, path, q);
    if (w4) return w4;
    if (path === '/jobs') {
      const archived = q.get('archived') === '1';
      const state = q.get('state');
      const jobs = [...this.jobs.values()].filter((j) => j.archived === archived && (!state || j.status.state === state)).sort((a, b) => b.updatedSeq - a.updatedSeq);
      return { status: 200, body: { jobs, next: null } };
    }
    if ((m = /^\/jobs\/([^/]+)$/.exec(path))) {
      const j = this.jobs.get(decodeURIComponent(m[1]));
      return j ? { status: 200, body: { job: j, tries: [] } } : err(404, 'not_found', 'No such job.');
    }
    if (path === '/sync') return this.sync(q);
    if (path === '/calendar') {
      const from = q.get('from') ? Date.parse(q.get('from')!) : dayStart(-1), to = q.get('to') ? Date.parse(q.get('to')!) : dayStart(14);
      const items = [...this.calendar.values()].filter((i) => (i.kind === 'event' || i.state === 'draft') && Date.parse(i.start) < to && Date.parse(i.end) > from)
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      return { status: 200, body: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), items, conflicts: conflictsOf(items) } };
    }
    if (path === '/calendar/accounts') return { status: 200, body: { accounts: [{ account: 'google', provider: 'google', label: 'Google Calendar', connected: true, needsReconnect: false, lastOk: this.clock() - 5 * MINUTE, lastError: null }] } };
    if (path === '/mail') {
      const mail = [...this.mail.values()].sort((a, b) => b.receivedAt - a.receivedAt);
      return { status: 200, body: { mail, nextBefore: null, note: 'Your helper reads and writes drafts. It never sends.', connected: true } };
    }
    if (path === '/mail/accounts') return { status: 200, body: { accounts: [{ account: 'gmail', provider: 'gmail', label: 'Gmail', needsReconnect: false, lastOk: this.clock() - 5 * MINUTE, lastError: null, windowFrom: this.clock() - 14 * 86_400_000, syncing: false }], note: 'Your helper reads and writes drafts. It never sends.' } };
    if ((m = /^\/mail\/([^/]+)$/.exec(path))) {
      const h = this.mail.get(decodeURIComponent(m[1]));
      if (!h) return err(404, 'gone', 'That message is no longer in your mailbox.');
      const msg: MailMessage = { ...h, to: 'robert@example.com', replyTo: [h.from], replyGoesElsewhere: false, replyNote: null, bodyText: this.bodies.get(h.id) ?? '', truncated: false, tooComplex: false, quotedLinesHidden: 0, imagesHidden: 0, trackersRemoved: 0, trust: 'untrusted', fetchedAt: this.clock() };
      return { status: 200, body: msg };
    }
    if (path === '/projects') {
      const all = q.get('archived') === '1';
      return { status: 200, body: { projects: [...this.projects.values()].filter((p) => all || !p.archived).sort((a, b) => a.sort - b.sort), importing: null } };
    }
    // a project's thread, work and files: ./fixtures-w4.ts (W4)
    return err(404, 'not_found', 'No such endpoint in fixture mode.');
  }

  private write(method: string, path: string, body: unknown): FixtureResponse {
    let m: RegExpExecArray | null;
    const now = this.clock();
    const imp = this.important.write(method, path, body);
    if (imp) return imp;
    const w4 = w4Write(this, method, path, body);
    if (w4) return w4;
    if (method === 'POST' && (m = /^\/jobs\/([^/]+)\/(stop|continue|open)$/.exec(path))) {
      const j = this.jobs.get(decodeURIComponent(m[1]));
      if (!j) return err(404, 'not_found', 'No such job.');
      const action = m[2];
      if (action === 'stop') {
        if (j.status.state !== 'working' && j.status.state !== 'continuing') return err(409, 'not_running', 'It isn’t working right now.');
        const p = j.progress;
        this.putJob({ ...j, status: { state: 'stopped_by_you', label: 'Stopped by you', detail: p ? `Stopped by you. I kept the ${p.done} ${p.unit} I’d found.` : 'Stopped by you. What it did is kept.', primaryAction: { action: 'continue', label: 'Continue' } } });
        return { status: 200, body: { job: this.jobs.get(j.id), tries: [], message: 'Stopped. What it did is kept.' } };
      }
      if (action === 'continue') {
        if (j.status.state === 'working' || j.status.state === 'continuing' || j.status.state === 'done') return err(409, 'running', j.status.state === 'done' ? 'It already finished.' : 'It is already working.');
        const p = j.progress;
        this.putJob({ ...j, tries: j.tries + 1, capUsd: (body as { capUsd?: number } | null)?.capUsd ?? j.capUsd, status: { state: 'working', label: 'Working', detail: p ? `Working on it — ${p.done} of ${p.total} ${p.unit} done so far.` : 'Working on it now.', primaryAction: { action: 'stop', label: 'Stop' } } });
        this.later(() => {
          const cur = this.jobs.get(j.id);
          if (!cur || cur.status.state !== 'working') return;
          const done = cur.progress ? { ...cur.progress, done: cur.progress.total } : null;
          this.putJob({ ...cur, progress: done, costUsd: Math.round((cur.costUsd + 0.03) * 100) / 100, status: { state: 'done', label: 'Result ready', detail: done ? `Done — all ${done.total} ${done.unit}.` : 'Done.', resultReady: true, primaryAction: { action: 'open', label: 'Open' } } });
        }, this.answerDelay * 2);
        return { status: 202, body: { job: this.jobs.get(j.id), tries: [], message: 'Going on from where it stopped.' } };
      }
      this.putJob({ ...j, seenAt: now, status: { ...j.status, resultReady: false, ...(j.status.state === 'done' ? { label: 'Finished' } : {}) } });
      return { status: 200, body: { job: this.jobs.get(j.id), tries: [], message: 'Opened.' } };
    }
    if (method === 'POST' && (m = /^\/calendar\/drafts\/([^/]+)\/(confirm|remove)$/.exec(path))) {
      const d = this.calendar.get(decodeURIComponent(m[1]));
      if (!d || d.kind !== 'draft') return err(404, 'not_found', 'No such draft.');
      if (d.state !== 'draft') return err(409, d.state === 'removed' ? 'removed' : 'confirmed', d.state === 'removed' ? 'That draft was removed.' : 'That draft is already on your calendar.');
      if (m[2] === 'remove') {
        const removed = { ...d, state: 'removed' as const };
        this.calendar.delete(d.id); this.emit('calendar', d.id, 'delete');
        return { status: 200, body: { draft: removed, message: 'Removed. Nothing was on your calendar, so nothing changed there.' } };
      }
      const confirmed = { ...d, state: 'confirmed' as const, confirmedAt: now };
      this.calendar.delete(d.id); this.emit('calendar', d.id, 'delete');
      const evId = `google:${d.id.replace(/^cd_/, '')}`;
      this.putCal({ id: evId, kind: 'event', title: d.title, start: d.start, end: d.end, allDay: d.allDay, location: d.location, provider: 'google', addedByHelper: true });
      return { status: 200, body: { draft: confirmed, message: 'Added by your helper just now. No invites were sent.' } };
    }
    // project messages, Ask, plans, moves, stop/steer/offer: ./fixtures-w4.ts (W4)
    return err(404, 'not_found', 'Fixture mode does not do that yet.');
  }

  /** @internal (also ./fixtures-w4.ts) */
  later(fn: () => void, ms: number) { if (ms <= 0) queueMicrotask(fn); else setTimeout(fn, ms); }

  private sync(q: URLSearchParams): FixtureResponse {
    const since = Number(q.get('since') ?? 0) || 0;
    const want = new Set((q.get('collections') ?? 'jobs').split(',').map((s) => s.trim()).filter(Boolean));
    const known = ['jobs', 'calendar', 'mail', 'projects', 'turns', 'important'];
    const unknown = [...want].filter((w) => !known.includes(w));
    if (unknown.length) return err(400, 'unknown_collection', `Unknown collection: ${unknown.join(', ')}. Available: ${known.join(', ')}.`);
    const COLL: Record<Entity, string> = { job: 'jobs', calendar: 'calendar', mail: 'mail', project: 'projects', turn: 'turns', item: 'important', ask: 'asks', approval: 'approvals' };
    const upserts: Record<string, unknown[]> = {}, deletes: Record<string, string[]> = {};
    // no cursor, or one from another fixture world (ahead of this one): a snapshot, as the server does for a cursor
    // it cannot serve
    if (!since || since > this.seq) {
      for (const c of want) { deletes[c] = []; }
      if (want.has('jobs')) upserts.jobs = [...this.jobs.values()];
      if (want.has('calendar')) upserts.calendar = [...this.calendar.values()];
      if (want.has('mail')) upserts.mail = [...this.mail.values()];
      if (want.has('projects')) upserts.projects = [...this.projects.values()];
      if (want.has('turns')) upserts.turns = [...this.turns.values()].map(summary);
      if (want.has('important')) upserts.important = this.important.snapshot();
      return { status: 200, body: { cursor: this.seq, reset: true, more: false, upserts, deletes } };
    }
    const last = new Map<string, Ev>();
    for (const e of this.events) if (e.seq > since) last.set(`${e.entity}:${e.id}`, e);
    for (const c of want) { upserts[c] = []; deletes[c] = []; }
    for (const e of last.values()) {
      const c = COLL[e.entity];
      if (!want.has(c)) continue;
      const cur = e.op === 'delete' ? undefined : this.current(e.entity, e.id);
      if (cur) upserts[c].push(cur); else deletes[c].push(e.id);
    }
    return { status: 200, body: { cursor: this.seq, reset: false, more: false, upserts, deletes } };
  }

  // ---------- the stream ----------
  /** What a new stream connection gets: hello, then every change after `cursor` (as the server replays them). */
  openStream(cursor: number, send: (m: StreamMessage) => void): () => void {
    send({ event: 'hello', data: { cursor, head: this.seq } });
    const last = new Map<string, Ev>();
    for (const e of this.events) if (e.seq > cursor) last.set(`${e.entity}:${e.id}`, e);
    for (const e of [...last.values()].sort((a, b) => a.seq - b.seq)) {
      const data = e.op === 'delete' || e.entity === 'mail' ? undefined : this.current(e.entity, e.id);
      send({ event: 'change', id: e.seq, data: { seq: e.seq, entity: e.entity, id: e.id, op: data || e.entity === 'mail' ? e.op : 'delete', ...(data ? { data } : {}) } });
    }
    this.subs.add(send);
    return () => { this.subs.delete(send); };
  }
}

// ---------- shapes ----------
export function turn(p: Partial<Turn> & Pick<Turn, 'id' | 'projectId' | 'ts' | 'message' | 'reply'>): Turn {
  return { kind: 'chat', truncated: false, reason: null, tainted: false, runId: null, tryId: null, about: null, provenance: [], offer: null, legacySession: null, movedFrom: null, updatedSeq: 0, ...p, source: p.source ?? 'typed' };
}
function summary(t: Turn | undefined): Turn | undefined {
  if (!t) return t;
  const cut = (s: string) => (s.length > 500 ? s.slice(0, 500) : s);
  return { ...t, message: cut(t.message), reply: cut(t.reply), truncated: t.message.length > 500 || t.reply.length > 500 };
}
function st(state: JobStatus['state'], label: string, detail: string, extra: Partial<JobStatus> = {}): { status: JobStatus } {
  return { status: { state, label, detail, ...extra } };
}
export function job(p: Partial<Job> & Pick<Job, 'id' | 'title' | 'status'>): Job {
  return {
    kind: 'background', request: null, projectId: null, createdAt: FIXTURE_NOW, updatedSeq: 0, lifecycle: 'active', progress: null, remaining: null,
    whereItStands: null, seenAt: null, capUsd: null, costUsd: 0, tries: 1, archived: false, scheduleId: null, goalId: null, session: null, nextRunAt: null,
    estimate: null, estimateVsActual: null, ...p,
  };
}
function newsJob(now: number): Job {
  return job({ id: 'j_news', title: 'Gathering this week’s AI news', projectId: 'ainews', createdAt: now - 40 * MINUTE, costUsd: 0.04, progress: { done: 3, total: 5, unit: 'stories' },
    request: 'Pull together this week’s AI news for the newsletter.', ...st('working', 'Working', 'Working on it — 3 of 5 stories done so far.', { primaryAction: { action: 'stop', label: 'Stop' } }) });
}
function learnJob(now: number): Job {
  return job({ id: 'j_learn', title: 'Learning the USEF eventing rules', projectId: 'eventing', createdAt: now - 3 * 60 * MINUTE, costUsd: 0.15, capUsd: 0.15, progress: { done: 63, total: 73, unit: 'pages' },
    remaining: 'Pages 64–73.', estimate: { continue: { usd: 0.03, ms: 2 * MINUTE }, startOver: { usd: 0.18, ms: 15 * MINUTE }, basis: 'this-job', samples: 1 },
    ...st('waiting', 'Waiting for you', 'It reached the 15¢ limit you set. Finish the last 10 pages? About 3¢.', { primaryAction: { action: 'continue', label: 'Finish the last 10 pages', estimate: { usd: 0.03, ms: 2 * MINUTE }, limitUsd: 0.25 } }) });
}
/** One job in each of the server's eight states (the pill and the sheet's groups at a glance). */
function allStates(now: number): Job[] {
  const h = (n: number) => now - n * 60 * MINUTE;
  return [
    learnJob(now),
    job({ id: 'j_cont', title: 'Sorting the barn receipts', projectId: 'house', createdAt: h(2), costUsd: 0.06, progress: { done: 40, total: 90, unit: 'receipts' }, ...st('continuing', 'Continuing', 'It ran out of room after 40 of 90 receipts. It goes on by itself.') }),
    job({ id: 'j_ready', title: 'Summarising the PTA minutes', projectId: 'family', createdAt: h(5), costUsd: 0.05, ...st('done', 'Result ready', 'Done — a one-page summary.', { resultReady: true, primaryAction: { action: 'open', label: 'Open' } }) }),
    job({ id: 'j_done', title: 'Checking Willow’s vaccination dates', projectId: 'eventing', createdAt: h(9), costUsd: 0.02, seenAt: h(8), ...st('done', 'Finished', 'Done — all three are current.') }),
    job({ id: 'j_byyou', title: 'Finding a new farrier', projectId: 'eventing', createdAt: h(20), costUsd: 0.07, progress: { done: 2, total: 6, unit: 'farriers' }, ...st('stopped_by_you', 'Stopped by you', 'Stopped by you. I kept the 2 farriers I’d found.', { primaryAction: { action: 'continue', label: 'Continue' } }) }),
    job({ id: 'j_partly', title: 'Reading the insurance policy', projectId: 'house', createdAt: h(26), costUsd: 0.11, progress: { done: 30, total: 41, unit: 'pages' }, remaining: 'Pages 31–41.', ...st('partly_done', 'Partly done', 'Read 30 of 41 pages; 11 are left.', { primaryAction: { action: 'continue', label: 'Finish the last 11 pages' } }) }),
    job({ id: 'j_stopped', title: 'Booking the arena', projectId: 'eventing', createdAt: h(30), costUsd: 0.01, ...st('stopped', 'Stopped', 'I couldn’t reach the booking page.', { primaryAction: { action: 'start-over', label: 'Start over' } }) }),
    job({ id: 'j_weekly', kind: 'recurring', title: 'Weekly AI news digest', projectId: 'ainews', createdAt: h(200), costUsd: 0.2, nextRunAt: now + 3 * 86_400_000, scheduleId: 's_weekly', ...st('scheduled', 'Scheduled', 'Next run Thu 7:00 AM.') }),
  ].map((j) => ({ ...j }));
}

function receivedAtOf(time: string, now: number): number {
  const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(time);
  if (m) { let hh = Number(m[1]) % 12; if (m[3] === 'PM') hh += 12; const d = new Date(now); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, Number(m[2])).getTime(); }
  if (time === 'Yesterday') return dayStart(-1) + 17 * 60 * MINUTE;
  if (time === 'Sat') return dayStart(-2) + 10 * 60 * MINUTE;
  return dayStart(-7);
}
function conflictsOf(items: CalendarItem[]) {
  const timed = items.filter((i) => !i.allDay);
  const out: { id: string; between: string[]; titles: string[]; start: string; end: string }[] = [];
  for (let a = 0; a < timed.length; a++) for (let b = a + 1; b < timed.length; b++) {
    const s = Math.max(Date.parse(timed[a].start), Date.parse(timed[b].start)), e = Math.min(Date.parse(timed[a].end), Date.parse(timed[b].end));
    if (s < e) out.push({ id: `c_${timed[a].id}_${timed[b].id}`, between: [timed[a].id, timed[b].id], titles: [timed[a].title, timed[b].title], start: new Date(s).toISOString(), end: new Date(e).toISOString() });
  }
  return out;
}
function cmp(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0), pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
/** The prototype's calendar categories, for screens that colour events (fixture events carry no category in v1). */
export const FIXTURE_CATEGORY: Record<string, keyof typeof CATS> = Object.fromEntries(EVENTS.map((e) => [e.draft ? `cd_${e.id}` : `google:${e.id}`, e.cat]));

// ---------- in the browser: ?fixtures=1 ----------

/** A fetch that answers /api/v1 from the FixtureServer (anything else goes to the real fetch). */
export function fixtureFetch(server: FixtureServer, base = '/api/v1'): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://fixtures.local');
    if (!url.pathname.startsWith(base + '/')) return fetch(input, init);
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => { headers[k.toLowerCase()] = v; });
    let body: unknown;
    if (typeof init?.body === 'string' && init.body) { try { body = JSON.parse(init.body); } catch { return new Response(JSON.stringify({ error: { code: 'bad_json', message: 'The request body is not valid JSON.' } }), { status: 400 }); } }
    await new Promise((r) => setTimeout(r, 30)); // a little latency, like a network
    const r = server.handle({ method: init?.method ?? 'GET', path: url.pathname.slice(base.length), query: url.searchParams, headers, body });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  };
}

/** An EventSource stand-in fed by the FixtureServer (same events, same ids). */
export class FixtureEventSource {
  readyState = 0;
  onerror: ((e: Event) => void) | null = null;
  private ls = new Map<string, Set<(e: MessageEvent) => void>>();
  private off: (() => void) | null = null;
  constructor(server: FixtureServer, url: string) {
    const cursor = Number(new URL(url, 'http://fixtures.local').searchParams.get('cursor') ?? 0) || 0;
    setTimeout(() => {
      if (this.readyState === 2) return;
      this.readyState = 1;
      this.off = server.openStream(cursor, (m) => setTimeout(() => this.dispatch(m), 0));
    }, 20);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) { if (!this.ls.has(type)) this.ls.set(type, new Set()); this.ls.get(type)!.add(fn); }
  close() { this.readyState = 2; this.off?.(); this.off = null; }
  private dispatch(m: StreamMessage) {
    if (this.readyState !== 1) return;
    const e = new MessageEvent(m.event, { data: JSON.stringify(m.data), lastEventId: m.id !== undefined ? String(m.id) : '' });
    for (const fn of this.ls.get(m.event) ?? []) fn(e);
  }
}
