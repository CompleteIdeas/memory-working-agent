/**
 * A fake Microsoft Graph calendar + token endpoint, over real HTTP (v2 build, slice A7 tests):
 *   - GET /v1.0/me/calendarView/delta?startDateTime&endDateTime: instances in the window, paged by @odata.nextLink
 *     (absolute URLs, as Graph sends), the last page carrying @odata.deltaLink;
 *   - GET <deltaLink>: what changed since — changed events in full, deletions as {"@removed": …, id};
 *     an invalidated delta token → 410 (SyncStateNotFound);
 *   - times in UTC when asked with Prefer: outlook.timezone="UTC" (recorded so a test can check it was asked);
 *   - POST /v1.0/me/events (counted; a repeated transactionId returns the event already made);
 *   - POST /auth/token: refresh, or invalid_grant when told to;
 *   - Bearer check → 401.
 * Not modelled: how real Graph represents all-day events under outlook.timezone, change keys, throttling (429).
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';

export interface OEvent {
  id: string; subject?: string; isAllDay?: boolean; isCancelled?: boolean; type?: string; seriesMasterId?: string | null;
  start: { dateTime: string; timeZone: string }; end: { dateTime: string; timeZone: string };
  location?: { displayName?: string }; originalStartTimeZone?: string; responseStatus?: { response?: string }; changeKey?: string;
  transactionId?: string; attendees?: unknown[]; body?: unknown; showAs?: string;
}

export class FakeGraphCalendar {
  server!: Server;
  base = '';
  pageSize = 100;
  accessToken = 'good-graph-token';
  refreshFails: 'invalid_grant' | null = null;
  requests: { method: string; path: string; search: string; auth?: string; prefer?: string; body?: any }[] = [];
  inserts: any[] = [];
  private events = new Map<string, OEvent & { _seq: number; _removed?: boolean }>();
  private seq = 0;
  private validFrom = 0;
  private skips = new Map<string, { items: unknown[]; next: number; delta: string }>();

  async start(): Promise<this> {
    this.server = createServer((req, res) => { void this.handle(req).then(({ status, body }) => {
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
    }); });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this;
  }
  close(): Promise<void> { return new Promise((r) => this.server.close(() => r())); }

  put(e: OEvent): void { this.seq++; this.events.set(e.id, { type: 'singleInstance', changeKey: `ck${this.seq}`, ...e, _seq: this.seq }); }
  remove(id: string): void { const e = this.events.get(id); if (e) { this.seq++; this.events.set(id, { ...e, _removed: true, _seq: this.seq }); } }
  invalidateTokens(): void { this.seq++; this.validFrom = this.seq; }
  /** forget every event, request and insert (a fresh calendar) */
  clear(): void { this.events.clear(); this.requests = []; this.inserts = []; this.skips.clear(); this.refreshFails = null; }

  private async handle(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const url = new URL(req.url ?? '/', this.base);
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? (() => { try { return JSON.parse(raw); } catch { return Object.fromEntries(new URLSearchParams(raw)); } })() : undefined;
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, search: url.search, auth: req.headers.authorization, prefer: req.headers.prefer as string | undefined, body });

    if (url.pathname === '/auth/token' && req.method === 'POST') {
      if (this.refreshFails) return { status: 400, body: { error: this.refreshFails, error_description: 'AADSTS70000: The provided grant has expired due to it being revoked.' } };
      return { status: 200, body: { access_token: this.accessToken, refresh_token: 'r2', expires_in: 3600 } };
    }
    if (req.headers.authorization !== `Bearer ${this.accessToken}`) return { status: 401, body: { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired or is not yet valid.' } } };

    if (url.pathname === '/v1.0/me/events' && req.method === 'POST') {
      this.inserts.push(body);
      const dup = body?.transactionId ? [...this.events.values()].find((e) => e.transactionId === body.transactionId) : undefined;
      if (dup) return { status: 201, body: this.out(dup) };
      const id = `AAMk-${this.seq + 1}`;
      this.put({ ...body, id });
      return { status: 201, body: this.out(this.events.get(id)!) };
    }
    if (url.pathname !== '/v1.0/me/calendarView/delta' || req.method !== 'GET') return { status: 404, body: { error: { code: 'ResourceNotFound', message: 'no' } } };

    const skip = url.searchParams.get('$skiptoken');
    if (skip) {
      const p = this.skips.get(skip);
      return p ? { status: 200, body: this.page(p, skip) } : { status: 400, body: { error: { code: 'BadRequest', message: 'bad skiptoken' } } };
    }
    const delta = url.searchParams.get('$deltatoken');
    let items: unknown[];
    if (delta) {
      const [n, from, to] = delta.split('~');
      if (Number(n) < this.validFrom) return { status: 410, body: { error: { code: 'SyncStateNotFound', message: 'The sync state generation is not found.' } } };
      items = [...this.events.values()].filter((e) => e._seq > Number(n)).sort((a, b) => a._seq - b._seq)
        .map((e) => (e._removed ? { '@removed': { reason: 'deleted' }, id: e.id } : this.inWindow(e, from, to) ? this.out(e) : { '@removed': { reason: 'deleted' }, id: e.id }));
      return { status: 200, body: this.page({ items, next: 0, delta: `${this.seq}~${from}~${to}` }) };
    }
    const from = url.searchParams.get('startDateTime') ?? '', to = url.searchParams.get('endDateTime') ?? '';
    if (!from || !to) return { status: 400, body: { error: { code: 'ErrorInvalidParameter', message: 'startDateTime and endDateTime are required' } } };
    items = [...this.events.values()].filter((e) => !e._removed && this.inWindow(e, from, to)).sort((a, b) => a._seq - b._seq).map((e) => this.out(e));
    return { status: 200, body: this.page({ items, next: 0, delta: `${this.seq}~${from}~${to}` }) };
  }

  private inWindow(e: OEvent, from: string, to: string): boolean {
    const s = Date.parse(`${e.start.dateTime.slice(0, 19)}Z`), en = Date.parse(`${e.end.dateTime.slice(0, 19)}Z`);
    return s < Date.parse(to) && en > Date.parse(from);
  }
  private page(p: { items: unknown[]; next: number; delta: string }, key?: string) {
    const k = key ?? `s${this.skips.size + 1}`;
    if (!key) this.skips.set(k, p);
    const slice = p.items.slice(p.next, p.next + this.pageSize);
    p.next += this.pageSize;
    const more = p.next < p.items.length;
    return {
      '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#Collection(event)', value: slice,
      ...(more ? { '@odata.nextLink': `${this.base}/v1.0/me/calendarView/delta?$skiptoken=${k}` } : { '@odata.deltaLink': `${this.base}/v1.0/me/calendarView/delta?$deltatoken=${encodeURIComponent(p.delta)}` }),
    };
  }
  private out(e: OEvent & { _seq?: number; _removed?: boolean }): OEvent {
    const { _seq, _removed, ...rest } = e;
    void _seq; void _removed;
    return rest;
  }
}
