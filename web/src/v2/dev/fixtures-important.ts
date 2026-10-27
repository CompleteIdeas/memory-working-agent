/**
 * Fixture mode for the Important list, the mail reader's extras and "Ask about this" (v2 build, slice W3). The
 * FixtureServer (./fixtures.ts) hands every /items, /items/skipped, /important/refresh, /triage/rules, POST
 * /mail/{id}/important and about-asks (/ask with `about`, /ask?about=, /ask/suggestions, /ask/{id}) to this module first.
 * Shapes follow api/openapi.yaml (tests/web-v2-fixtures.test.ts validates them); the behaviour follows the server
 * (src/api/routes/important.ts, src/v2/ask.ts): the same receipts, the same refusals in the same words (a free email
 * domain, a kind the headers cannot establish), rules that hide or show mail, answers kept under the item.
 *
 * The world is the prototype's Monday (fixture-data.ts ITEMS and SKIPPED), plus what the prototype did not have: a
 * phishing message, an unverified urgent one, a rule the person made last week, and the `sorting` scenario (sorting
 * is held back: "3 messages are waiting to be sorted", "Older mail … wasn't sorted yet"). EVERYTHING HERE IS EXAMPLE
 * DATA; nothing is sent or asked.
 */
import type { Ask, CalendarItem, ImportantGroup, ImportantItem, MailHeader, MailMessage, Project, TriageRule, Turn } from '../api/client';
import { FIXTURE_NOW, ITEMS, SKIPPED, at, dayStart } from './fixture-data';

type Resp = { status: number; body: unknown };
const err = (status: number, code: string, message: string): Resp => ({ status, body: { error: { code, message } } });
const MINUTE = 60_000, DAY = 86_400_000;
const GROUPS: ImportantGroup[] = ['today', 'week', 'earlier'];

/** What this module needs from the FixtureServer (its private writers, passed in as closures). */
export interface ImportantHost {
  clock(): number;
  seq(): number;
  emit(entity: 'item', id: string, op?: 'upsert' | 'delete'): number;
  putMail(m: MailHeader, body: string): void;
  putCal(c: CalendarItem): void;
  putTurn(t: Turn): void;
  makeTurn(p: Partial<Turn> & Pick<Turn, 'id' | 'projectId' | 'ts' | 'message' | 'reply'>): Turn;
  later(fn: () => void, ms: number): void;
  answerDelay(): number;
  mail: Map<string, MailHeader>;
  projects: Map<string, Project>;
  turns: Map<string, Turn>;
  bodyOf(id: string): string | undefined;
}

const KIND_PLURAL: Record<string, string> = { newsletter: 'newsletters', promotion: 'promotions', receipt: 'receipts', notification: 'notifications', personal: 'personal messages', work: 'work messages', social: 'social updates', other: 'other messages' };
const kindPlural = (k: string) => KIND_PLURAL[k] ?? `${k} messages`;
const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'aol.com']);
const SKIP_REASON: Record<string, string> = { newsletter: 'A mailing list.', receipt: 'A receipt.', promotion: 'In your promotions tab.', notification: 'Sent automatically.' };
const DRAFT_ADDED = 'Added to your calendar as a draft. Confirm it in MWA.';
const AFTER_READING_NOTE = 'Suggested after your helper read outside content (an email or a web page). Check it before you confirm.';
const BUDGET_NOTE = "I'm only sorting by your rules today (daily triage budget reached).";
const SUGGEST: Record<string, string[]> = {
  event: ['Remind me the day before', 'Who else is going?', 'What should I bring?'],
  mail: ['Why does this matter?', 'What did they ask last time?', 'What should I say back?'],
  conflict: ['Which one matters more?', 'Can one of them move?', 'Who do I need to tell?'],
  dated: ['Who else is going?', 'Remind me the day before', 'What did the newsletter say about it?'],
  result: ['What did it find?', 'What has it cost?', 'What should I do next?'],
  item: ['Why does this matter?', 'What should I do about it?'],
};

interface SkipEntry { mail: MailHeader; group: ImportantGroup; kind: string; reason: string; byYou: boolean }
type Rule = Omit<TriageRule, 'effect'>;

const localDay = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const domainOf = (addr: string) => addr.slice(addr.lastIndexOf('@') + 1).toLowerCase();

export class ImportantFixtures {
  items = new Map<string, ImportantItem & { gone?: boolean }>();
  skipped: SkipEntry[] = [];
  rules: Rule[] = [];
  asks = new Map<string, Ask>();
  /** the messages this module added (phishing, unverified, the skipped ones): their bodies and reader extras */
  private own = new Map<string, { header: MailHeader; body: string; replyTo?: { name: string | null; addr: string | null } }>();
  private n = 0;

