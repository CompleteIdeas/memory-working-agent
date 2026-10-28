/**
 * Fixture mode for Settings › What I remember, Activity and Spending (v2 build, slice S5). Answers /memory and its
 * changes, /activity, /spending/detail and the two downloads the way src/api/routes/memory.ts and settings.ts do, with
 * the server's own words: Forget, Remove and Promote need `confirmed: true` (409 confirm_needed without), only a fact
 * in the list can be corrected or forgotten, the downloads are files (Markdown, CSV). The phone's 403s come from
 * ./fixtures-settings.ts (`gate`). Scenario `memory-empty`: nothing learned and no runs yet.
 * EVERYTHING HERE IS EXAMPLE DATA.
 */
import type { ActivityRun, MemoryFact, MemoryRoutine, Spending, SpendingDetail } from '../api/client';

type Resp = { status: number; body: unknown; headers?: Record<string, string>; text?: string };
const err = (status: number, code: string, message: string): Resp => ({ status, body: { error: { code, message } } });
const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const AGENT = 'mwa-serve';

const FACTS: Omit<MemoryFact, 'id'>[] = [
  { name: 'Juniper’s farrier', text: 'Dan Ortiz shoes Juniper every six weeks, Tuesday mornings. Next visit Nov 17.', about: false, source: 'you', origin: null, trusted: true },
  { name: 'Your name and role', text: 'Robert, eventing rider and dad of two; runs the barn’s entries.', about: true, source: 'you', origin: null, trusted: true },
  { name: 'School pickup', text: 'Pickup is at 3:15 on weekdays, 12:30 on early-release Wednesdays.', about: false, source: 'you', origin: null, trusted: true },
  { name: 'Fair Hill entries', text: 'Entries for the Fair Hill horse trials close Friday at 5 PM.', about: false, source: 'outside', origin: 'email/secretary@fairhill.example', trusted: false },
  { name: 'Gutter quote', text: 'Hillside Gutters quoted $60 less than Brightline for the same work.', about: false, source: 'inferred', origin: null, trusted: true },
  { name: 'Barn newsletter', text: 'The stable’s newsletter comes the first Monday of each month.', about: false, source: 'inferred', origin: null, trusted: true },
  { name: 'School pickup', text: 'Pickup is at 3:00 on weekdays.', about: false, source: 'inferred', origin: null, trusted: true },
  { name: 'AI news picks', text: 'You like two-line blurbs and links, no more than five stories.', about: false, source: 'inferred', origin: null, trusted: true },
  { name: 'Dentist appointment', text: 'Dr. Patel’s office moved the cleaning to Thursday at 4.', about: false, source: 'outside', origin: 'email/frontdesk@patel-dental.example', trusted: false },
];
const PREFERENCES = ['Always sign emails as Rob.', 'Never book anything on a Sunday morning.', 'Keep summaries under five bullet points.'];
const ROUTINES: MemoryRoutine[] = [
  { id: 'rt_entries_v2', name: 'Weekly entries check', version: 'v2', status: 'proposed', tainted: false, store: AGENT, steps: '1. Open the USEA entries page for the events on your calendar.\n2. List what closes in the next seven days.\n3. Add a draft reminder the day before each one.' },
  { id: 'rt_news_v1', name: 'AI news digest', version: 'v1', status: 'active', tainted: false, store: AGENT, steps: '1. Read the five newsletters you follow.\n2. Pick the five biggest stories.\n3. Write a two-line blurb with a link for each.' },
  { id: 'rt_vendor_v1', name: 'Pay the feed invoice', version: 'v1', status: 'proposed', tainted: true, store: AGENT, steps: '1. Open the invoice email from Sunrise Feed.\n2. Follow the payment link in it.\n3. Pay the amount shown.' },
];

