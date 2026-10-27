/**
 * The v2 web app's typed client for /api/v1 (v2 build, slice W1, 2026-10-26).
 *
 * Every method maps to ONE operation in api/openapi.yaml: its path template is typed against the generated `paths`
 * (types.gen.ts), so a path the spec does not have does not compile, and tests/web-v2-client.test.ts calls every
 * method and checks each URL against the spec.
 *
 * Conventions the server holds every client to (see the spec's description):
 *   - `X-MWA-Client: web/<version>` on every request; a 426 means this build is older than the server accepts.
 *   - an `Idempotency-Key` on every write: one per action, reused on every retry of that action (the outbox stores
 *     it with the queued action, so a replay after a reload is still the same action).
 *   - errors are `{error: {code, message}}`; they become typed errors that carry the server's plain message.
 */
import type { components, paths } from './types.gen';

export type Schemas = components['schemas'];
export type Meta = Schemas['Meta'];
export type Job = Schemas['Job'];
export type JobDetail = Schemas['JobDetail'];
export type JobStatus = Schemas['JobStatus'];
export type JobState = JobStatus['state'];
export type Estimate = Schemas['Estimate'];
export type CalendarItem = Schemas['CalendarItem'];
export type CalendarView = Schemas['CalendarView'];
export type CalendarAccounts = Schemas['CalendarAccounts'];
export type DraftResult = Schemas['DraftResult'];
export type MailHeader = Schemas['MailHeader'];
export type MailMessage = Schemas['MailMessage'];
export type MailAccount = Schemas['MailAccount'];
export type MailRefresh = Schemas['MailRefresh'];
export type Project = Schemas['Project'];
export type Turn = Schemas['Turn'];
export type Suggestion = Schemas['Suggestion'];
export type Device = Schemas['Device'];
export type PairCode = Schemas['PairCode'];
export type PairResult = Schemas['PairResult'];

type Json<P extends keyof paths, M extends 'get' | 'post' | 'patch' | 'delete', S extends number> =
  paths[P][M] extends { responses: { [K in S]: { content: { 'application/json': infer T } } } } ? T : never;
export type SyncResult = Json<'/sync', 'get', 200>;
export type MailList = Json<'/mail', 'get', 200>;
type Body<P extends keyof paths, M extends 'post'> =
  paths[P][M] extends { requestBody?: { content: { 'application/json': infer T } } } ? T : never;
export type AskBody = Body<'/ask', 'post'>;
export type AskChoice = Body<'/ask/{id}/choose', 'post'>;
export type AskStart = Schemas['AskStart'];
export type AskChosen = Schemas['AskChosen'];
export type AsksAbout = Json<'/ask', 'get', 200>;
export type AskSuggestions = Json<'/ask/suggestions', 'get', 200>;
export type AskView = Json<'/ask/{id}', 'get', 200>;
export type ImportantGroup = 'today' | 'week' | 'earlier';
export type ImportantList = Schemas['ImportantList'];
export type SkippedList = Json<'/items/skipped', 'get', 200>;
export type ItemChange = Schemas['ItemChange'];
export type ItemActionResult = Schemas['ItemActionResult'];
export type ImportantRefresh = Schemas['ImportantRefresh'];
export type TriageRules = Json<'/triage/rules', 'get', 200>;
export type MailAccounts = Json<'/mail/accounts', 'get', 200>;
export type MailDraftSaved = Json<'/mail/{id}/draft', 'post', 201>;
export type ProjectList = Json<'/projects', 'get', 200>;
export type ProjectThread = Json<'/projects/{id}/thread', 'get', 200>;
export type MessageSent = Json<'/projects/{id}/messages', 'post', 202>;
export type ProjectFiles = Json<'/projects/{id}/files', 'get', 200>;
export type TurnMoved = Json<'/turns/{id}/move', 'post', 200>;
export type JobList = Schemas['JobList'];
export type Today = Schemas['Today'];
export type TodayAck = Schemas['TodayAck'];
export type TodaySeen = Json<'/today/seen', 'post', 200>;
export type SyncCollection = 'jobs' | 'calendar' | 'mail' | 'projects' | 'turns';