  constructor(private h: ImportantHost, private scenario: string) {}

  // ---------- the world ----------
  seed() {
    const now = this.h.clock();
    const ts = (time: string, group: string) => {
      const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(time);
      if (m) { let hh = Number(m[1]) % 12; if (m[3] === 'PM') hh += 12; return at(0, `${hh}:${m[2]}`); }
      if (time === 'Yesterday') return at(-1, '17:00');
      if (time === 'Sat') return at(-2, '10:00');
      const d = /^Nov (\d+)$/.exec(time);
      // the prototype's "Nov 3" / "Nov 2" sat under Earlier; the server's Earlier starts a week back, so a day earlier
      if (d) return new Date(new Date(now).getFullYear(), 10, Number(d[1]) - 1, 9, 0).getTime();
      return group === 'today' ? now - 60 * MINUTE : dayStart(-8);
    };
    // the two messages the prototype did not have: they are in the inbox too
    this.ownMail({ id: 'm_px1', from: { name: 'PayPal', addr: 'service@paypa1-security.example' }, subject: 'Your account has been limited', receivedAt: at(0, '07:05'), unread: true, labels: ['INBOX'], caution: 'phishing',
      snippet: 'We noticed unusual activity. Confirm your details within 24 hours to restore access.' },
    'Dear customer,\n\nWe noticed unusual activity on your account and have limited what you can do with it. To restore access, confirm your details within 24 hours using the secure page below.\n\nConfirm my details (paypa1-security.example)\n\nPayPal Security Team',
    { name: 'Account Recovery', addr: 'resolve-team@protonmail.com' });
    this.ownMail({ id: 'm_px2', from: { name: 'Account Services', addr: 'no-reply@billing-notices.example' }, subject: 'Action required: confirm your payment details', receivedAt: at(-1, '08:30'), unread: false, labels: ['INBOX'], caution: 'unverified',
      snippet: 'Your payment method needs to be confirmed to avoid an interruption.' },
    'Your payment method needs to be confirmed to avoid an interruption of service. Sign in to review your billing details.\n\nAccount Services');

    const SRC: Record<string, ImportantItem['source']> = { gmail: 'mail', newsletter: 'newsletter', calendar: 'calendar-change', helper: 'calendar-change' };
    for (const x of ITEMS) {
      const i = x as typeof ITEMS[number] & { email?: string; action?: { label: string; primary?: boolean }; need?: string; event?: string };
      const mailId = i.email ? `m_${i.email}` : null;
      const mail = mailId ? this.h.mail.get(mailId) : undefined;
      let source = SRC[i.src] ?? 'mail';
      if (i.id === 'i-clash') source = 'calendar-conflict';
      if (i.id === 'i-quotes') source = 'job-result';
      if (i.id === 'i-dana') source = 'waiting-reply';
      let action: ImportantItem['action'] = mailId ? { kind: 'review-reply', label: 'Open' } : null;
      if (i.id === 'i-bookfair') action = { kind: 'add-to-calendar', label: 'Add to calendar', preview: { date: localDay(dayStart(5)), start: '15:00', end: '18:00', place: 'Oakwood Elementary', tz: 'America/New_York', when: 'Sat Nov 14, 3–6pm' } };
      if (i.id === 'i-clash') action = { kind: 'draft-note', label: 'Draft the note' };
      if (i.id === 'i-entries') action = { kind: 'remind', label: 'Remind me Friday' };
      const kind = i.id === 'i-hillside' ? 'receipt' : i.src === 'newsletter' ? 'newsletter' : i.id === 'i-ellen' ? 'personal' : i.id === 'i-dana' ? 'work' : null;
      this.putItem({
        id: `it_${i.id.slice(2)}`, source, sourceRef: mailId ?? (i.id === 'i-clash' ? 'conflict:google:e10|google:e11' : i.id === 'i-dentist' ? 'cd_e9' : i.id === 'i-quotes' ? 'j_quotes_nov3' : null),
        ts: ts(i.time, i.group), from: i.from, fromAddress: mail?.from.addr ?? null, caution: null, title: i.title, why: i.why,
        trust: mailId ? 'untrusted' : 'trusted', kind, action, projectId: i.project, mailId,
      });
    }
    this.putItem({ id: 'it_phish', source: 'mail', sourceRef: 'm_px1', ts: at(0, '07:05'), from: 'PayPal', fromAddress: 'service@paypa1-security.example', caution: 'phishing',
      title: 'Your account has been limited', why: "Says it's from PayPal but was sent from paypa1-security.example. Don't use its links.", trust: 'untrusted', kind: 'notification',
      action: { kind: 'review-reply', label: 'Open' }, projectId: null, mailId: 'm_px1' });
    this.putItem({ id: 'it_unverified', source: 'mail', sourceRef: 'm_px2', ts: at(-1, '08:30'), from: 'Account Services', fromAddress: 'no-reply@billing-notices.example', caution: 'unverified',
      title: 'Action required: confirm your payment details', why: "An urgent-sounding message from no-reply@billing-notices.example. Check it in the sender's own app or website, not through its links.",
      trust: 'untrusted', kind: 'notification', action: { kind: 'review-reply', label: 'Open' }, projectId: null, mailId: 'm_px2' });

    // what was left out, per group (headers only); Medium is skipped by a rule the person made last week
    for (const g of GROUPS) {
      SKIPPED[g].forEach((s, k) => {
        const addr = s.from === 'Medium' ? 'news@medium.example' : s.from === 'The Batch' ? 'news@thebatch.example' : `hello@${slug(s.from)}.example`;
        const receivedAt = g === 'today' ? at(0, '06:00') - k * 17 * MINUTE : g === 'week' ? at(-2, '09:00') - k * 3 * 60 * MINUTE : dayStart(-8) - k * DAY;
        const id = `m_sk_${g}_${k}`;
        const header = this.ownMail({ id, from: { name: s.from, addr }, subject: s.what, receivedAt, unread: false, labels: s.kind === 'promotion' ? ['INBOX', 'CATEGORY_PROMOTIONS'] : ['INBOX'],
          snippet: s.what, listId: s.kind === 'newsletter' ? `${slug(s.from)}.example` : null }, `${s.what}.\n\n${s.from}`, undefined, false);
        const mine = s.from === 'Medium';
        this.skipped.push({ mail: header, group: g, kind: s.kind, reason: mine ? 'You marked messages like this not important.' : SKIP_REASON[s.kind] ?? 'Looks like one you usually skip.', byYou: mine });
      });
    }
    this.rules.push({ id: 'tr_seed_medium', match: 'sender', value: 'news@medium.example', verdict: 'skip', createdAt: now - 6 * DAY });
  }