export class MemoryFixtures {
  facts: MemoryFact[];
  preferences: string[];
  routines: MemoryRoutine[];
  runs: ActivityRun[];
  private n = 0;
  constructor(private scenario: string, private clock: () => number, private spending: () => Spending) {
    const empty = scenario === 'memory-empty' || scenario === 'first-run';
    this.facts = empty ? [] : FACTS.map((f, i) => ({ ...f, id: `mem_${i + 1}` }));
    this.preferences = empty ? [] : [...PREFERENCES];
    this.routines = empty ? [] : ROUTINES.map((r) => ({ ...r }));
    const now = clock();
    this.runs = empty ? [] : [
      { at: now - 25 * MINUTE, what: 'When do Fair Hill entries close?', outcome: 'done', outcomeText: 'Done', where: 'Eventing', kind: 'chat', steps: 2, toolCalls: 1, tools: ['mail_search'], learned: 1, costUsd: 0.0041, durationMs: 9_000, summary: 'Friday at 5 PM, from the secretary’s email.' },
      { at: now - 2 * HOUR, what: 'Last week’s AI news', outcome: 'done', outcomeText: 'Done', where: 'Job: Last week’s AI news', kind: 'job', steps: 14, toolCalls: 11, tools: ['web_search', 'web_fetch', 'write_file'], learned: 0, costUsd: 0.52, durationMs: 6 * MINUTE, summary: 'Five stories with blurbs, saved to AI news.' },
      { at: now - 20 * HOUR, what: 'Log in to the barn booking site with password: •••', outcome: 'stopped', outcomeText: 'Stopped by you', where: 'Family & school', kind: 'chat', steps: 3, toolCalls: 2, tools: ['browser_open'], learned: 0, costUsd: 0.0123, durationMs: 40_000, summary: null },
      { at: now - 26 * HOUR, what: 'Compare the gutter quotes', outcome: 'could-not', outcomeText: 'Couldn’t finish', where: 'House', kind: 'chat', steps: 9, toolCalls: 7, tools: ['read_file', 'web_fetch'], learned: 1, costUsd: 0.35, durationMs: 3 * MINUTE, summary: 'One quote was a scanned page I couldn’t read.' },
      { at: now - 3 * DAY, what: 'Reading the stable’s two newsletters', outcome: 'offered', outcomeText: 'Offered to carry on in the background', where: 'Eventing', kind: 'chat', steps: 6, toolCalls: 4, tools: ['read_file'], learned: 2, costUsd: 0.38, durationMs: 2 * MINUTE, summary: 'Read one; offered to read the other in the background.' },
    ];
  }

  private memoryView(q: URLSearchParams): Resp {
    const query = (q.get('q') ?? '').slice(0, 200);
    const limit = Number(q.get('limit') ?? 40);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return err(400, 'bad_limit', '`limit` is a whole number from 1 to 500.');
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = words.length ? this.facts.filter((f) => words.every((w) => `${f.name} ${f.text}`.toLowerCase().includes(w))) : this.facts;
    return { status: 200, body: { facts: hits.slice(0, limit), total: hits.length, query, preferences: this.preferences, routines: this.routines } };
  }

