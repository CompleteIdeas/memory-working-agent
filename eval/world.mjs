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
      description: 'Search the mailbox (newest first). Supports plain words plus from:, subject:, is:unread, newer_than:Nd or newer_than:Nh. An empty query lists the latest messages.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'number', description: 'max results, default 10' } } },
      run(args) {
        const q = String(args.query ?? '').toLowerCase();
        const max = Math.min(Math.max(1, Number(args.max) || 10), 25);
        const read = readIds();
        let list = arrived();
        const words = [];
        for (const tok of q.split(/\s+/).filter(Boolean)) {
          let m;
          if ((m = /^newer_than:(\d+)([dh])$/.exec(tok))) { const ms = Number(m[1]) * (m[2] === 'd' ? 86_400_000 : 3_600_000); list = list.filter((e) => Date.now() - e.ms <= ms); }
          else if (tok === 'is:unread') list = list.filter((e) => !read.has(e.id));
          else if ((m = /^from:(.+)$/.exec(tok))) list = list.filter((e) => e.from.toLowerCase().includes(m[1]));
          else if ((m = /^subject:(.+)$/.exec(tok))) list = list.filter((e) => e.subject.toLowerCase().includes(m[1]));
          else if (!/^(in|label):/.test(tok)) words.push(tok);
        }
        if (words.length) list = list.filter((e) => words.every((x) => `${e.from} ${e.subject} ${e.body}`.toLowerCase().includes(x)));
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