  private ownMail(p: Pick<MailHeader, 'id' | 'from' | 'subject' | 'receivedAt' | 'unread' | 'labels' | 'snippet'> & { listId?: string | null; caution?: MailHeader['caution'] }, body: string, replyTo?: { name: string | null; addr: string | null }, inInbox = true): MailHeader {
    const header: MailHeader = { id: p.id, account: 'gmail', provider: 'gmail', threadId: null, from: p.from, subject: p.subject, snippet: p.snippet, receivedAt: p.receivedAt, unread: p.unread,
      labels: p.labels, listId: p.listId ?? null, hasUnsub: !!p.listId, alsoIn: [], updatedSeq: 0, caution: p.caution ?? null };
    this.own.set(p.id, { header, body, replyTo });
    if (inInbox) this.h.putMail(header, body);
    return header;
  }

  private groupOf(ts: number): ImportantGroup {
    const today = localDay(this.h.clock()), day = localDay(ts);
    if (day >= today) return 'today';
    return day >= localDay(dayStart(-6)) ? 'week' : 'earlier';
  }
  private putItem(p: Pick<ImportantItem, 'id' | 'source' | 'sourceRef' | 'ts' | 'from' | 'fromAddress' | 'caution' | 'title' | 'why' | 'trust' | 'kind' | 'action' | 'projectId' | 'mailId'> & Partial<ImportantItem>) {
    const cur = this.items.get(p.id);
    const it: ImportantItem = {
      group: this.groupOf(p.ts), day: localDay(p.ts), state: 'open', handledAt: null, qa: [], ...cur, ...p, updatedSeq: this.h.seq() + 1,
    } as ImportantItem;
    this.items.set(it.id, it);
    this.h.emit('item', it.id);
  }
  private change(id: string, patch: Partial<ImportantItem> & { gone?: boolean }) {
    const cur = this.items.get(id)!;
    const next = { ...cur, ...patch, updatedSeq: this.h.seq() + 1 };
    this.items.set(id, next);
    this.h.emit('item', id);
    return next;
  }
  /** As the stream and /sync send an item: open (or snoozed), or handled within 30 days; otherwise a deletion. */
  current(id: string): ImportantItem | undefined {
    const it = this.items.get(id);
    if (!it || it.gone) return undefined;
    if (it.state === 'open' || it.state === 'snoozed') return this.out(it);
    return it.state === 'handled' && it.handledAt != null && this.h.clock() - it.handledAt <= 30 * DAY ? this.out(it) : undefined;
  }
  /** S4: an approval's Important item, as the server's triage makes it (src/v2/triage.ts rebuildApprovals). */
  putApprovalItem(id: string, title: string, phishing: boolean): void {
    this.putItem({ id: `it_ap_${id}`, source: 'approval', sourceRef: id, ts: this.h.clock() - 5 * MINUTE, from: 'Your helper', fromAddress: null, caution: phishing ? 'phishing' : null,
      title, why: 'Your helper needs your OK before it goes on.', trust: 'untrusted', kind: null, action: { kind: 'review-approval', label: 'Review' }, projectId: null, mailId: null });
  }
  dropApprovalItem(id: string): void { if (this.items.has(`it_ap_${id}`)) this.change(`it_ap_${id}`, { gone: true }); }
  snapshot(): ImportantItem[] { return [...this.items.keys()].map((id) => this.current(id)).filter((x): x is ImportantItem => !!x); }
  private out(it: ImportantItem & { gone?: boolean }): ImportantItem { const { gone: _g, ...rest } = it; void _g; return { ...rest, group: this.groupOf(rest.ts) }; }