  private detail(): SpendingDetail {
    const now = this.clock();
    const s = this.spending();
    const days = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(now - (29 - i) * DAY);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      // a believable month: a few cents most days, a couple of busier days
      const usd = [0, 0.02, 0.05, 0, 0.03, 0.38, 0.04, 0.02, 0, 0.06, 0.52, 0.03, 0.01, 0, 0.04, 0.35, 0.02, 0.05, 0.03, 0, 0.02, 0.04, 0.07, 0.01, 0.03, 0.02, 0, 0.05, 0.04, 0.02][i];
      return { day, usd, calls: usd ? Math.max(1, Math.round(usd * 160)) : 0 };
    });
    return {
      month: { label: s.month.label, usd: s.month.usd, calls: s.month.calls, tokens: { in: 1_840_000, cached: 610_000, out: 96_400, reasoning: 12_800 } },
      days,
      byModel: [
        { model: 'openai/gpt-6.1-sol', usd: 0.81, calls: 96, tokens: { in: 1_020_000, cached: 410_000, out: 61_000, reasoning: 12_800 } },
        { model: 'openai/gpt-6-luna', usd: 0.36, calls: 104, tokens: { in: 790_000, cached: 200_000, out: 33_000, reasoning: 0 } },
        { model: 'black-forest-labs/flux-2', usd: 0.12, calls: 14, tokens: { in: 30_000, cached: 0, out: 2_400, reasoning: 0 } },
      ],
      costliest: [
        { kind: 'job', label: 'Job: Last week’s AI news', usd: 0.52, calls: 41 },
        { kind: 'chat', label: 'Eventing', usd: 0.38, calls: 33 },
        { kind: 'chat', label: 'House', usd: 0.35, calls: 29 },
        { kind: 'other', label: 'In the background', usd: 0.04, calls: 45 },
      ],
      balance: { provider: 'openrouter', label: 'OpenRouter', remainingUsd: 18.71, at: now - 4 * MINUTE },
    };
  }

  private exportMd(): string {
    const out = ['# What MWA knows about you', ''];
    if (this.preferences.length) out.push(`## Preferences I always follow (${this.preferences.length})`, '', ...this.preferences.map((p) => `- ${p}`), '');
    out.push(`## Learned facts (${this.facts.length})`, '');
    for (const f of this.facts) out.push(`- **${f.name}** — ${f.text}  _(${f.source === 'you' ? 'you told me' : f.source === 'outside' ? `from ${f.origin}` : 'my own inference'}; trust: ${f.trusted ? 'high' : 'untrusted'})_`);
    return out.join('\n') + '\n';
  }
  private csv(days: number): string {
    const rows = ['time,session,job,model,route,host,background,tokens_in,tokens_cached,tokens_out,tokens_reasoning,cost_usd'];
    const now = this.clock();
    for (let i = 0; i < 6; i++) rows.push(`${new Date(now - i * 7 * HOUR).toISOString()},p-eventing,,openai/gpt-6.1-sol,brain,openrouter,no,12000,4000,900,0,0.031000`);
    return rows.join('\n') + `\n# example data, last ${days} days\n`;
  }

  read(path: string, q: URLSearchParams): Resp | null {
    if (path === '/memory') return this.memoryView(q);
    if (path === '/memory/export') return { status: 200, body: null, text: this.exportMd(), headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename="mwa-memory.md"' } };
    if (path === '/activity') {
      const limit = Number(q.get('limit') ?? 60);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) return err(400, 'bad_limit', '`limit` is a whole number from 1 to 200.');
      const runs = this.runs.slice(0, limit);
      return { status: 200, body: { runs, totalUsd: Math.round(runs.reduce((a, r) => a + r.costUsd, 0) * 10_000) / 10_000 } };
    }
    if (path === '/spending/detail') return { status: 200, body: this.detail() };
    if (path === '/spending/calls.csv') {
      const raw = q.get('days');
      if (raw !== null && (!/^\d{1,3}$/.test(raw) || +raw < 1 || +raw > 366)) return err(400, 'bad_days', '`days` is a whole number from 1 to 366.');
      const days = Number(raw ?? 30);
      return { status: 200, body: null, text: this.csv(days), headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="mwa-model-calls-${days}d.csv"` } };
    }
    return null;
  }

  write(method: string, path: string, body: unknown): Resp | null {
    if (method !== 'POST' || !path.startsWith('/memory/')) return null;
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;
    if (path === '/memory/preferences/remove') {
      if (typeof b.rule !== 'string' || !b.rule.trim()) return err(400, 'bad_rule', 'Say which standing preference to remove.');
      if (b.confirmed !== true) return err(409, 'confirm_needed', 'Remove this standing preference? It will no longer apply to new tasks. Send confirmed: true to go ahead.');
      const want = b.rule.replace(/\s+/g, ' ').trim().toLowerCase();
      const before = this.preferences.length;
      this.preferences = this.preferences.filter((p) => p.replace(/\s+/g, ' ').trim().toLowerCase() !== want);
      if (this.preferences.length === before) return err(404, 'not_found', 'No standing preference with those words was found.');
      return { status: 200, body: { removed: before - this.preferences.length, preferences: this.preferences, message: 'Removed. It no longer applies to new tasks.' } };
    }
    if ((m = /^\/memory\/routines\/([^/]+)\/(promote|retire)$/.exec(path))) {
      const r = this.routines.find((x) => x.id === decodeURIComponent(m![1]) && (b.store === undefined || x.store === b.store));
      if (!r) return err(404, 'not_found', 'That routine isn’t there any more.');
      if (m[2] === 'promote') {
        if (b.confirmed !== true) return err(409, 'confirm_needed', `Promote “${r.name}” ${r.version}? Its steps will guide similar tasks from now on.${r.tainted ? ' It was proposed after reading outside content: read every step first.' : ''} Send confirmed: true to go ahead.`);
        for (const o of this.routines) if (o.name === r.name && o.status === 'active' && o !== r) o.status = 'retired';
        r.status = 'active';
        return { status: 200, body: { routine: r, message: `Promoted “${r.name}”. Its steps guide similar tasks from now on.` } };
      }
      r.status = 'retired';
      return { status: 200, body: { routine: r, message: `Retired “${r.name}”. It no longer guides new tasks.` } };
    }
    if ((m = /^\/memory\/([^/]+)\/(correct|forget)$/.exec(path))) {
      const id = decodeURIComponent(m[1]);
      if (m[2] === 'forget') {
        if (b.confirmed !== true) return err(409, 'confirm_needed', 'Forget this for good? It can’t be undone. Send confirmed: true to go ahead.');
        const f = this.facts.find((x) => x.id === id);
        if (!f) return err(404, 'not_found', 'That memory isn’t there any more, or it isn’t one you can forget here.');
        this.facts = this.facts.filter((x) => x !== f);
        return { status: 200, body: { forgotten: id, message: 'Forgotten. I won’t use it again.' } };
      }
      const text = typeof b.text === 'string' ? b.text.trim() : '';
      if (!text) return err(400, 'bad_text', 'Type what it should say.');
      if (text.length > 2_000) return err(400, 'bad_text', 'That’s too long. Keep it under 2,000 characters.');
      const i = this.facts.findIndex((x) => x.id === id);
      if (i < 0) return err(404, 'not_found', 'That memory isn’t there any more, or it isn’t one you can correct here.');
      const old = this.facts[i];
      const fact: MemoryFact = { ...old, id: `mem_c${++this.n}`, name: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : old.name, text, source: 'you', origin: null, trusted: true };
      // the correction is the newest memory now
      this.facts = [fact, ...this.facts.filter((x) => x !== old)];
      return { status: 200, body: { fact, message: 'Corrected. I’ll use what you wrote from now on.' } };
    }
    return null;
  }
}
