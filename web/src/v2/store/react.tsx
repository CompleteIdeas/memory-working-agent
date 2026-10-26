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
import type { V2Store, StoreState, ActionKind, ActionArgs } from './core';
import { groupJobs, pillFor, activeJobs, monthLine } from './status';
import type { CalendarItem, Job, Project } from '../api/client';

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
  return useSyncExternalStore(store.subscribe, () => sel(store.getState()));
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
  const connection = useSlice((s) => s.connection);
  useEffect(() => { if (projectId && connection === 'live' && !store.getState().threadLoaded[projectId]) void store.loadThread(projectId); }, [store, projectId, connection]);
  return { turns: projectId ? threads[projectId] ?? EMPTY : EMPTY, loaded: projectId ? !!loaded[projectId] : false };
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
