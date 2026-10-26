/**
 * A fake Google Calendar API v3 + OAuth token endpoint, over real HTTP (v2 build, slice A7 tests). Enough of the
 * real behaviour to exercise the sync and Confirm end to end through googleapis and google-auth-library:
 *   - events.list: singleEvents instances in [timeMin, timeMax), paged (pageSize), nextSyncToken on the last page;
 *     with a syncToken, only what changed since (cancelled ones included), timeMin/timeMax refused beside it (400),
 *     an invalidated token → 410 fullSyncRequired;
 *   - events.insert (counted; sendUpdates recorded; a repeated id → 409 duplicate) and events.get;
 *   - POST /token: refresh, or invalid_grant when told to;
 *   - Bearer check: anything but the current access token → 401.
 * Not modelled (so not verified here): recurrence expansion from an RRULE (instances are stored as Google returns
 * them), attendees beyond `self`, quotas, ETag preconditions.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';

export interface GEvent {
  id: string; status?: string; summary?: string; location?: string; etag?: string;
  start: { date?: string; dateTime?: string; timeZone?: string }; end: { date?: string; dateTime?: string; timeZone?: string };
  recurringEventId?: string; attendees?: { email?: string; self?: boolean; responseStatus?: string }[];
  description?: string; extendedProperties?: unknown;
}

export class FakeGoogleCalendar {
  server!: Server;
  base = '';
  timeZone = 'America/New_York';
  pageSize = 250;
  accessToken = 'good-google-token';
  refreshFails: 'invalid_grant' | null = null;
  /** every request, for assertions */
  requests: { method: string; path: string; query: Record<string, string>; auth?: string; body?: any }[] = [];
  inserts: { query: Record<string, string>; body: any }[] = [];
  private events = new Map<string, GEvent & { _seq: number }>();
  private seq = 0;
  private validFrom = 0; // tokens below this are invalid (410)
  private pages = new Map<string, { items: GEvent[]; next: number; sync?: string }>();

  async start(): Promise<this> {
    this.server = createServer((req, res) => { void this.handle(req).then(({ status, body }) => {
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
    }); });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this;
  }
  close(): Promise<void> { return new Promise((r) => this.server.close(() => r())); }

  put(e: GEvent): void { this.seq++; this.events.set(e.id, { etag: `"e${this.seq}"`, status: 'confirmed', ...e, _seq: this.seq }); }
  cancel(id: string): void { const e = this.events.get(id); if (e) { this.seq++; this.events.set(id, { ...e, status: 'cancelled', _seq: this.seq }); } }
  /** every sync token handed out so far stops working (410 on next use) */
  invalidateTokens(): void { this.validFrom = this.seq + 1; this.seq++; }
  get(id: string): GEvent | undefined { return this.events.get(id); }
  /** forget every event, request and insert (a fresh calendar) */
  clear(): void { this.events.clear(); this.requests = []; this.inserts = []; this.pages.clear(); this.refreshFails = null; }

  private async handle(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const url = new URL(req.url ?? '/', this.base);
    const query = Object.fromEntries(url.searchParams);
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? (() => { try { return JSON.parse(raw); } catch { return Object.fromEntries(new URLSearchParams(raw)); } })() : undefined;
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, query, auth: req.headers.authorization, body });

    if (url.pathname === '/token' && req.method === 'POST') {
      if (this.refreshFails) return { status: 400, body: { error: this.refreshFails, error_description: 'Token has been expired or revoked.' } };
      return { status: 200, body: { access_token: this.accessToken, expires_in: 3599, token_type: 'Bearer' } };
    }
    if (req.headers.authorization !== `Bearer ${this.accessToken}`) {
      return { status: 401, body: { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } } };
    }
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return { status: 404, body: { error: { code: 404, message: 'Not Found' } } };
    const eventId = m[2] ? decodeURIComponent(m[2]) : null;

    if (req.method === 'POST' && !eventId) {
      this.inserts.push({ query, body });
      const id = body?.id ?? `gen${this.seq + 1}`;
      if (this.events.has(id)) return { status: 409, body: { error: { code: 409, message: 'The requested identifier already exists.', errors: [{ reason: 'duplicate' }] } } };
      this.put({ ...body, id });
      return { status: 200, body: this.out(this.events.get(id)!) };
    }
    if (req.method === 'GET' && eventId) {
      const e = this.events.get(eventId);
      return e ? { status: 200, body: this.out(e) } : { status: 404, body: { error: { code: 404, message: 'Not Found' } } };
    }
    if (req.method !== 'GET') return { status: 405, body: { error: { code: 405, message: 'no' } } };

    // events.list
    if (query.pageToken) {
      const p = this.pages.get(query.pageToken);
      if (!p) return { status: 400, body: { error: { code: 400, message: 'Invalid page token' } } };
      return { status: 200, body: this.page(p) };
    }
    let items: (GEvent & { _seq: number })[];
    let sync: string;
    if (query.syncToken) {
      if (query.timeMin || query.timeMax) return { status: 400, body: { error: { code: 400, message: 'timeMin/timeMax may not be used with syncToken' } } };
      const n = Number(/^tok-(\d+)$/.exec(query.syncToken)?.[1] ?? NaN);
      if (!Number.isFinite(n) || n < this.validFrom) {
        return { status: 410, body: { error: { code: 410, message: 'Sync token is no longer valid, a full sync is required.', errors: [{ domain: 'calendar', reason: 'fullSyncRequired' }] } } };
      }
      items = [...this.events.values()].filter((e) => e._seq > n);
    } else {
      const min = query.timeMin ? Date.parse(query.timeMin) : -Infinity, max = query.timeMax ? Date.parse(query.timeMax) : Infinity;
      items = [...this.events.values()].filter((e) => {
        if (e.status === 'cancelled' && query.showDeleted !== 'true') return false;
        const s = e.start.dateTime ? Date.parse(e.start.dateTime) : Date.parse(`${e.start.date}T00:00:00Z`);
        const en = e.end.dateTime ? Date.parse(e.end.dateTime) : Date.parse(`${e.end.date}T00:00:00Z`) + 14 * 3_600_000; // dates: generous
        return s < max && en > min;
      });
    }
    sync = `tok-${this.seq}`;
    items.sort((a, b) => a._seq - b._seq);
    const key = `pg${this.pages.size + 1}`;
    const p = { items: items.map((e) => this.out(e)), next: 0, sync };
    this.pages.set(key, p);
    return { status: 200, body: this.page(p, key) };
  }

  private page(p: { items: GEvent[]; next: number; sync?: string }, key?: string) {
    const k = key ?? [...this.pages.entries()].find(([, v]) => v === p)![0];
    const slice = p.items.slice(p.next, p.next + this.pageSize);
    p.next += this.pageSize;
    const more = p.next < p.items.length;
    return { kind: 'calendar#events', timeZone: this.timeZone, items: slice, ...(more ? { nextPageToken: k } : { nextSyncToken: p.sync }) };
  }
  private out(e: GEvent & { _seq?: number }): GEvent {
    const { _seq, ...rest } = e as GEvent & { _seq?: number };
    void _seq;
    return rest;
  }
}