  private allMail(): MailHeader[] { return [...this.h.mail.values(), ...[...this.own.values()].filter((o) => !this.h.mail.has(o.header.id)).map((o) => o.header)]; }
  private headerKind(m: MailHeader): string | null { return m.listId ? 'newsletter' : m.labels.includes('CATEGORY_PROMOTIONS') ? 'promotion' : null; }
  private matches(r: Rule, m: MailHeader): boolean {
    const addr = (m.from.addr ?? '').toLowerCase();
    if (r.match === 'sender') return addr === r.value;
    if (r.match === 'domain') return !!addr && domainOf(addr) === r.value;
    if (r.match === 'kind') return this.headerKind(m) === r.value;
    return m.listId === r.value;
  }
  private effect(r: Rule) {
    const hit = this.allMail().filter((m) => this.matches(r, m));
    return { messages: hit.length, senders: new Set(hit.map((m) => (m.from.addr ?? '').toLowerCase()).filter(Boolean)).size };
  }
  private skippedSummary() {
    const out = Object.fromEntries(GROUPS.map((g) => [g, { count: 0, kinds: {} as Record<string, number>, byYou: 0 }])) as Record<ImportantGroup, { count: number; kinds: Record<string, number>; byYou: number }>;
    for (const s of this.skipped) { const g = out[s.group]; g.count++; if (s.byYou) g.byYou++; else g.kinds[s.kind] = (g.kinds[s.kind] ?? 0) + 1; }
    return out;
  }
  private sorting() {
    if (this.scenario === 'sorting') {
      return { mode: 'rules-only' as const, waiting: 3, olderUnsorted: 120, spentTodayUsd: 0.1, capUsd: 0.1, lastRunAt: this.h.clock() - 4 * MINUTE,
        note: `${BUDGET_NOTE} 3 messages are waiting to be sorted. Older mail (120 messages more than 2 days old) wasn't sorted yet.` };
    }
    return { mode: 'full' as const, waiting: 0, olderUnsorted: 0, note: null, spentTodayUsd: 0.02, capUsd: 0.1, lastRunAt: this.h.clock() - 4 * MINUTE };
  }
  private list(state: 'open' | 'handled' | 'not-important', group?: ImportantGroup) {
    const items = [...this.items.values()].filter((i) => !i.gone && i.state === state).map((i) => this.out(i)).filter((i) => !group || i.group === group).sort((a, b) => b.ts - a.ts);
    return {
      state,
      groups: GROUPS.filter((g) => !group || g === group).map((g) => ({ group: g, label: ({ today: 'Today', week: 'This week', earlier: 'Earlier' } as const)[g], items: items.filter((i) => i.group === g) })),
      handledCount: [...this.items.values()].filter((i) => !i.gone && i.state === 'handled').length,
      skipped: this.skippedSummary(),
      sorting: this.sorting(),
    };
  }

