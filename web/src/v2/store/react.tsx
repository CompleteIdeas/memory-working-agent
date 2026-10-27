/**
 * React bindings for the v2 store (v2 build, slice W1): the hooks the screens (W2–W5) are built on.
 *
 *   useMeta()           server facts, connection, "updated 9:10", update/sign-in state, fixture mode
 *   useJobs()           the jobs (not archived), the working sheet's groups, and their actions
 *   useStatusPill()     the header pill, computed from the server's job states
 *   useCalendar(range)  events and drafts in a window, with its double-bookings
 *   useProjects()       the person's projects, General first
 *   useThread(id)       a project's thread (its last 50 turns), loaded whole when opened
 *   useMail()           the plain mailbox's first page (headers only)
 *   useItems()          the Important list — only once the server has it (A9); `supported: false` until then
 *   useNotices()        short notes for the person (receipts, refusals, "sent when you're back online")
 *   useNow()            the clock (fixture mode freezes it at the prototype's Monday 9:10)
 */
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { V2Store, StoreState, ActionKind, ActionArgs, ActResult } from './core';
import { groupJobs, pillFor, activeJobs, monthLine } from './status';
import type { AskBody, AskChoice, CalendarItem, Job, Project } from '../api/client';

const Ctx = createContext<V2Store | null>(null);

export function StoreProvider({ store, children }: { store: V2Store; children: ReactNode }) {
  useEffect(() => { void store.start(); return () => store.stop(); }, [store]);
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useStore(): V2Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside StoreProvider');
  return s;
}
/** A slice of the state. The selector must return something already in the state (not a new array or object). */
function useSlice<T>(sel: (s: StoreState) => T): T {
  const store = useStore();
  const get = () => sel(store.getState());
  // the same snapshot on the server: screens render in node for tests (react-dom/server) without a browser
  return useSyncExternalStore(store.subscribe, get, get);
}

export function useNow(tickMs = 30_000): number {
  const store = useStore();
  // a server that turns out to be the fixture world freezes the clock: read it again then
  const fixtures = useSlice((s) => s.fixtures);
  const [now, setNow] = useState(() => store.now());
  useEffect(() => {
    setNow(store.now());
    const t = setInterval(() => setNow(store.now()), tickMs);
    return () => clearInterval(t);
  }, [store, tickMs, fixtures]);
  return now;
}

export function useMeta() {
  const meta = useSlice((s) => s.meta);
  const connection = useSlice((s) => s.connection);
  const updatedAt = useSlice((s) => s.updatedAt);
  const updateReady = useSlice((s) => s.updateReady);
  const auth = useSlice((s) => s.auth);
  const fixtures = useSlice((s) => s.fixtures);
  const ready = useSlice((s) => s.ready);
  const outbox = useSlice((s) => s.outbox);
  return { meta, connection, updatedAt, updateReady, auth, fixtures, ready, waitingToSend: outbox.length };
}

export function useJobs() {
  const store = useStore();
  const all = useSlice((s) => s.jobs);
  return useMemo(() => {
    const jobs = activeJobs(Object.values(all)).sort((a, b) => b.updatedSeq - a.updatedSeq);
    const act = (kind: ActionKind, j: Job, args: ActionArgs = {}) => store.act(kind, { id: j.id, ...args }, `${ACTION_WORD[kind]} “${j.title}”`);
    return {
      jobs,
      groups: groupJobs(jobs),
      monthLine: monthLine(Object.values(all), store.now()),
      stop: (j: Job) => act('job.stop', j),
      continue: (j: Job, capUsd?: number) => act('job.continue', j, capUsd !== undefined ? { capUsd } : {}),
      startOver: (j: Job, capUsd?: number) => act('job.startOver', j, capUsd !== undefined ? { capUsd } : {}),
      open: (j: Job) => act('job.open', j),
      pause: (j: Job) => act('job.pause', j),
      resume: (j: Job) => act('job.resume', j),
      cancel: (j: Job) => act('job.cancel', j),
    };
  }, [all, store]);
}
const ACTION_WORD: Record<ActionKind, string> = {
  'job.stop': 'Stop', 'job.continue': 'Continue', 'job.startOver': 'Start over', 'job.open': 'Open', 'job.pause': 'Pause',
  'job.resume': 'Resume', 'job.cancel': 'Cancel', 'draft.confirm': 'Confirm', 'draft.remove': 'Remove', 'message.send': 'Send',
  ask: 'Ask', 'ask.choose': 'Choose', 'turn.move': 'Move', 'project.create': 'Create', 'project.update': 'Change', 'project.stop': 'Stop',
  'project.steer': 'Add to', 'project.offer': 'Work on',
};

export function useStatusPill() {
  const all = useSlice((s) => s.jobs);
  return useMemo(() => pillFor(Object.values(all)), [all]);
}

