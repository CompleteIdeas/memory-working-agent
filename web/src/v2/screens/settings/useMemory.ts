/**
 * Settings › What I remember, Activity and the spending detail's data (v2 build, slice S5): GET /memory, /activity,
 * /spending/detail and every change through the typed client, each with its own Idempotency-Key. Forget and Promote
 * are sent with `confirmed: true` only after the person said yes on the screen (the server asks too). The two
 * downloads are fetched with the app's headers and handed to the browser to save.
 *
 * The words are plain functions, tested without React (tests/web-v2-s5.test.ts).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SignInRequired, newKey,
  type ActivityRun, type ActivityView, type DownloadedFile, type Me, type MemoryFact, type MemoryRoutine, type MemoryView, type Spending, type SpendingDetail,
} from '../../api/client';
import { useStore } from '../../store/react';
import { isAdmin, messageOf, type ActOutcome } from './useSettings';

// ---------- plain words ----------

/** "$0.0234" small, "$1.29" usual, "$0" nothing (the classic Billing card's precision: tiny runs still show). */
export function usd(n: number): string {
  if (!n) return '$0';
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}
/** 12,345 → "12.3k", 2,400,000 → "2.4M" */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}
export function sourceLabel(f: Pick<MemoryFact, 'source' | 'origin' | 'about'>): string {
  if (f.source === 'outside') return f.origin ? `From ${f.origin.replace(/^email\//, 'an email from ')}` : 'From a file, an email or the web';
  if (f.source === 'you') return f.about ? 'About you' : 'You told me';
  return 'I worked this out';
}
export interface FactGroups { you: MemoryFact[]; inferred: MemoryFact[]; outside: MemoryFact[] }
export function groupFacts(facts: MemoryFact[]): FactGroups {
  return { you: facts.filter((f) => f.source === 'you'), inferred: facts.filter((f) => f.source === 'inferred'), outside: facts.filter((f) => f.source === 'outside') };
}
const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
/** Two notes with the same name: the list is newest first, so the first is the newer (the classic page's marks). */
export function ageMarks(facts: MemoryFact[]): Map<string, 'newest' | 'older'> {
  const out = new Map<string, 'newest' | 'older'>();
  const seen = new Map<string, string>();
  for (const f of facts) { const k = norm(f.name); const had = seen.get(k); if (had) { out.set(had, 'newest'); out.set(f.id, 'older'); } else seen.set(k, f.id); }
  return out;
}
export function countLine(v: Pick<MemoryView, 'total' | 'query'>, shown: number): string {
  if (v.query) return v.total ? `${v.total} thing${v.total === 1 ? ' matches' : 's match'} “${v.query}”${v.total > shown ? `, the newest ${shown} shown` : ''}.` : `Nothing matches “${v.query}”.`;
  return v.total ? `${v.total} thing${v.total === 1 ? '' : 's'} I’ve learned${v.total > shown ? `, the newest ${shown} shown` : ''}.` : 'Nothing learned yet.';
}
/** Shown above an outside fact's correction box: saving it is the person's yes (sent as `confirmed`). */
export const OUTSIDE_WARNING = 'This came from outside — email, files or the web. What you write here becomes something I trust.';
/** The most the list loads; past it, search finds older ones. */
export const MAX_LIST = 500;

export function routineLine(r: MemoryRoutine): string {
  if (r.status === 'active') return 'In use: its steps guide similar tasks.';
  if (r.status === 'retired') return 'Retired: it no longer guides new tasks.';
  return r.tainted ? 'Proposed after reading outside content. Read every step before you promote it.' : 'Proposed. It does nothing until you promote it.';
}

/** "Today 9:42 AM", "Yesterday 6:10 PM", "Nov 3, 2:15 PM" */
export function whenLine(at: number | null, now = Date.now()): string {
  if (!at) return '';
  const d = new Date(at), n = new Date(now);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / 86_400_000);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}