  // ---------- reads ----------
  read(path: string, q: URLSearchParams): Resp | null {
    let m: RegExpExecArray | null;
    const group = () => {
      const g = q.get('group');
      if (g === null || g === '') return { ok: true as const, g: undefined };
      return (GROUPS as string[]).includes(g) ? { ok: true as const, g: g as ImportantGroup } : { ok: false as const };
    };
    if (path === '/items') {
      const s = q.get('state') ?? 'open';
      if (s !== 'open' && s !== 'handled' && s !== 'not-important') return err(400, 'bad_state', 'state must be open, handled or not-important.');
      const g = group();
      if (!g.ok) return err(400, 'bad_group', 'group must be today, week or earlier.');
      return { status: 200, body: this.list(s, g.g) };
    }
    if (path === '/items/skipped') {
      const g = group();
      if (!g.ok) return err(400, 'bad_group', 'group must be today, week or earlier.');
      const list = this.skipped.filter((s) => !g.g || s.group === g.g).sort((a, b) => b.mail.receivedAt - a.mail.receivedAt);
      return { status: 200, body: { group: g.g ?? null, count: list.length, skipped: list.map((s) => ({ mail: s.mail, group: s.group, kind: s.kind, reason: s.reason, byYou: s.byYou })) } };
    }
    if (path === '/triage/rules') return { status: 200, body: { rules: this.rules.map((r) => ({ ...r, effect: this.effect(r) })) } };
    if ((m = /^\/mail\/([^/]+)$/.exec(path))) {
      const o = this.own.get(decodeURIComponent(m[1]));
      if (!o) return null; // the FixtureServer's own messages
      const h = this.h.mail.get(o.header.id) ?? o.header;
      const elsewhere = !!o.replyTo && o.replyTo.addr !== h.from.addr;
      const msg: MailMessage = { ...h, to: 'robert@example.com', replyTo: [o.replyTo ?? h.from], replyGoesElsewhere: elsewhere,
        replyNote: elsewhere ? `Your reply will go to ${o.replyTo!.addr} (not the sender).` : null, bodyText: o.body, truncated: false, tooComplex: false, quotedLinesHidden: 0,
        imagesHidden: o.header.id === 'm_px1' ? 2 : 0, trackersRemoved: o.header.id === 'm_px1' ? 1 : 0, trust: 'untrusted', fetchedAt: this.h.clock() };
      return { status: 200, body: msg };
    }
    if (path === '/ask/suggestions' || path === '/ask') {
      if (!/^(item|mail|conflict):/.test(q.get('about') ?? '')) return null; // a job, an event, a draft: ./fixtures-w4.ts
      const about = this.aboutOf(q.get('about') ?? '');
      if (!about) return err(400, 'bad_about', 'about must be kind:id for something that exists.');
      if (path === '/ask/suggestions') return { status: 200, body: { about, suggestions: this.suggestions(about.kind, about.id) } };
      const asks = [...this.asks.values()].filter((a) => a.about?.kind === about.kind && a.about.id === about.id).sort((a, b) => a.createdAt - b.createdAt);
      return { status: 200, body: { about, asks } };
    }
    if ((m = /^\/ask\/([^/]+)$/.exec(path))) {
      const a = this.asks.get(decodeURIComponent(m[1]));
      if (!a) return null; // someone else's (W4's plans) or none
      return { status: 200, body: { ask: a, turn: a.turnId ? this.h.turns.get(a.turnId) ?? null : null } };
    }
    return null;
  }

  private aboutOf(s: string): { kind: 'item' | 'mail' | 'conflict'; id: string; label: string } | null {
    const i = s.indexOf(':');
    if (i < 0) return null;
    const kind = s.slice(0, i), id = s.slice(i + 1);
    if (kind === 'item') {
      const it = this.items.get(id);
      if (!it) return null;
      return { kind, id, label: it.id === 'it_bookfair' ? 'Book fair · Sat Nov 14' : it.title.length > 40 ? `${it.title.slice(0, 39)}…` : it.title };
    }
    if (kind === 'mail') {
      const m = this.h.mail.get(id) ?? this.own.get(id)?.header;
      return m ? { kind, id, label: m.subject.length > 40 ? `${m.subject.slice(0, 39)}…` : m.subject } : null;
    }
    if (kind === 'conflict') return { kind, id, label: 'Thursday at 4' };
    return null;
  }
  private suggestions(kind: string, id: string): string[] {
    if (kind === 'mail') return SUGGEST.mail;
    if (kind === 'conflict') return SUGGEST.conflict;
    const s = this.items.get(id)?.source ?? '';
    if (s === 'mail' || s === 'waiting-reply') return SUGGEST.mail;
    if (s === 'newsletter') return SUGGEST.dated;
    if (s === 'calendar-conflict') return SUGGEST.conflict;
    if (s === 'calendar-change') return SUGGEST.event;
    if (s === 'job-result') return SUGGEST.result;
    return SUGGEST.item;
  }