/** The version this build reports; set by vite.config.ts from web/package.json. */
declare const __MWA_WEB_VERSION__: string | undefined;
export const WEB_VERSION: string = typeof __MWA_WEB_VERSION__ === 'string' ? __MWA_WEB_VERSION__ : '1.0.0';
export const API_BASE = '/api/v1';

// ---------- errors ----------

/** Any refusal the server answered with `{error: {code, message}}`. `message` is plain words for the person. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = 'ApiError'; }
}
/** 401: nobody signed in (the password session ended, or this device was never paired or was removed). */
export class SignInRequired extends ApiError { constructor(m: string) { super(401, 'locked', m); this.name = 'SignInRequired'; } }
/** 403: signed in, but this device may not do that (a scope it was not given), or a cross-site write. */
export class Forbidden extends ApiError { constructor(code: string, m: string) { super(403, code, m); this.name = 'Forbidden'; } }
/** 409: the thing changed under us (finished, already running, removed…). Show the server's current state. */
export class Conflict extends ApiError { constructor(code: string, m: string) { super(409, code, m); this.name = 'Conflict'; } }
/** 426: this build is older than the server accepts. Offer "A newer version is ready · Reload". */
export class UpdateRequired extends ApiError { constructor(m: string) { super(426, 'client_too_old', m); this.name = 'UpdateRequired'; } }
/** The request never got an answer (offline, the server is down, a proxy dropped it). Safe to retry with the same key. */
export class NetworkError extends Error {
  constructor(message = 'Can’t reach your helper right now.', public cause?: unknown) { super(message); this.name = 'NetworkError'; }
}

/** 409 codes that do not hold on a retry (the spec lists them as not remembered against the key). */
export const TRANSIENT_CONFLICTS = new Set(['in_progress', 'busy', 'unavailable', 'no_calendar', 'needs_reconnect', 'calendar_error', 'read_only', 'provider_unavailable']);

// ---------- idempotency keys ----------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
}
/** A ULID (26 Crockford characters, time-ordered): one per action, matching the spec's `^[A-Za-z0-9._:-]{8,128}$`. */
export function newKey(now = Date.now()): string {
  let t = Math.floor(now), time = '';
  for (let i = 0; i < 10; i++) { time = CROCKFORD[t % 32] + time; t = Math.floor(t / 32); }
  const r = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[r[i] % 32];
  return time + rand;
}

// ---------- the transport ----------

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
/** A path template from the spec, e.g. '/jobs/{id}/stop'. */
export type ApiPath = keyof paths;
export interface CallOpts {
  path?: Record<string, string>;
  query?: Record<string, string | number | undefined | null>;
  body?: unknown;
  /** writes: the action's key; reuse it to retry the same action. A fresh one is made when absent. */
  key?: string;
  signal?: AbortSignal;
}
export interface ClientOptions {
  fetch?: typeof fetch;
  base?: string;
  version?: string;
  /** called for every request (tests record URLs; the store learns it is online) */
  onRequest?: (method: Method, url: string, template: ApiPath) => void;
  /** how many times a 409 in_progress (the same action still being handled) is retried, with the same key */
  inProgressRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function fillPath(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_m, n: string) => {
    const v = params[n];
    if (v === undefined || v === '') throw new Error(`Missing path parameter ${n} for ${template}`);
    return encodeURIComponent(v);
  });
}

export class MwaClient {
  private f: typeof fetch;
  readonly base: string;
  readonly version: string;
  constructor(private opts: ClientOptions = {}) {
    // bind: window.fetch called as a method of another object throws "Illegal invocation"
    this.f = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    this.base = opts.base ?? API_BASE;
    this.version = opts.version ?? WEB_VERSION;
  }