export function durationLine(ms: number | null): string | null {
  if (ms === null) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} minute${m === 1 ? '' : 's'}` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
/** Tool names in words: "browser_open" → "browser open". */
export const toolWords = (t: string) => t.replace(/[_.-]+/g, ' ');
/** The second line of a run: how it ended · where · steps · cost. */
export function runLine(r: ActivityRun): string {
  const parts = [r.outcomeText, r.where, `${r.steps} step${r.steps === 1 ? '' : 's'}`, usd(r.costUsd)];
  const d = durationLine(r.durationMs); if (d) parts.splice(3, 0, d);
  if (r.learned) parts.push(`learned ${r.learned} thing${r.learned === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** The chart's bars as a share of the busiest day (0 to 100); a day with any spend shows at least a sliver. */
export function barHeights(days: SpendingDetail['days']): number[] {
  const max = Math.max(...days.map((d) => d.usd), 0);
  return days.map((d) => (d.usd <= 0 || max <= 0 ? 0 : Math.max(4, Math.round((d.usd / max) * 100))));
}
/** "Nov 9" from "2026-11-09" (the day as the helper counts it, not shifted by the browser's zone). */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
/** The chart's text alternative: the total, the busiest day and how many days had any spend. */
export function chartSummary(days: SpendingDetail['days']): string {
  if (!days.length) return 'No days to show.';
  const total = days.reduce((a, d) => a + d.usd, 0);
  const active = days.filter((d) => d.usd > 0);
  if (!active.length) return `Nothing spent from ${dayLabel(days[0].day)} to ${dayLabel(days[days.length - 1].day)}.`;
  const top = active.reduce((a, d) => (d.usd > a.usd ? d : a));
  return `${usd(Math.round(total * 10_000) / 10_000)} over the last ${days.length} days, on ${active.length} day${active.length === 1 ? '' : 's'}. The most was ${usd(top.usd)} on ${dayLabel(top.day)}.`;
}
export function tokensLine(t: SpendingDetail['month']['tokens']): string {
  return `${tokens(t.in)} in (${tokens(t.cached)} reused), ${tokens(t.out)} out${t.reasoning ? `, ${tokens(t.reasoning)} thinking` : ''}`;
}
export function balanceLine(b: SpendingDetail['balance'], now = Date.now()): string | null {
  if (!b) return null;
  return `${usd(b.remainingUsd)} left on ${b.label} (checked ${whenLine(b.at, now).replace(/^Today /, '')}).`;
}

/** Hand a fetched file to the browser to save. */
export function saveFile(f: DownloadedFile): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return;
  const url = URL.createObjectURL(new Blob([f.text], { type: f.type }));
  const a = document.createElement('a');
  a.href = url; a.download = f.filename; a.rel = 'noopener'; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------- the data ----------

export interface Loaded<T> { me: Me | null; data: T | null; loading: boolean; error: string | null }

function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const store = useStore();
  const [s, setS] = useState<Loaded<T>>({ me: null, data: null, loading: true, error: null });
  const gen = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++gen.current;
    try {
      const [me, data] = await Promise.all([store.client.getMe(), load()]);
      if (mine === gen.current) setS({ me, data, loading: false, error: null });
    } catch (e) {
      if (e instanceof SignInRequired) { store.signedOut(); return; }
      if (mine === gen.current) setS((d) => ({ ...d, loading: false, error: messageOf(e) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, ...deps]);
  useEffect(() => { void reload(); }, [reload]);
  return { ...s, setData: (f: (d: T) => T) => setS((x) => (x.data ? { ...x, data: f(x.data) } : x)), reload };
}

export function useMemoryData() {
  const store = useStore();
  const client = store.client;
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(40);
  const s = useLoad<MemoryView>(() => client.getMemory({ ...(q ? { q } : {}), limit }), [client, q, limit]);
  // the latest load's setters (a search makes a new reload; an action finishing later must use the current one)
  const live = useRef(s);
  live.current = s;
  const actions = useMemo(() => {
    /** `toast`: the row it was on goes away (forgotten, or replaced by the correction), so the words go to a toast */
    const act = async <T,>(run: (key: string) => Promise<T>, after?: (r: T) => void, toast = false): Promise<ActOutcome> => {
      try {
        const r = await run(newKey());
        after?.(r);
        const message = (r as { message?: string }).message;
        if (toast && message) store.notice(message, 'info');
        return { ok: true, message };
      } catch (e) {
        if (e instanceof SignInRequired) { store.signedOut(); return { ok: false, message: e.message }; }
        return { ok: false, message: messageOf(e) };
      }
    };
    return {
      correct: (f: MemoryFact, text: string) => act((k) => client.correctMemory(f.id, text, { key: k, confirmed: !f.trusted }), (r) => live.current.setData((d) => ({ ...d, facts: d.facts.map((x) => (x.id === f.id && r.fact ? r.fact : x)) })), true),
      forget: (f: MemoryFact) => act((k) => client.forgetMemory(f.id, { key: k, confirmed: true }), () => live.current.setData((d) => ({ ...d, facts: d.facts.filter((x) => x.id !== f.id), total: Math.max(0, d.total - 1) })), true),
      removePreference: (rule: string) => act((k) => client.removePreference(rule, { key: k, confirmed: true }), (r) => live.current.setData((d) => ({ ...d, preferences: r.preferences }))),
      promote: (r: MemoryRoutine) => act((k) => client.promoteRoutine(r.id, r.store, { key: k, confirmed: true }), () => void live.current.reload()),
      retire: (r: MemoryRoutine) => act((k) => client.retireRoutine(r.id, r.store, { key: k }), () => void live.current.reload()),
      exportAll: async (): Promise<ActOutcome> => {
        try { saveFile(await client.exportMemory()); return { ok: true, message: 'Saved mwa-memory.md to your downloads.' }; }
        catch (e) { if (e instanceof SignInRequired) store.signedOut(); return { ok: false, message: messageOf(e) }; }
      },
    };
  }, [client, store]);
  return { ...s, view: s.data, admin: isAdmin(s.me), q, search: setQ, limit, showMore: () => setLimit((n) => Math.min(MAX_LIST, n + 60)), ...actions };
}

export function useActivity() {
  const store = useStore();
  const [limit, setLimit] = useState(30);
  const s = useLoad<ActivityView>(() => store.client.getActivity({ limit }), [store.client, limit]);
  return { ...s, view: s.data, limit, showMore: () => setLimit((n) => Math.min(200, n + 50)) };
}

export function useSpendingDetail() {
  const store = useStore();
  const client = store.client;
  const s = useLoad<{ month: Spending | null; detail: SpendingDetail }>(async () => {
    const [month, detail] = await Promise.all([client.getSpending().catch((e) => { if (e instanceof SignInRequired) throw e; return null; }), client.getSpendingDetail()]);
    return { month, detail };
  }, [client]);
  const downloadCsv = async (): Promise<ActOutcome> => {
    try { const f = await client.downloadSpendingCsv(30); saveFile(f); return { ok: true, message: `Saved ${f.filename} to your downloads.` }; }
    catch (e) { if (e instanceof SignInRequired) store.signedOut(); return { ok: false, message: messageOf(e) }; }
  };
  return { ...s, admin: isAdmin(s.me), downloadCsv };
}