  // ---------- writes ----------
  write(method: string, path: string, body: unknown): Resp | null {
    let m: RegExpExecArray | null;
    const now = this.h.clock();
    if (method === 'POST' && (m = /^\/items\/([^/]+)\/(handled|unhandle|not-important|action)$/.exec(path))) {
      const it = this.items.get(decodeURIComponent(m[1]));
      if (!it || it.gone) return err(404, 'not_found', 'No such item.');
      if (m[2] === 'handled') {
        const already = it.state === 'handled';
        const after = already ? it : this.change(it.id, { state: 'handled', handledAt: now });
        return { status: 200, body: { item: this.out(after), already, message: `Marked handled: ${it.title}` } };
      }
      if (m[2] === 'unhandle') {
        if (it.state === 'not-important') return err(409, 'not_handled', 'That item was marked not important, not handled.');
        const already = it.state === 'open';
        const after = already ? it : this.change(it.id, { state: 'open', handledAt: null });
        return { status: 200, body: { item: this.out(after), already, message: already ? 'It is already on your list.' : `Back on your list: ${it.title}` } };
      }
      if (m[2] === 'not-important') return this.notImportant(it, body, now);
      return this.action(it, now);
    }
    if (method === 'POST' && (m = /^\/mail\/([^/]+)\/important$/.exec(path))) {
      const id = decodeURIComponent(m[1]);
      const header = this.h.mail.get(id) ?? this.own.get(id)?.header;
      if (!header) return err(404, 'not_found', 'No such message.');
      const addr = header.from.addr?.toLowerCase() ?? null;
      const name = header.from.name || addr || 'this sender';
      let rule: { id: string; match: string; value: string } | null = null;
      if (addr) {
        this.rules = this.rules.filter((r) => !(r.match === 'sender' && r.value === addr));
        const made: Rule = { id: `tr_${++this.n}`, match: 'sender', value: addr, verdict: 'important', createdAt: now };
        this.rules.push(made);
        rule = { id: made.id, match: made.match, value: made.value };
      }
      const was = this.skipped.filter((s) => s.mail.id === id || (addr && (s.mail.from.addr ?? '').toLowerCase() === addr));
      this.skipped = this.skipped.filter((s) => !was.includes(s));
      const itemId = `it_m${id.slice(2)}`;
      const cur = this.items.get(itemId);
      if (cur) this.change(itemId, { state: 'open', handledAt: null, gone: false });
      else {
        this.putItem({ id: itemId, source: header.listId ? 'newsletter' : 'mail', sourceRef: id, ts: header.receivedAt, from: name, fromAddress: addr, caution: null, title: header.subject,
          why: addr ? `You asked to see messages from ${addr}.` : `You marked this message from ${name} important.`, trust: 'untrusted', kind: was[0]?.kind ?? null,
          action: { kind: 'review-reply', label: 'Open' }, projectId: null, mailId: id });
      }
      return { status: 200, body: { item: this.out(this.items.get(itemId)!), rule, message: addr ? `Thanks — I'll show messages like this from ${name}.` : "Thanks — it's on your list." } };
    }
    if (method === 'POST' && (m = /^\/mail\/([^/]+)\/draft$/.exec(path))) {
      const id = decodeURIComponent(m[1]);
      const header = this.h.mail.get(id) ?? this.own.get(id)?.header;
      if (!header) return err(404, 'gone', 'That message is no longer in your mailbox.');
      const text = typeof (body as { body?: unknown } | null)?.body === 'string' ? String((body as { body: string }).body) : '';
      if (!text.trim()) return err(400, 'bad_body', 'Write the reply first.');
      if (text.length > 20_000) return err(400, 'too_long', 'That reply is too long to save as a draft.');
      const o = this.own.get(id);
      const to = o?.replyTo ?? header.from;
      const elsewhere = !!o?.replyTo && o.replyTo.addr !== header.from.addr;
      return { status: 201, body: { saved: true, sent: false, account: header.account, draftId: `dr_${++this.n}`, alreadySaved: false, message: 'Saved to your drafts. Nothing was sent.',
        to: [to], replyGoesElsewhere: elsewhere, replyNote: elsewhere ? `Your reply will go to ${to.addr} (not the sender).` : null } };
    }
    if (method === 'POST' && path === '/important/refresh') return { status: 200, body: { done: true, sorting: this.sorting(), message: 'Sorted. Your list is up to date.' } };
    if (method === 'DELETE' && (m = /^\/triage\/rules\/([^/]+)$/.exec(path))) {
      const r = this.rules.find((x) => x.id === decodeURIComponent(m![1]));
      if (!r) return err(404, 'not_found', 'No such rule.');
      this.rules = this.rules.filter((x) => x !== r);
      // the mail it decided is sorted as usual again: a skipped-by-you message goes back to its usual reason
      for (const s of this.skipped) if (s.byYou && this.matches(r, s.mail)) { s.byYou = false; s.reason = SKIP_REASON[s.kind] ?? 'A mailing list.'; }
      const what = r.match === 'kind' ? kindPlural(r.value) : r.match === 'list-id' ? `the list ${r.value}` : `messages from ${r.value}`;
      return { status: 200, body: { removed: { id: r.id, match: r.match, value: r.value, verdict: r.verdict }, message: `Undone. I'll sort ${what} as usual again.` } };
    }
    if (method === 'POST' && path === '/ask') return this.ask(body, now);
    return null;
  }