  /** The URL a GET would use (the stream is opened by the store with EventSource, which cannot set headers). */
  url(template: ApiPath, o: Pick<CallOpts, 'path' | 'query'> = {}): string {
    let u = this.base + fillPath(template, o.path);
    const q = Object.entries(o.query ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
    if (q.length) u += '?' + q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
    return u;
  }

  async call<T>(method: Method, template: ApiPath, o: CallOpts = {}): Promise<{ status: number; body: T; replay: boolean }> {
    const url = this.url(template, o);
    const write = method !== 'GET';
    const key = write ? (o.key ?? newKey()) : undefined;
    const headers: Record<string, string> = { accept: 'application/json', 'x-mwa-client': `web/${this.version}` };
    if (key) headers['idempotency-key'] = key;
    if (write && o.body !== undefined) headers['content-type'] = 'application/json';
    const tries = 1 + (write ? (this.opts.inProgressRetries ?? 2) : 0);
    for (let attempt = 1; ; attempt++) {
      this.opts.onRequest?.(method, url, template);
      let res: Response;
      try {
        res = await this.f(url, { method, headers, body: write && o.body !== undefined ? JSON.stringify(o.body) : undefined, credentials: 'same-origin', signal: o.signal });
      } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') throw e;
        throw new NetworkError(undefined, e);
      }
      const text = await res.text().catch(() => '');
      let body: unknown = null;
      if (text) { try { body = JSON.parse(text); } catch { body = null; } }
      if (res.ok) return { status: res.status, body: body as T, replay: res.headers.get('idempotent-replay') === 'true' };
      const err = toError(res.status, body);
      // the same action is still being handled (a retry raced the first try): wait, then ask again with the same key
      if (err instanceof Conflict && err.code === 'in_progress' && attempt < tries) {
        await (this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(400 * attempt);
        continue;
      }
      throw err;
    }
  }
  private async get<T>(template: ApiPath, o?: CallOpts): Promise<T> { return (await this.call<T>('GET', template, o)).body; }
  private async post<T>(template: ApiPath, o?: CallOpts): Promise<T> { return (await this.call<T>('POST', template, o)).body; }

  // ---- meta, pairing, devices ----
  getMeta() { return this.get<Meta>('/meta'); }
  createPairCode(o: { key?: string } = {}) { return this.post<PairCode>('/pair/codes', { key: o.key }); }
  pairDevice(body: { code: string; name?: string; platform?: string; cookie?: boolean }, o: { key?: string } = {}) { return this.post<PairResult>('/pair', { body, key: o.key }); }
  listDevices() { return this.get<{ devices: Device[] }>('/devices'); }
  async revokeDevice(id: string, o: { key?: string } = {}) { return (await this.call<{ revoked: string }>('DELETE', '/devices/{id}', { path: { id }, key: o.key })).body; }
  signOutThisDevice(o: { key?: string } = {}) { return this.post<{ revoked: string }>('/devices/me/sign-out', { key: o.key }); }

  // ---- jobs ----
  listJobs(q: { state?: JobState; archived?: '0' | '1'; limit?: number; before?: number } = {}) { return this.get<JobList>('/jobs', { query: q }); }
  getJob(id: string) { return this.get<JobDetail>('/jobs/{id}', { path: { id } }); }
  estimateJob(id: string) { return this.get<Estimate>('/jobs/{id}/estimate', { path: { id } }); }
  stopJob(id: string, o: { key?: string } = {}) { return this.post<JobDetail>('/jobs/{id}/stop', { path: { id }, key: o.key }); }
  continueJob(id: string, body: { capUsd?: number } = {}, o: { key?: string } = {}) { return this.post<JobDetail>('/jobs/{id}/continue', { path: { id }, body, key: o.key }); }
  startJobOver(id: string, body: { capUsd?: number } = {}, o: { key?: string } = {}) { return this.post<JobDetail>('/jobs/{id}/start-over', { path: { id }, body, key: o.key }); }
  openJob(id: string, o: { key?: string } = {}) { return this.post<JobDetail>('/jobs/{id}/open', { path: { id }, key: o.key }); }
  pauseJob(id: string, o: { key?: string } = {}) { return this.post<JobDetail>('/jobs/{id}/pause', { path: { id }, key: o.key }); }
  resumeJob(id: string, o: { key?: string } = {}) { return this.post<JobDetail>('/jobs/{id}/resume', { path: { id }, key: o.key }); }
  cancelJob(id: string, o: { key?: string } = {}) { return this.post<JobDetail>('/jobs/{id}/cancel', { path: { id }, key: o.key }); }

  // ---- live updates ----
  /** The stream's URL. The store opens it with EventSource (which resumes with Last-Event-ID by itself). */
  streamUrl(cursor?: number) { return this.url('/stream', { query: { cursor: cursor ? String(cursor) : undefined } }); }
  sync(q: { since?: number; collections?: SyncCollection[] } = {}) {
    return this.get<SyncResult>('/sync', { query: { since: q.since ? String(q.since) : undefined, collections: q.collections?.join(',') } });
  }

  // ---- calendar ----
  getCalendar(q: { from?: string; to?: string } = {}) { return this.get<CalendarView>('/calendar', { query: q }); }
  getCalendarAccounts() { return this.get<CalendarAccounts>('/calendar/accounts'); }
  refreshCalendar(o: { key?: string } = {}) { return this.post<CalendarAccounts>('/calendar/refresh', { key: o.key }); }
  createCalendarDraft(body: { title: string; start: string; end?: string; allDay?: boolean; location?: string; notes?: string; provider?: 'google' | 'outlook'; projectId?: string }, o: { key?: string } = {}) {
    return this.post<DraftResult>('/calendar/drafts', { body, key: o.key });
  }
  confirmCalendarDraft(id: string, body: { provider?: 'google' | 'outlook' } = {}, o: { key?: string } = {}) { return this.post<DraftResult>('/calendar/drafts/{id}/confirm', { path: { id }, body, key: o.key }); }
  removeCalendarDraft(id: string, o: { key?: string } = {}) { return this.post<DraftResult>('/calendar/drafts/{id}/remove', { path: { id }, key: o.key }); }
  /** A link for "Just give me a file" (a download, not JSON). The id must not carry the ".ics" itself. */
  calendarDraftIcsUrl(id: string) { return this.base + fillPath('/calendar/drafts/{id}.ics', { id }); }

  // ---- mail ----
  listMail(q: { before?: string; limit?: number } = {}) { return this.get<MailList>('/mail', { query: q }); }
  listMailAccounts() { return this.get<MailAccounts>('/mail/accounts'); }
  refreshMail(o: { key?: string } = {}) { return this.post<MailRefresh>('/mail/refresh', { key: o.key }); }
  readMail(id: string) { return this.get<MailMessage>('/mail/{id}', { path: { id } }); }
  saveMailDraft(id: string, body: { body: string }, o: { key?: string } = {}) { return this.post<MailDraftSaved>('/mail/{id}/draft', { path: { id }, body, key: o.key }); }

  // ---- projects and threads ----
  listProjects(q: { archived?: '0' | '1' } = {}) { return this.get<ProjectList>('/projects', { query: q }); }
  createProject(body: { name: string; icon?: string | null }, o: { key?: string } = {}) { return this.post<{ project: Project }>('/projects', { body, key: o.key }); }
  suggestProject(q: { text: string; from?: string }) { return this.get<Suggestion>('/projects/suggest', { query: q }); }
  async updateProject(id: string, body: { name?: string; icon?: string | null; archived?: boolean; sort?: number }, o: { key?: string } = {}) {
    return (await this.call<{ project: Project }>('PATCH', '/projects/{id}', { path: { id }, body, key: o.key })).body;
  }
  getProjectThread(id: string, q: { before?: string; limit?: number } = {}) { return this.get<ProjectThread>('/projects/{id}/thread', { path: { id }, query: q }); }
  sendProjectMessage(id: string, body: { text: string; stay?: boolean }, o: { key?: string } = {}) { return this.post<MessageSent>('/projects/{id}/messages', { path: { id }, body, key: o.key }); }
  getProjectWork(id: string) { return this.get<{ jobs: Job[] }>('/projects/{id}/work', { path: { id } }); }
  getProjectFiles(id: string) { return this.get<ProjectFiles>('/projects/{id}/files', { path: { id } }); }
  moveTurn(id: string, body: { projectId: string }, o: { key?: string } = {}) { return this.post<TurnMoved>('/turns/{id}/move', { path: { id }, body, key: o.key }); }
  stopProjectRun(id: string, o: { key?: string } = {}) { return this.post<{ stopped: true; message: string }>('/projects/{id}/stop', { path: { id }, key: o.key }); }
  steerProjectRun(id: string, body: { text: string }, o: { key?: string } = {}) { return this.post<{ added: true; message: string }>('/projects/{id}/steer', { path: { id }, body, key: o.key }); }
  /** The project's live run as server-sent events (opened with EventSource by a screen that follows an answer). */
  projectLiveUrl(id: string) { return this.url('/projects/{id}/live', { path: { id } }); }
  acceptProjectOffer(id: string, body: { message?: string } = {}, o: { key?: string } = {}) { return this.post<{ goal: string; message: string }>('/projects/{id}/offer/accept', { path: { id }, body, key: o.key }); }

  // ---- Ask (A6) ----
  ask(body: AskBody, o: { key?: string } = {}) { return this.post<AskStart>('/ask', { body, key: o.key }); }
  listAsksAbout(about: string) { return this.get<AsksAbout>('/ask', { query: { about } }); }
  askSuggestions(about: string) { return this.get<AskSuggestions>('/ask/suggestions', { query: { about } }); }
  getAsk(id: string) { return this.get<AskView>('/ask/{id}', { path: { id } }); }
  chooseAsk(id: string, body: AskChoice, o: { key?: string } = {}) { return this.post<AskChosen>('/ask/{id}/choose', { path: { id }, body, key: o.key }); }

  // ---- the Important list (A9) ----
  listImportant(q: { state?: 'open' | 'handled' | 'not-important'; group?: ImportantGroup } = {}) { return this.get<ImportantList>('/items', { query: q }); }
  listSkipped(q: { group?: ImportantGroup } = {}) { return this.get<SkippedList>('/items/skipped', { query: q }); }
  markItemHandled(id: string, o: { key?: string } = {}) { return this.post<ItemChange>('/items/{id}/handled', { path: { id }, key: o.key }); }
  unhandleItem(id: string, o: { key?: string } = {}) { return this.post<ItemChange>('/items/{id}/unhandle', { path: { id }, key: o.key }); }
  markItemNotImportant(id: string, body: { scope?: 'sender' | 'domain' | 'kind' } = {}, o: { key?: string } = {}) { return this.post<ItemChange>('/items/{id}/not-important', { path: { id }, body, key: o.key }); }
  markMailImportant(id: string, o: { key?: string } = {}) { return this.post<ItemChange>('/mail/{id}/important', { path: { id }, key: o.key }); }
  runItemAction(id: string, o: { key?: string } = {}) { return this.post<ItemActionResult>('/items/{id}/action', { path: { id }, key: o.key }); }
  refreshImportant(o: { key?: string } = {}) { return this.post<ImportantRefresh>('/important/refresh', { key: o.key }); }
  listTriageRules() { return this.get<TriageRules>('/triage/rules'); }

  // ---- Today (A10) ----
  getToday() { return this.get<Today>('/today'); }
  markTodaySeen(o: { key?: string } = {}) { return this.post<TodaySeen>('/today/seen', { key: o.key }); }
  finishCheckin(o: { key?: string } = {}) { return this.post<TodayAck>('/today/checkin/done', { key: o.key }); }
  finishWrap(o: { key?: string } = {}) { return this.post<TodayAck>('/today/wrap/done', { key: o.key }); }
  async deleteTriageRule(id: string, o: { key?: string } = {}) { return (await this.call<unknown>('DELETE', '/triage/rules/{id}', { path: { id }, key: o.key })).body; }
}

function toError(status: number, body: unknown): ApiError {
  const e = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof e?.code === 'string' ? e.code : `http_${status}`;
  const message = typeof e?.message === 'string' && e.message ? e.message : fallbackMessage(status);
  if (status === 401) return new SignInRequired(message);
  if (status === 403) return new Forbidden(code, message);
  if (status === 409) return new Conflict(code, message);
  if (status === 426) return new UpdateRequired(message);
  return new ApiError(status, code, message);
}
function fallbackMessage(status: number): string {
  if (status === 401) return 'Sign in to continue.';
  if (status === 403) return 'This device is not allowed to do that.';
  if (status === 404) return 'That is no longer there.';
  if (status === 426) return 'A newer version of the app is needed. Reload to update.';
  if (status >= 500) return 'Something went wrong on your helper’s side. Try again in a moment.';
  return 'That didn’t work. Try again.';
}