/** Midnight-to-midnight local days → instants; an all-day item's dates are local dates, end exclusive. */
function itemSpan(i: CalendarItem): [number, number] {
  if (i.allDay) {
    const d = (s: string) => { const [y, m, dd] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, dd).getTime(); };
    return [d(i.start), d(i.end)];
  }
  return [Date.parse(i.start), Date.parse(i.end)];
}
export function useCalendar(range: { from: Date; to: Date }) {
  const store = useStore();
  const all = useSlice((s) => s.calendar);
  const conflictsAll = useSlice((s) => s.conflicts);
  const connection = useSlice((s) => s.connection);
  const from = range.from.toISOString(), to = range.to.toISOString();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (connection !== 'live') return;
    let on = true;
    setLoading(true);
    void store.loadCalendar(from, to).finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [store, from, to, connection]);
  return useMemo(() => {
    const a = Date.parse(from), b = Date.parse(to);
    const items = Object.values(all).filter((i) => i.kind === 'event' || i.state !== 'removed')
      .filter((i) => { const [s, e] = itemSpan(i); return s < b && e > a; })
      .sort((x, y) => itemSpan(x)[0] - itemSpan(y)[0] || x.title.localeCompare(y.title));
    return { items, conflicts: conflictsAll[`${from}|${to}`] ?? [], loading };
  }, [all, conflictsAll, from, to, loading]);
}

export function useProjects(): Project[] {
  const all = useSlice((s) => s.projects);
  return useMemo(() => Object.values(all).filter((p) => !p.archived)
    .sort((a, b) => Number(b.general) - Number(a.general) || a.sort - b.sort || a.name.localeCompare(b.name)), [all]);
}

/** Every project by id, archived ones included (a job's tag names its project even after it is archived). */
export function useProjectMap(): Record<string, Project> {
  return useSlice((s) => s.projects);
}

export function useThread(projectId: string | null) {
  const store = useStore();
  const threads = useSlice((s) => s.threads);
  const loaded = useSlice((s) => s.threadLoaded);
  const older = useSlice((s) => s.threadOlder);
  const next = useSlice((s) => s.threadNext);
  const connection = useSlice((s) => s.connection);
  useEffect(() => { if (projectId && connection === 'live' && !store.getState().threadLoaded[projectId]) void store.loadThread(projectId); }, [store, projectId, connection]);
  const recent = projectId ? threads[projectId] ?? EMPTY : EMPTY;
  const before = projectId ? older[projectId] ?? EMPTY : EMPTY;
  // W4: earlier pages ("Earlier messages") above the latest 50; `turns` stays the latest 50 for W1's readers
  const all = useMemo(() => {
    if (!before.length) return recent;
    const ids = new Set(recent.map((t) => t.id));
    return [...before.filter((t) => !ids.has(t.id)), ...recent];
  }, [before, recent]);
  return {
    turns: recent, loaded: projectId ? !!loaded[projectId] : false,
    all, hasEarlier: projectId ? !!next[projectId] : false,
    loadEarlier: () => (projectId ? store.loadEarlier(projectId) : Promise.resolve(false)),
  };
}
const EMPTY: never[] = [];

export function useMail() {
  const store = useStore();
  const mail = useSlice((s) => s.mail);
  const connection = useSlice((s) => s.connection);
  useEffect(() => { if (connection === 'live' && !store.getState().mail.loaded && !store.getState().mail.loading) void store.loadMail(); }, [store, connection]);
  return { ...mail, reload: () => store.loadMail() };
}

/**
 * The Important list. The /items routes arrive with slice A9 and are not in the v1 contract yet, so this asks the
 * server's `features` first and answers `supported: false` (screens show a plain "not available yet") until then.
 */
export function useItems() {
  const meta = useSlice((s) => s.meta);
  const supported = !!meta?.features.includes('items');
  return { supported, items: EMPTY as unknown[], reason: supported ? null : 'The Important list arrives in a later update of your helper.' };
}

export function useNotices() {
  const store = useStore();
  const notices = useSlice((s) => s.notices);
  return { notices, dismiss: (id: string) => store.dismiss(id) };
}

export function useSendMessage() {
  const store = useStore();
  return (projectId: string, text: string) => store.act('message.send', { id: projectId, text }, 'Your message');
}

// ---------- W4: Ask, plans, projects and their threads ----------

/**
 * Asking, through the outbox (an ask made offline is kept with its key and sent when back online):
 *   send(body)          POST /ask → the result's `entryId` finds what it became in `outcome(entryId)` (now or later)
 *   choose(askId, c)    a plan's choice (quiet: the plan card says a refusal in place)
 *   outcome(entryId)    what an ask became (AskStart), once the server has answered
 *   choice(askId)       what a plan's choice became (AskChosen)
 */