  private notImportant(it: ImportantItem, body: unknown, now: number): Resp {
    const b = (body ?? {}) as { scope?: unknown };
    const scope = (b.scope ?? 'sender') as string;
    if (!['sender', 'domain', 'kind'].includes(scope)) return err(400, 'bad_scope', 'scope must be sender, domain or kind.');
    const mail = it.mailId ? this.h.mail.get(it.mailId) ?? this.own.get(it.mailId)?.header : undefined;
    const addr = mail?.from.addr?.toLowerCase();
    if (!mail || !addr) {
      this.change(it.id, { state: 'not-important', handledAt: now });
      return { status: 200, body: { item: this.out(this.items.get(it.id)!), rule: null, message: "Got it. I've taken it off your list." } };
    }
    const dom = domainOf(addr), kind = this.headerKind(mail);
    if (scope === 'kind' && !kind) return err(400, 'kind_not_available', `I can only learn a kind from how a message is sent (a mailing list, a promotion, a receipt). Choose "messages from ${addr}" instead.`);
    if (scope === 'domain' && FREEMAIL.has(dom)) return err(400, 'freemail_domain', `${dom} is a free email service: skipping it would hide everyone who uses it, people you know included. Choose "messages from ${addr}" instead.`);
    const value = scope === 'kind' ? kind! : scope === 'domain' ? dom : addr;
    this.rules = this.rules.filter((r) => !(r.match === scope && r.value === value));
    const rule: Rule = { id: `tr_${++this.n}`, match: scope as Rule['match'], value, verdict: 'skip', createdAt: now };
    this.rules.push(rule);
    const effect = this.effect(rule);
    this.change(it.id, { state: 'not-important', handledAt: now });
    // the rule applies now: other open mail items it decides leave the list, and each is skipped "by you"
    for (const other of this.items.values()) {
      const om = other.mailId ? this.h.mail.get(other.mailId) ?? this.own.get(other.mailId)?.header : undefined;
      if (!om || other.gone || !this.matches(rule, om)) continue;
      if (other.id !== it.id && other.state === 'open') this.change(other.id, { gone: true });
      if (!this.skipped.some((s) => s.mail.id === om.id)) this.skipped.push({ mail: om, group: this.groupOf(om.receivedAt), kind: other.kind ?? 'other', reason: 'You marked messages like this not important.', byYou: true });
    }
    const others = effect.senders > 1 ? ` This will hide mail from ${effect.senders} senders (${effect.messages} messages now).` : '';
    const message = scope === 'kind' ? `Got it. I'll skip ${kindPlural(kind!)}.${others}` : scope === 'domain' ? `Got it. I'll skip messages from ${dom}.${others}` : `Got it. I'll skip messages like this from ${addr}.`;
    return { status: 200, body: { item: this.out(this.items.get(it.id)!), rule: { id: rule.id, match: rule.match, value: rule.value }, effect, message } };
  }

  private action(it: ImportantItem, now: number): Resp {
    if (it.state !== 'open') return err(409, 'not_open', 'That item is no longer on your list.');
    if (!it.action) return err(409, 'no_action', 'This item has nothing to do.');
    const kind = it.action.kind;
    if (kind === 'add-to-calendar') {
      const p = it.action.preview!;
      const [y, mo, d] = p.date!.split('-').map(Number);
      const hm = (s: string) => s.split(':').map(Number);
      const start = new Date(y, mo - 1, d, ...hm(p.start ?? '15:00') as [number, number]), end = new Date(y, mo - 1, d, ...hm(p.end ?? '16:00') as [number, number]);
      const draft: CalendarItem = { id: 'cd_bookfair', kind: 'draft', title: 'Book fair', start: start.toISOString(), end: end.toISOString(), allDay: false, location: p.place ?? null, provider: 'google',
        state: 'draft', confirmedAt: null, origin: 'helper-after-reading', originNote: AFTER_READING_NOTE };
      this.h.putCal(draft);
      const after = this.change(it.id, { action: null, why: 'On your calendar as a draft for Saturday. Confirm it when you see it.' });
      return { status: 201, body: { kind, done: true, message: DRAFT_ADDED, draft, item: this.out(after) } };
    }
    if (kind === 'remind') {
      const note = "I'll remind you Fri Nov 13 at 9am.";
      const after = this.change(it.id, { action: null, why: `${it.why ?? ''} ${note}`.trim() });
      return { status: 200, body: { kind, done: true, message: note, item: this.out(after) } };
    }
    if (kind === 'review-reply') return { status: 200, body: { kind, done: false, route: { view: 'mail', mailId: it.mailId ?? '' }, message: 'Open the message.', item: this.out(it) } };
    if (kind === 'draft-note') {
      return { status: 200, body: { kind, done: false, route: { view: 'ask', item: it.id, about: { kind: 'conflict', id: it.sourceRef ?? '' }, date: localDay(now) }, message: 'Ask your helper to draft the note.', item: this.out(it) } };
    }
    return { status: 200, body: { kind, done: false, route: kind === 'reconnect' ? { view: 'settings', section: 'connections', account: it.sourceRef ?? '' } : kind === 'open-job' ? { view: 'job' } : { view: 'approval', approvalId: it.sourceRef ?? '' }, message: 'Open it.', item: this.out(it) } };
  }

