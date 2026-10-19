// The simulated world of the promise assessment (docs/assessment-2026-10-19.md): a mailbox, a
// calendar and a few web pages whose contents change at scripted virtual times. Every arm reaches
// it through the same tools; every draft, proposed event, email read and page opened is appended to
// a log with its virtual time, which the scorer reads.
//
// World file times are local ("2026-11-02 07:05") in the process time zone (TZ).
import { readFileSync, appendFileSync, existsSync } from 'node:fs';

export function localMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error(`bad world time: ${s}`);
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}
const pad = (n) => String(n).padStart(2, '0');
export function stamp(ms) {
  const d = new Date(ms);
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Gmail-style search (full assessment, 2026-10-19: the first version took every word as required, so
// "(bill OR due OR payment) newer_than:7d" found nothing and both arms were blind to the inbox).
// Words and quoted phrases (all must match unless joined by OR), OR / |, parentheses, -exclusion, and
// from: to: subject: (each may take a word, a "phrase" or a (group)), is:unread, newer_than: /
// older_than: (Nd, Nh, Nm, Ny), after: / before: (YYYY/MM/DD or YYYY-MM-DD). Operators Gmail has and this
// mailbox can't answer (in:, label:, category:, has:, filename:) match everything rather than nothing.
export function tokenize(q) {
  const toks = []; const s = String(q); let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')') { toks.push(c); i++; continue; }
    if (c === '"') { const j = s.indexOf('"', i + 1); toks.push({ phrase: s.slice(i + 1, j < 0 ? s.length : j) }); i = j < 0 ? s.length : j + 1; continue; }
    let j = i; while (j < s.length && !/[\s()"]/.test(s[j])) j++;
    let word = s.slice(i, j); i = j;
    // key:"phrase" or key:(group) — the value follows the colon directly
    if (/^-?[a-z_]+:$/i.test(word) && (s[i] === '"' || s[i] === '(')) { toks.push({ key: word.slice(0, -1) }); continue; }
    toks.push(word === 'OR' || word === '|' ? 'OR' : word === 'AND' ? 'AND' : { word });
  }
  return toks;
}
// As in Gmail, OR binds tighter than the implicit AND: `a b OR c d` is a AND (b OR c) AND d.
export function parseQuery(q) {
  const toks = tokenize(q); let p = 0;
  const andExpr = () => {
    const parts = [];
    while (p < toks.length && toks[p] !== ')') {
      if (toks[p] === 'AND' || toks[p] === 'OR') { p++; continue; } // a stray operator is skipped
      parts.push(orGroup());
    }
    return parts.length === 1 ? parts[0] : { and: parts };
  };
  const orGroup = () => { const parts = [unary()]; while (toks[p] === 'OR' && p + 1 < toks.length && toks[p + 1] !== ')') { p++; parts.push(unary()); } return parts.length === 1 ? parts[0] : { or: parts }; };
  const orExpr = andExpr;
  const unary = () => {
    const t = toks[p];
    if (t === '(') { p++; const e = orExpr(); if (toks[p] === ')') p++; return e; }
    p++;
    if (t && typeof t === 'object' && 'key' in t) { // key:"phrase" or key:(group)
      const neg = t.key.startsWith('-'); const key = t.key.replace(/^-/, '').toLowerCase();
      const v = unary(); const node = { field: key, inner: v };
      return neg ? { not: node } : node;
    }
    if (t && typeof t === 'object' && 'phrase' in t) return { text: t.phrase };
    const w = String(t?.word ?? '');
    if (w.startsWith('-') && w.length > 1) { p--; toks[p] = { word: w.slice(1) }; return { not: unary() }; }
    const m = /^([a-z_]+):(.*)$/i.exec(w);
    return m ? { op: m[1].toLowerCase(), value: m[2] } : { text: w };
  };
  return p < toks.length || toks.length ? orExpr() : { and: [] };
}
const DAY = 86_400_000;
const ageMs = (v) => { const m = /^(\d+)([dhmy])$/i.exec(v); if (!m) return null; const n = Number(m[1]); return n * ({ d: DAY, h: 3_600_000, m: 30 * DAY, y: 365 * DAY })[m[2].toLowerCase()]; };
const dayMs = (v) => { const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(v); return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null; };
export function matches(node, e, ctx, field) {
  const hay = (f) => (f === 'from' ? e.from : f === 'to' ? `${e.to ?? ''} ${ctx.me ?? ''}` : f === 'subject' ? e.subject : `${e.from} ${e.to ?? ''} ${e.subject} ${e.body}`).toLowerCase();
  if (node.and) return node.and.every((x) => matches(x, e, ctx, field));
  if (node.or) return node.or.some((x) => matches(x, e, ctx, field));
  if (node.not) return !matches(node.not, e, ctx, field);
  if (node.field) return ['from', 'to', 'subject'].includes(node.field) ? matches(node.inner, e, ctx, node.field) : true;
  if ('text' in node) return !node.text || hay(field).includes(node.text.toLowerCase());
  const { op, value } = node;
  if (op === 'from' || op === 'to' || op === 'subject') return hay(op).includes(value.toLowerCase().replace(/^"|"$/g, ''));
  if (op === 'is') return value.toLowerCase() === 'unread' ? !ctx.read.has(e.id) : value.toLowerCase() === 'read' ? ctx.read.has(e.id) : true;
  if (op === 'newer_than' || op === 'newer') { const a = ageMs(value); return a === null || ctx.now - e.ms <= a; }
  if (op === 'older_than' || op === 'older') { const a = ageMs(value); return a === null || ctx.now - e.ms > a; }
  if (op === 'after') { const t = dayMs(value); return t === null || e.ms >= t; }
  if (op === 'before') { const t = dayMs(value); return t === null || e.ms < t; }
  return true; // in:, label:, category:, has:, filename: … — nothing in this mailbox to narrow by
}

export function loadWorld(file) {
  const w = JSON.parse(readFileSync(file, 'utf8'));
  w.emails = (w.emails ?? []).map((e) => ({ ...e, ms: localMs(e.at) }));
  w.events = (w.events ?? []).map((e) => ({ ...e, ms: localMs(e.start), endMs: e.end ? localMs(e.end) : undefined, fromMs: e.visibleFrom ? localMs(e.visibleFrom) : -Infinity }));
  for (const url of Object.keys(w.pages ?? {})) w.pages[url] = w.pages[url].map((v) => ({ ...v, ms: localMs(v.from) })).sort((a, b) => a.ms - b.ms);
  return w;
}

export function makeWorld(file, logFile) {
  const w = loadWorld(file);
  const log = (tool, args, extra = {}) => {
    const vt = Date.now();
    if (logFile) appendFileSync(logFile, JSON.stringify({ vt, vts: stamp(vt), tool, args, ...extra }) + '\n');
  };
  const readIds = () => {
    if (!logFile || !existsSync(logFile)) return new Set();
    const ids = new Set();
    for (const line of readFileSync(logFile, 'utf8').split('\n')) {
      if (!line) continue;
      try { const r = JSON.parse(line); if (r.tool === 'read_email' && r.args?.id) ids.add(String(r.args.id)); } catch { /* */ }
    }
    return ids;
  };
  const arrived = () => w.emails.filter((e) => e.ms <= Date.now()).sort((a, b) => b.ms - a.ms);
  const header = (e, unread) => `id: ${e.id}${unread ? ' (unread)' : ''} | ${stamp(e.ms)} | From: ${e.from} | Subject: ${e.subject}`;

  const tools = {
    search_email: {
      readOnly: true,
      description: 'Search the mailbox (newest first) with Gmail search syntax: words, "quoted phrases", OR, parentheses, -exclusions, from:, to:, subject:, is:unread, newer_than:/older_than: (e.g. 7d, 12h), after:/before: (YYYY/MM/DD). An empty query lists the latest messages.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'number', description: 'max results, default 10' } } },
      run(args) {
        const max = Math.min(Math.max(1, Number(args.max) || 10), 25);
        const read = readIds();
        const tree = parseQuery(String(args.query ?? ''));
        const ctx = { read, now: Date.now(), me: w.persona?.email };
        const list = arrived().filter((e) => matches(tree, e, ctx));
        log('search_email', args, { hits: list.length });
        if (!list.length) return 'No messages match.';
        return list.slice(0, max).map((e) => `${header(e, !read.has(e.id))}\n  ${e.body.replace(/\s+/g, ' ').slice(0, 140)}`).join('\n');
      },
    },
    read_email: {
      readOnly: true,
      description: 'Read one email in full by its id (from search_email).',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run(args) {
        const e = arrived().find((x) => x.id === String(args.id ?? '').trim());
        log('read_email', args, { found: !!e });
        if (!e) return `No message with id ${args.id}.`;
        return `${header(e, false)}\nTo: ${e.to ?? w.persona?.email ?? ''}\n\n${e.body}`;
      },
    },
    draft_email: {
      readOnly: false,
      description: 'Create a draft email in the Drafts folder. It is NOT sent; the person reviews and sends drafts themselves.',
      parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, cc: { type: 'string' } }, required: ['to', 'body'] },
      run(args) {
        const id = `d${Date.now().toString(36)}`;
        log('draft_email', args, { id });
        return `Draft saved in Drafts (id ${id}) to ${args.to}. It has NOT been sent.`;
      },
    },
    list_events: {
      readOnly: true,
      description: 'List calendar events between two dates (YYYY-MM-DD, inclusive). Defaults to today through the next 14 days.',
      parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } },
      run(args) {
        const day = (s, endOfDay) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? '').trim()); return m ? new Date(+m[1], +m[2] - 1, +m[3], endOfDay ? 23 : 0, endOfDay ? 59 : 0).getTime() : null; };
        const now = new Date(); const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const from = day(args.from, false) ?? startToday;
        const to = day(args.to, true) ?? startToday + 15 * 86_400_000;
        const list = w.events.filter((e) => e.fromMs <= Date.now() && e.ms >= from && e.ms <= to).sort((a, b) => a.ms - b.ms);
        log('list_events', args, { hits: list.length });
        return list.length ? list.map((e) => `${stamp(e.ms)}${e.endMs ? `–${stamp(e.endMs).slice(-5)}` : ''} | ${e.title}${e.where ? ` | ${e.where}` : ''}`).join('\n') : 'No events in that range.';
      },
    },
    propose_event: {
      readOnly: false,
      description: 'Add a [Proposed] event to the calendar (no invites are sent). start/end are local "YYYY-MM-DD HH:MM".',
      parameters: { type: 'object', properties: { title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, notes: { type: 'string' } }, required: ['title', 'start'] },
      run(args) {
        log('propose_event', args);
        return `Added "[Proposed] ${args.title}" at ${args.start}. No invites were sent.`;
      },
    },
    open_page: {
      readOnly: false, // like MWA's own http fetch: a request leaves the machine and can carry data out
      description: 'Open a web page by URL and return its text.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      run(args) {
        const url = String(args.url ?? '').trim().replace(/\/$/, '');
        const versions = w.pages?.[url] ?? w.pages?.[`${url}/`];
        const live = versions?.filter((v) => v.ms <= Date.now()).pop();
        log('open_page', { url }, { found: !!live });
        return live ? live.text : `404 Not Found: ${url}`;
      },
    },
  };
  return { world: w, tools };
}

export const MODES = { gmail: ['search_email', 'read_email', 'draft_email'], calendar: ['list_events', 'propose_event'], web: ['open_page'] };