export function useAsk() {
  const store = useStore();
  const outcomes = useSlice((s) => s.askOutcomes);
  const choices = useSlice((s) => s.askChoices);
  const asks = useSlice((s) => s.asks);
  const outbox = useSlice((s) => s.outbox);
  const refused = useSlice((s) => s.refused);
  const dismissed = useSlice((s) => s.dismissedPlans);
  return useMemo(() => ({
    send: (body: AskBody, label = 'Your question'): Promise<ActResult> => store.act('ask', { body: body as unknown as Record<string, unknown> }, label, { quiet: true }),
    choose: (askId: string, c: AskChoice): Promise<ActResult> => store.act('ask.choose', { id: askId, body: c as Record<string, unknown> }, 'Your choice', { quiet: true }),
    outcome: (entryId: string | null | undefined) => (entryId ? outcomes[entryId] : undefined),
    choice: (askId: string | null | undefined) => (askId ? choices[askId] : undefined),
    ask: (askId: string | null | undefined) => (askId ? asks[askId] : undefined),
    load: (askId: string) => store.loadAsk(askId),
    /** every ask the server told this device about (the stream's `ask` changes, GET /ask/{id}) */
    records: asks,
    /** still in the outbox (not sent yet); false once sent — or refused when it was replayed */
    waiting: (entryId: string | null | undefined) => !!entryId && outbox.some((x) => x.id === entryId),
    /** why the outbox's send of this action was refused, if it was */
    refused: (entryId: string | null | undefined) => (entryId ? refused[entryId] : undefined),
    /** why a plan's choice sent from the outbox was refused (the latest), if one was */
    refusedChoice: (askId: string | null | undefined) => (askId ? Object.values(refused).filter((r) => r.askId === askId).pop() : undefined),
    /** put a plan aside ("Not now"): the Ask sheet stops offering it */
    dismiss: (askId: string) => store.dismissPlan(askId),
    /** plans waiting for a choice, one per ask, oldest first: kept in the store, so the Ask sheet shows them again when
     *  it is opened (not only while the sheet that asked is open). Not chosen, not old, not refused, not put aside. */
    waitingPlans: waitingPlans(outcomes, choices, asks, refused, dismissed),
  }), [store, outcomes, choices, asks, outbox, refused, dismissed]);
}

export function waitingPlans(outcomes: StoreState['askOutcomes'], choices: StoreState['askChoices'], asks: StoreState['asks'],
  refused: StoreState['refused'], dismissed: StoreState['dismissedPlans']) {
  const seen = new Set<string>();
  const refusedAsks = new Set(Object.values(refused).map((r) => r.askId).filter(Boolean));
  return Object.values(outcomes).sort((a, b) => a.at - b.at).filter((o) => {
    const id = o.start.askId;
    if (o.start.kind !== 'plan' || seen.has(id)) return false;
    seen.add(id);
    return !choices[id] && !dismissed[id] && !refusedAsks.has(id) && asks[id]?.state !== 'expired' && asks[id]?.state !== 'narrowed';
  });
}

/** The run being written in a project's thread, as the stream last said (`live` events of session p-<id>). */
export function useLive(projectId: string | null) {
  const live = useSlice((s) => s.live);
  return projectId ? live[`p-${projectId}`] ?? null : null;
}

/** Projects and their threads: create, rename, archive, restore; move a turn; Stop and Steer a running answer; accept an offer. */
export function useProjectActions() {
  const store = useStore();
  return useMemo(() => ({
    create: (name: string, icon?: string | null) => store.act('project.create', { body: { name, ...(icon !== undefined ? { icon } : {}) } }, `Create “${name}”`),
    rename: (p: Project, name: string) => store.act('project.update', { id: p.id, body: { name } }, `Rename “${p.name}”`),
    setIcon: (p: Project, icon: string | null) => store.act('project.update', { id: p.id, body: { icon } }, `Change the icon of “${p.name}”`),
    archive: (p: Project) => store.act('project.update', { id: p.id, body: { archived: true } }, `Archive “${p.name}”`),
    restore: (p: Project) => store.act('project.update', { id: p.id, body: { archived: false } }, `Restore “${p.name}”`),
    moveTurn: (turnId: string, projectId: string, quiet = false) => store.act('turn.move', { id: turnId, body: { projectId } }, 'Move a message', { quiet }),
    /** Stop / Steer the run the person sees (`runId`): never kept for later; refused in place while offline */
    stop: (projectId: string, runId?: string | null) => store.act('project.stop', { id: projectId, ...(runId ? { body: { runId } } : {}) }, 'Stop the answer', { quiet: true }),
    steer: (projectId: string, text: string, runId?: string | null) => store.act('project.steer', { id: projectId, text, ...(runId ? { body: { runId } } : {}) }, 'Add to the answer', { quiet: true }),
    acceptOffer: (projectId: string, message?: string) => store.act('project.offer', { id: projectId, ...(message ? { text: message } : {}) }, 'Work on it in the background'),
    loadWork: (projectId: string) => store.loadProjectWork(projectId),
    loadFiles: (projectId: string) => store.client.getProjectFiles(projectId),
  }), [store]);
}

/** One calendar event or draft the store holds (a thread's "About Lesson with Ellen" chip), or undefined. */
export function useCalendarItem(id: string | null): CalendarItem | undefined {
  const all = useSlice((s) => s.calendar);
  return id ? all[id] : undefined;
}

/** Every job by id, archived ones included (a project's Work tab lists what the server says is its own). */
export function useJobMap(): Record<string, Job> {
  return useSlice((s) => s.jobs);
}