  /** An ask about one thing (the general Ask is the Projects slice's): kept under the item, answered a moment later. */
  private ask(body: unknown, now: number): Resp | null {
    const b = (body ?? {}) as { text?: unknown; about?: { kind?: unknown; id?: unknown } };
    if (!b.about || !['item', 'mail', 'conflict'].includes(String(b.about.kind))) return null; // the rest: ./fixtures-w4.ts
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!text) return err(400, 'bad_text', 'Write something to ask.');
    const about = this.aboutOf(`${String(b.about.kind)}:${String(b.about.id)}`);
    if (!about) return err(404, 'not_found', 'I can’t find what you asked about.');
    const item = about.kind === 'item' ? this.items.get(about.id) : undefined;
    const projectId = item?.projectId && this.h.projects.has(item.projectId) ? item.projectId : 'general';
    const project = this.h.projects.get(projectId)!;
    const n = ++this.n, askId = `ask_${n}`, turnId = `t_${projectId}_ask${n}`, runId = `run_ask${n}`;
    const route = { projectId, name: project.name, confidence: 'about' as const, alternatives: [] };
    this.h.putTurn(this.h.makeTurn({ id: turnId, projectId, ts: now, kind: 'running', message: `About ${about.label}: ${text}`, reply: '', about: { kind: about.kind, id: about.id }, tainted: true, runId }));
    const ask: Ask = { id: askId, createdAt: now, text, projectId, route, kind: 'answer', mode: null, about: { kind: about.kind, id: about.id }, files: [], source: 'typed', plan: null,
      state: 'running', choice: null, jobId: null, runId, turnId, answer: null, tainted: true, capUsd: null, parentId: null, focus: null, updatedSeq: this.h.seq() };
    this.asks.set(askId, ask);
    let qaId: string | null = null;
    if (item) { qaId = `qa_${n}`; this.change(item.id, { qa: [...item.qa, { id: qaId, q: text, a: null, ts: now, tainted: false }] }); }
    this.h.later(() => {
      const { text: answer, cross } = this.answer(about, text);
      const t = this.h.turns.get(turnId);
      if (t) this.h.putTurn({ ...t, kind: 'chat', reply: answer, provenance: cross ? [{ projectId: 'eventing', name: cross, n: 2 }] : [] });
      this.asks.set(askId, { ...this.asks.get(askId)!, state: 'answered', answer, updatedSeq: this.h.seq() });
      if (item && qaId) { const cur = this.items.get(item.id)!; this.change(item.id, { qa: cur.qa.map((x) => (x.id === qaId ? { ...x, a: answer, tainted: true } : x)) }); }
    }, this.h.answerDelay());
    return { status: 202, body: { askId, projectId, route, kind: 'answer', about, state: 'started', runId, turnId, budget: { maxSteps: 8, maxUsd: 0.05 }, tainted: true } };
  }

  private answer(about: { kind: string; id: string; label: string }, q: string): { text: string; cross?: string } {
    const t = q.toLowerCase();
    const it = about.kind === 'item' ? this.items.get(about.id) : undefined;
    const book = about.id === 'it_bookfair' || about.id === 'm_m2';
    if (/who else is going/.test(t) && book) return { text: 'Sam’s family is going — Sam mentioned it last week. You’re back from the Stable View schooling day by about 1pm, so 3pm works.', cross: 'Eventing' };
    if (/newsletter say|volunteer/.test(t)) return { text: 'They want volunteers for 30-minute shifts: reply to the PTA email or sign up at https://oakwoodpta.example/volunteer?ref=newsletter. I can draft a reply offering 3:30 — I won’t send it.' };
    if (/remind me/.test(t)) return { text: 'This is the example app, so no reminder was set. In the real app I’d remind you the day before at 9am.' };
    if (/why does this matter/.test(t)) return { text: it?.why ?? `It’s from ${about.label}.` };
    if (/last time/.test(t)) return { text: 'Nothing earlier from them in the last three months.' };
    return { text: `This is the example app, so nothing was really asked. In the real app your helper answers “${q.slice(0, 80)}” here, under ${about.label}.` };
  }
}

/** The fixture clock's day, for tests. */
export const FIXTURE_TODAY = localDay(FIXTURE_NOW);
