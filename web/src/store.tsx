// One store for the whole app (D1): conversations and their turns, cards, schedule, background work and the runs
// this page follows. Every view builds its tasks from here through tasks.ts, so a status shown in the chat, the
// rail, Needs you and the digest is the same status.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  getConversations, getConversation, getApprovalsFull, getSchedule, getWork, getStatus, getLive, chatStream, attachStream,
  stopRun, steerRun, startWork, decideApproval, scheduleAction, sessionFolder, getSources, setKnownFolders,
  type ConversationSummary, type ConversationTurn, type PendingApproval, type ApprovalOutcome, type AutoApproved, type ScheduleRow, type WorkGoal,
  type ChatResult, type StatusResp, type BusyInfo,
} from './api';
import { buildTasks, setGrantedNames, type Task, type LocalTask, type LiveState } from './tasks';

const newSessionId = () => 'web-' + Math.random().toString(36).slice(2, 9);
const ls = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
function readJson<T>(k: string, d: T): T { try { const v = ls.get(k); return v ? JSON.parse(v) as T : d; } catch { return d; } }

export interface Busy { session: string; message: string; info?: BusyInfo }
export interface Toast { id: number; text: string; action?: { label: string; run: () => void } }

interface Store {
  session: string;
  openSession: (s: string, focusTask?: string) => void;
  newConversation: () => void;
  focus: { key: string; n: number } | null;
  convs: ConversationSummary[];
  turns: Record<string, ConversationTurn[]>;
  pending: PendingApproval[]; recent: ApprovalOutcome[]; auto: AutoApproved[];
  schedule: ScheduleRow[]; goals: WorkGoal[]; status: StatusResp | null;
  tasksFor: (session: string) => Task[];
  allTasks: Task[];
  /** cards whose conversation is not one of these (Telegram, a scheduled run) */
  looseCards: PendingApproval[];
  send: (text: string, opts?: { stay?: boolean; session?: string; resume?: boolean }) => 'sent' | 'busy';
  busy: Busy | null; setBusy: (b: Busy | null) => void;
  stop: (session: string) => Promise<string>;
  steer: (session: string, text: string) => Promise<{ ok: boolean; message: string }>;
  answerOffer: (t: Task, work: boolean) => Promise<void>;
  decide: (id: string, approve: boolean, dupes?: string[]) => Promise<{ ok: boolean; message: string }>;
  deciding: Set<string>;
  jobAction: (action: 'cancel' | 'uncancel' | 'pause' | 'resume' | 'update', body: Record<string, unknown>) => Promise<{ ok: boolean; message: string }>;
  cancelled: Record<string, { row: ScheduleRow; at: number }>;
  refresh: () => void;
  toasts: Toast[]; toast: (text: string, action?: Toast['action']) => void; dismissToast: (id: number) => void;
}

const Ctx = createContext<Store | null>(null);
export function useStore(): Store { const s = useContext(Ctx); if (!s) throw new Error('store missing'); return s; }

export function StoreProvider({ children, onActivity }: { children: ReactNode; onActivity?: () => void }) {
  const [session, setSession] = useState(() => { let s = ls.get('mwa-session'); if (!s) { s = newSessionId(); ls.set('mwa-session', s); } return s; });
  const [focus, setFocus] = useState<{ key: string; n: number } | null>(null);
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [turns, setTurns] = useState<Record<string, ConversationTurn[]>>({});
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [recent, setRecent] = useState<ApprovalOutcome[]>([]);
  const [auto, setAuto] = useState<AutoApproved[]>([]);
  const [schedule, setSchedule] = useState<ScheduleRow[]>([]);
  const [goals, setGoals] = useState<WorkGoal[]>([]);
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [local, setLocal] = useState<LocalTask[]>([]);
  const [live, setLive] = useState<Record<string, LiveState>>({});
  const [offers, setOffers] = useState<Record<string, { answered: 'background' | 'now' | 'failed'; note?: string }>>(() => readJson('mwa-offers', {}));
  const [notes, setNotes] = useState<Record<string, string[]>>(() => readJson('mwa-run-notes', {}));
  const [busy, setBusy] = useState<Busy | null>(null);
  const [deciding, setDeciding] = useState<Set<string>>(new Set());
  const [cancelled, setCancelled] = useState<Record<string, { row: ScheduleRow; at: number }>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  /** running turns whose run the server no longer has (it ended without a kept answer, or the server restarted) */
  const [lost, setLost] = useState<Set<string>>(new Set());
  /** the steps this page saw for a run, kept after the server's copy of the turn replaces the page's own */
  const [stepsByRun, setStepsByRun] = useState<Record<string, LocalTask['steps']>>({});
  const attached = useRef<Map<string, EventSource>>(new Map());
  const lastSeen = useRef<Record<string, number>>({});

  const toast = useCallback((text: string, action?: Toast['action']) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 12000 : 6000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  useEffect(() => { ls.set('mwa-offers', JSON.stringify(offers)); }, [offers]);
  useEffect(() => { ls.set('mwa-run-notes', JSON.stringify(notes)); }, [notes]);

  const loadTurns = useCallback(async (s: string) => {
    const t = await getConversation(s);
    setTurns((prev) => ({ ...prev, [s]: t }));
    return t;
  }, []);
  const loadApprovals = useCallback(async () => { const a = await getApprovalsFull(); setPending(a.pending); setRecent(a.recent); setAuto(a.auto); }, []);
  const loadSchedule = useCallback(async () => setSchedule(await getSchedule()), []);
  const loadGoals = useCallback(async () => setGoals(await getWork()), []);
  const loadConvs = useCallback(async () => {
    const list = await getConversations();
    setConvs(list);
    // the turns of every listed conversation whose last turn changed since we read it
    const stale = list.filter((c) => lastSeen.current[c.session] !== c.last);
    await Promise.all(stale.map(async (c) => { lastSeen.current[c.session] = c.last; await loadTurns(c.session); }));
    return list;
  }, [loadTurns]);

  const refresh = useCallback(() => { void loadConvs(); void loadApprovals(); void loadSchedule(); void loadGoals(); }, [loadConvs, loadApprovals, loadSchedule, loadGoals]);

  // ── following a run: from the stream this page opened, or re-attached after a reload (F09) ──────────────
  const patchLive = useCallback((s: string, fn: (l: LiveState) => LiveState) => setLive((prev) => prev[s] ? { ...prev, [s]: fn(prev[s]) } : prev), []);
  const attach = useCallback((s: string) => {
    if (attached.current.has(s)) return;
    setLive((prev) => ({ ...prev, [s]: prev[s] ?? { startedAt: Date.now(), steps: [], notes: [] } }));
    let stepId = 0;
    const es = attachStream(s, {
      onRun: (r) => patchLive(s, (l) => ({ ...l, runId: r.runId, startedAt: r.startedAt, notes: notes[r.runId] ?? l.notes })),
      onStep: (st) => patchLive(s, (l) => ({ ...l, steps: [...l.steps, { ...st, id: stepId++ }] })),
      onStage: (st) => patchLive(s, (l) => ({ ...l, stage: st })),
      onStopping: () => patchLive(s, (l) => ({ ...l, stopping: true })),
      onResult: () => { attached.current.delete(s); setLive((prev) => { const n = { ...prev }; delete n[s]; return n; }); void loadTurns(s); void loadApprovals(); void loadSchedule(); onActivity?.(); },
      onError: () => { attached.current.delete(s); setLive((prev) => { const n = { ...prev }; delete n[s]; return n; }); void loadTurns(s); },
      onGone: () => {
        attached.current.delete(s); setLive((prev) => { const n = { ...prev }; delete n[s]; return n; });
        void loadTurns(s).then((t) => { const r = t.filter((x) => x.kind === 'running' && x.runId).map((x) => x.runId!); if (r.length) setLost((p) => new Set([...p, ...r])); });
      },
    });
    attached.current.set(s, es);
  }, [patchLive, loadTurns, loadApprovals, loadSchedule, notes, onActivity]);

  // first load, then keep up
  useEffect(() => {
    void getStatus().then(setStatus).catch(() => {});
    void getSources(session).then((x) => { if (x) { setKnownFolders(x.folders.map((f) => f.path)); setGrantedNames(x.folders.map((f) => f.path)); } });
    void (async () => {
      const t = await loadTurns(session);
      // a run still going in this conversation: show it and follow it (a reload never loses the turn)
      const l = await getLive(session);
      if (l || t.some((x) => x.kind === 'running')) attach(session);
      await loadConvs();
    })();
    void loadApprovals(); void loadSchedule(); void loadGoals();
    const a = setInterval(() => void loadApprovals(), 10_000);
    const b = setInterval(() => void loadConvs(), 15_000);
    const c = setInterval(() => { void loadSchedule(); void loadGoals(); }, 20_000);
    return () => { clearInterval(a); clearInterval(b); clearInterval(c); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // a running turn in any conversation we know of: follow it so its stage shows in the rail
  useEffect(() => {
    for (const [s, ts] of Object.entries(turns)) {
      const last = ts[ts.length - 1];
      if (last?.kind === 'running' && !(last.runId && lost.has(last.runId)) && !attached.current.has(s) && !local.some((l) => l.session === s && !l.result && !l.error)) attach(s);
    }
  }, [turns, attach, local, lost]);

  const openSession = useCallback((s: string, focusTask?: string) => {
    setSession(s); ls.set('mwa-session', s);
    if (focusTask) setFocus({ key: focusTask, n: Date.now() });
    void loadTurns(s).then((t) => { if (t.some((x) => x.kind === 'running')) attach(s); });
    window.dispatchEvent(new CustomEvent('mwa-show', { detail: 'chat' }));
  }, [loadTurns, attach]);
  const newConversation = useCallback(() => { const s = newSessionId(); setSession(s); ls.set('mwa-session', s); setBusy(null); window.dispatchEvent(new CustomEvent('mwa-show', { detail: 'chat' })); }, []);
  // other parts of the app (Work cards, notices) open a conversation by event
  useEffect(() => {
    const open = (e: Event) => openSession(String((e as CustomEvent).detail));
    window.addEventListener('mwa-open-conversation', open); return () => window.removeEventListener('mwa-open-conversation', open);
  }, [openSession]);

  const isRunning = useCallback((s: string) => { const last = (turns[s] ?? []).slice(-1)[0]; return !!live[s] || local.some((l) => l.session === s && !l.result && !l.error) || (last?.kind === 'running' && !(last.runId && lost.has(last.runId))); }, [live, local, turns, lost]);

  const send = useCallback((text: string, opts: { stay?: boolean; session?: string; resume?: boolean } = {}): 'sent' | 'busy' => {
    const t = text.trim(); const s = opts.session ?? session;
    if (!t) return 'sent';
    if (isRunning(s)) { setBusy({ session: s, message: t }); return 'busy'; }
    const id = Date.now();
    const lt: LocalTask = { id, session: s, words: t, startedAt: id, steps: [], live: { startedAt: id, steps: [], notes: [] } };
    setLocal((prev) => [...prev, lt]);
    const patch = (fn: (x: LocalTask) => LocalTask) => setLocal((prev) => prev.map((x) => (x.id === id ? fn(x) : x)));
    const patchL = (fn: (l: LiveState) => LiveState) => patch((x) => (x.live ? { ...x, live: fn(x.live) } : x));
    let stepId = 0;
    chatStream(t, s, {
      onRun: (r) => patchL((l) => ({ ...l, runId: r.runId, startedAt: r.startedAt })),
      onStep: (st) => patch((x) => ({ ...x, steps: [...x.steps, { ...st, id: stepId++ }] })),
      onStage: (st) => patchL((l) => ({ ...l, stage: st })),
      onStopping: () => patchL((l) => ({ ...l, stopping: true })),
      onBusy: (b) => { setLocal((prev) => prev.filter((x) => x.id !== id)); setBusy({ session: s, message: t, info: b }); attach(s); },
      onResult: (r: ChatResult) => {
        patch((x) => ({ ...x, result: r }));
        setLocal((prev) => { const me = prev.find((x) => x.id === id); if (me && r.runId) setStepsByRun((m) => ({ ...m, [r.runId!]: me.steps })); return prev; });
        void loadTurns(s).then(() => setTimeout(() => setLocal((prev) => prev.filter((x) => x.id !== id || !x.result)), 50));
        void loadApprovals(); void loadSchedule(); void loadGoals(); void loadConvs(); onActivity?.();
      },
      onError: (m) => { patch((x) => ({ ...x, error: m })); void loadTurns(s); },
    }, { stay: opts.stay, resume: opts.resume });
    return 'sent';
  }, [session, isRunning, attach, loadTurns, loadApprovals, loadSchedule, loadGoals, loadConvs, onActivity]);

  const stop = useCallback(async (s: string) => {
    setLocal((prev) => prev.map((x) => (x.session === s && x.live && !x.result ? { ...x, live: { ...x.live, stopping: true } } : x)));
    patchLive(s, (l) => ({ ...l, stopping: true }));
    const r = await stopRun(s);
    return r.message;
  }, [patchLive]);

  const steer = useCallback(async (s: string, text: string) => {
    const r = await steerRun(s, text);
    if (r.ok) {
      const runId = live[s]?.runId ?? local.find((l) => l.session === s && !l.result)?.live?.runId;
      setLocal((prev) => prev.map((x) => (x.session === s && x.live && !x.result ? { ...x, live: { ...x.live, notes: [...x.live.notes, text] } } : x)));
      patchLive(s, (l) => ({ ...l, notes: [...l.notes, text] }));
      if (runId) setNotes((n) => ({ ...n, [runId]: [...(n[runId] ?? []), text] }));
    }
    return r;
  }, [live, local, patchLive]);

  const answerOffer = useCallback(async (t: Task, work: boolean) => {
    const k = t.local ? t.key : `${t.session}:${t.turnId ?? t.startedAt}`;
    const wk = `${t.session}:offer:${t.words}`;
    if (!work) { setOffers((o) => ({ ...o, [k]: { answered: 'now' }, [wk]: { answered: 'now' } })); send(t.words, { stay: true, session: t.session }); return; }
    setOffers((o) => ({ ...o, [k]: { answered: 'background', note: 'Starting…' }, [wk]: { answered: 'background' } }));
    const r = await startWork(t.words, t.session);
    setOffers((o) => ({ ...o, [k]: { answered: r.ok ? 'background' : 'failed', note: r.message }, [wk]: { answered: r.ok ? 'background' : 'failed', note: r.message } }));
    void loadGoals(); void loadSchedule(); onActivity?.();
  }, [send, loadGoals, loadSchedule, onActivity]);

  const decide = useCallback(async (id: string, approve: boolean, dupes: string[] = []) => {
    setDeciding((d) => new Set(d).add(id));
    const r = await decideApproval(id, approve);
    // the same action staged again (another way to make the same file, the same rule twice): withdrawn, so one
    // decision settles it and nothing runs twice
    for (const d of dupes) if (pending.some((p) => p.id === d)) await decideApproval(d, false);
    await loadApprovals();
    setDeciding((d) => { const n = new Set(d); n.delete(id); return n; });
    onActivity?.();
    return r;
  }, [loadApprovals, onActivity, pending]);

  const jobAction = useCallback(async (action: 'cancel' | 'uncancel' | 'pause' | 'resume' | 'update', body: Record<string, unknown>) => {
    const row = schedule.find((j) => j.id === body.id);
    const r = await scheduleAction(action, body);
    if (r.ok && action === 'cancel' && row) setCancelled((c) => ({ ...c, [row.id]: { row, at: Date.now() } }));
    if (r.ok && action === 'uncancel') setCancelled((c) => { const n = { ...c }; delete n[String(body.id)]; return n; });
    await loadSchedule();
    return r;
  }, [schedule, loadSchedule]);

  // the offers map is keyed by turn and by words, so an answered offer stays answered after a reload
  const offerFor = useMemo(() => {
    const out: Record<string, { answered: 'background' | 'now' | 'failed'; note?: string }> = { ...offers };
    for (const [s, ts] of Object.entries(turns)) for (const t of ts) if (t.kind === 'offer') { const w = offers[`${s}:offer:${t.message}`]; if (w && !out[`${s}:${t.ts}`]) out[`${s}:${t.ts}`] = w; }
    for (const l of local) { const w = offers[`${l.session}:offer:${l.words}`]; if (w && !out[`${l.session}:local-${l.id}`]) out[`${l.session}:local-${l.id}`] = w; }
    return out;
  }, [offers, turns, local]);

  const tasksFor = useCallback((s: string) => buildTasks({
    session: s, turns: turns[s] ?? [], lost, stepsByRun, notesByRun: notes, pending, recent, schedule, goals, local, offers: offerFor,
    live: live[s] ? { ...live[s], notes: [...new Set([...(live[s].runId ? notes[live[s].runId!] ?? [] : []), ...live[s].notes])] } : null,
  }), [turns, lost, stepsByRun, pending, recent, schedule, goals, local, offerFor, live, notes]);

  const allTasks = useMemo(() => {
    const sessions = new Set<string>([session, ...Object.keys(turns), ...local.map((l) => l.session)]);
    return [...sessions].flatMap((s) => tasksFor(s));
  }, [session, turns, local, tasksFor]);
  const looseCards = useMemo(() => {
    const known = new Set<string>([session, ...Object.keys(turns), ...local.map((l) => l.session)]);
    return pending.filter((p) => !p.session || !known.has(p.session));
  }, [pending, turns, local, session]);

  const value: Store = {
    session, openSession, newConversation, focus, convs, turns, pending, recent, auto, schedule, goals, status,
    tasksFor, allTasks, looseCards, send, busy, setBusy, stop, steer, answerOffer, decide, deciding, jobAction, cancelled, refresh,
    toasts, toast, dismissToast,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export { sessionFolder };
