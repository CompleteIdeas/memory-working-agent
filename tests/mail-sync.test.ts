// v2 build, slice A8: mail header sync against FAKE providers — Gmail REST and Microsoft Graph as real HTTP servers
// driven by the real googleapis client and the real connectors/microsoft.ts graph(); IMAP at imapflow's interface.
//
// Why IMAP is faked at the interface and not as an in-process IMAP server: the wire protocol is imapflow's job (a
// mature, widely used client); what A8 adds is the logic on top — UIDVALIDITY, UID SEARCH SINCE, which UIDs get
// headers and which only flags, read-only opens, APPEND to the Drafts mailbox. A minimal IMAP server would mostly
// test itself (its own ENVELOPE/BODYSTRUCTURE encoder) and still not be Gmail's. The fake records every open, fetch
// query, append and logout, so the logic is checked exactly.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { google } from 'googleapis';
import { appDb, resetAppDb } from '../src/v2/db.js';
import { getSyncState, listMail, mailId } from '../src/v2/mail.js';
import { setMailProviders, syncMail, mailAccounts } from '../src/sync/mail.js';
import { gmailProvider } from '../src/sync/gmail.js';
import { imapProvider } from '../src/sync/imap.js';
import { outlookProvider } from '../src/sync/outlook-mail.js';
import { isReauthError } from '../src/sync/mail-types.js';
import { FakeGmail, FakeGraph, FakeImap } from './fixtures/fake-mail.js';

const DAY = 86_400_000;
const now = Date.now();
const rows = (account?: string) => (appDb().prepare(`SELECT * FROM mail_headers ${account ? 'WHERE account = ?' : ''} ORDER BY received_at DESC`).all(...(account ? [account] : [])) as any[]);
const eventCount = () => (appDb().prepare(`SELECT COUNT(*) n FROM events WHERE entity = 'mail'`).get() as { n: number }).n;

let gm: FakeGmail, gr: FakeGraph, tmp: string;
const envBefore = { ...process.env };
beforeAll(async () => {
  gm = await new FakeGmail().start();
  gr = await new FakeGraph().start();
  tmp = mkdtempSync(join(tmpdir(), 'mwa-a8-'));
  writeFileSync(join(tmp, 'ms.json'), JSON.stringify({ access_token: 'fake-graph-token', expires_at: Date.now() + 3_600_000, scope: 'Mail.ReadWrite' }));
  Object.assign(process.env, { MWA_GRAPH_BASE: gr.base, MWA_MS_TOKEN: join(tmp, 'ms.json'), MICROSOFT_CLIENT_ID: 'test-client' });
});
afterAll(() => {
  gm.close(); gr.close();
  for (const k of ['MWA_GRAPH_BASE', 'MWA_MS_TOKEN', 'MICROSOFT_CLIENT_ID']) { if (envBefore[k] === undefined) delete process.env[k]; else process.env[k] = envBefore[k]; }
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => { resetAppDb(':memory:'); setMailProviders(null); });

/** A Google OAuth client whose token endpoint is the fake (so invalid_grant comes from the real library path).
 *  Native fetch: the shared node_modules this worktree runs on lacks fetch-blob/streams.cjs, which gaxios's default
 *  (node-fetch) needs; fetchImplementation is gaxios's documented switch. */
function gAuth(o: { expired?: boolean } = {}) {
  const a = new google.auth.OAuth2({ clientId: 'cid', clientSecret: 'sec', endpoints: { oauth2TokenUrl: gm.tokenUrl }, transporterOptions: { fetchImplementation: fetch } } as never);
  a.setCredentials({ access_token: 'fake-gmail-token', refresh_token: 'refresh-1', expiry_date: o.expired ? Date.now() - 60_000 : Date.now() + 3_600_000 });
  return a;
}

describe('Gmail (REST: history.list)', () => {
  beforeEach(() => {
    gm.msgs.clear(); gm.history = []; gm.drafts = []; gm.requests = []; gm.oldestHistory = 0; gm.refuseToken = false; gm.sendCalls = 0;
  });
  it('first sync takes the 14-day INBOX window (paged), with list headers and category labels; later syncs follow history', async () => {
    gm.add({ id: 'g1', from: 'Coach Ellen <ellen@willowcreekfarm.example>', subject: 'Saturday schooling — are you in?', at: now - 3_600_000 });
    gm.add({ id: 'g2', from: '"Stable View" <entries@stableview.example>', subject: 'Entry reminder', at: now - 2 * DAY,
      labelIds: ['INBOX', 'CATEGORY_UPDATES'], headers: { From: 'Stable View <entries@stableview.example>', Subject: 'Entry reminder', 'List-Id': 'Stable View News <news.stableview.example>', 'List-Unsubscribe': '<https://stableview.example/u>', 'Message-ID': '<g2@x>' } });
    gm.add({ id: 'g3', from: 'news@thebatch.example', subject: 'This week in AI', at: now - 3 * DAY, labelIds: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'], snippet: 'x'.repeat(500) });
    gm.add({ id: 'g4', from: 'a@b.example', subject: 'Four', at: now - 4 * DAY });
    gm.add({ id: 'g5', from: 'c@d.example', subject: 'Archived', at: now - DAY, labelIds: ['UNREAD'] }); // not in the inbox
    gm.add({ id: 'g6', from: 'old@x.example', subject: 'Old', at: now - 20 * DAY }); // outside the window
    setMailProviders(() => [gmailProvider({ auth: gAuth(), rootUrl: gm.base })]);

    const r1 = await syncMail();
    expect(r1.accounts).toEqual([expect.objectContaining({ account: 'gmail', ok: true, full: true })]);
    expect(rows('gmail').map((r) => r.provider_id)).toEqual(['g1', 'g2', 'g3', 'g4']);
    expect(gm.requests.filter((x) => x === 'GET /gmail/v1/users/me/messages').length).toBeGreaterThan(1); // paged
    const g2 = rows().find((r) => r.provider_id === 'g2');
    expect(g2).toMatchObject({ from_name: 'Stable View', from_addr: 'entries@stableview.example', list_id: 'news.stableview.example', has_unsub: 1, unread: 0 });
    expect(JSON.parse(g2.labels)).toContain('CATEGORY_UPDATES');
    const g3 = rows().find((r) => r.provider_id === 'g3');
    expect(JSON.parse(g3.labels)).toContain('CATEGORY_PROMOTIONS');
    expect(g3.snippet.length).toBeLessThanOrEqual(200);
    expect(rows().find((r) => r.provider_id === 'g1')).toMatchObject({ unread: 1, from_name: 'Coach Ellen', thread_id: 't-g1' });
    expect(getSyncState('gmail')).toMatchObject({ cursor: String(gm.historyId), needs_reconnect: 0, last_error: null });

    // nothing changed → no new events (a sync every 15 minutes must not flood the stream)
    const before = eventCount();
    gm.requests = [];
    await syncMail();
    expect(eventCount()).toBe(before);
    expect(gm.requests).toContain('GET /gmail/v1/users/me/history');
    expect(gm.requests).not.toContain('GET /gmail/v1/users/me/messages'); // incremental: no window listing

    // incremental: a new message, one read, one archived, one deleted
    gm.add({ id: 'g7', from: 'Dana Lee <dana@example.com>', subject: 'Board call → Wednesday 2pm', at: now - 60_000 });
    gm.markRead('g1'); gm.archive('g4'); gm.remove('g3');
    const r3 = await syncMail();
    expect(r3.accounts[0]).toMatchObject({ ok: true, full: false, result: { added: 1, changed: 1, removed: 2 } });
    expect(rows('gmail').map((r) => r.provider_id)).toEqual(['g7', 'g1', 'g2']);
    expect(rows().find((r) => r.provider_id === 'g1').unread).toBe(0);
    expect(getSyncState('gmail')!.cursor).toBe(String(gm.historyId));
  });

  it('a history gap (404 on an expired historyId) resyncs the whole window', async () => {
    gm.add({ id: 'h1', from: 'a@x.example', subject: 'One', at: now - DAY });
    gm.add({ id: 'h2', from: 'b@x.example', subject: 'Two', at: now - DAY });
    setMailProviders(() => [gmailProvider({ auth: gAuth(), rootUrl: gm.base })]);
    await syncMail();
    // while away: one deleted, one added — and the history before now is no longer kept
    gm.msgs.delete('h1');
    gm.add({ id: 'h3', from: 'c@x.example', subject: 'Three', at: now - 1000 });
    gm.oldestHistory = gm.historyId + 1;
    gm.requests = [];
    const r = await syncMail();
    expect(r.accounts[0]).toMatchObject({ ok: true, full: true });
    expect(gm.requests).toContain('GET /gmail/v1/users/me/history'); // tried, got 404
    expect(gm.requests).toContain('GET /gmail/v1/users/me/messages'); // then listed the window
    expect(rows('gmail').map((x) => x.provider_id).sort()).toEqual(['h2', 'h3']);
  });

  it('invalid_grant marks the account needs_reconnect; other accounts carry on; a good sign-in clears it', async () => {
    gm.add({ id: 'k1', from: 'a@x.example', subject: 'One', at: now - DAY });
    gm.refuseToken = true;
    gr.msgs.clear(); gr.changes = []; gr.add({ id: 'o1', from: 'Sam', addr: 'sam@example.com', subject: 'Lunch?', at: now - DAY });
    setMailProviders(() => [gmailProvider({ auth: gAuth({ expired: true }), rootUrl: gm.base }), outlookProvider()]);
    const r = await syncMail();
    expect(r.accounts).toEqual([
      expect.objectContaining({ account: 'gmail', ok: false, needsReconnect: true }),
      expect.objectContaining({ account: 'outlook', ok: true }),
    ]);
    expect(getSyncState('gmail')).toMatchObject({ needs_reconnect: 1, last_error: 'Gmail needs to be reconnected.' });
    expect(mailAccounts().find((a) => a.account === 'gmail')!.needsReconnect).toBe(true);
    expect(rows('outlook')).toHaveLength(1);
    expect(gm.requests).toContain('POST /token'); // the real refresh path was taken

    gm.refuseToken = false;
    setMailProviders(() => [gmailProvider({ auth: gAuth(), rootUrl: gm.base })]);
    await syncMail();
    expect(getSyncState('gmail')).toMatchObject({ needs_reconnect: 0, last_error: null });
    expect(rows('gmail')).toHaveLength(1);
  });

  it('classifies sign-in failures (and only those) as needing a reconnect', () => {
    expect(isReauthError(Object.assign(new Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant' } } }))).toBe(true);
    expect(isReauthError(new Error('Graph 401: {"error":{"code":"InvalidAuthenticationToken"}}'))).toBe(true);
    expect(isReauthError(new Error('token refresh failed: 400'))).toBe(true);
    expect(isReauthError(Object.assign(new Error('Command failed'), { authenticationFailed: true }))).toBe(true);
    expect(isReauthError(new Error('Graph 503: busy'))).toBe(false);
    expect(isReauthError(Object.assign(new Error('rate'), { response: { status: 429 } }))).toBe(false);
  });
});

describe('IMAP (UIDVALIDITY + UID SEARCH SINCE)', () => {
  it('first sync fetches headers in the window; later ones fetch headers only for new UIDs, flags for the rest', async () => {
    const im = new FakeImap();
    im.add({ from: 'Coach Ellen', addr: 'ellen@willowcreekfarm.example', subject: 'Saturday?', at: now - DAY });
    im.add({ from: 'Stable View', addr: 'entries@stableview.example', subject: 'Entries close Friday', at: now - 2 * DAY, listId: '<news.stableview.example>', unsub: true, seen: true });
    im.add({ from: 'Old', addr: 'old@x.example', subject: 'Old', at: now - 30 * DAY });
    setMailProviders(() => [imapProvider({ connect: im.connect, user: 'robert@gmail.example' })]);
    const r1 = await syncMail();
    expect(r1.accounts[0]).toMatchObject({ ok: true, full: true });
    const got = rows('imap');
    expect(got.map((r) => r.provider_id)).toEqual(['7.1', '7.2']);
    expect(got[1]).toMatchObject({ list_id: 'news.stableview.example', has_unsub: 1, unread: 0, provider: 'imap', snippet: null });
    expect(got[0]).toMatchObject({ unread: 1, from_name: 'Coach Ellen', thread_id: 'thr-1' });
    expect(getSyncState('imap')!.cursor).toBe('7:2');

    im.add({ from: 'Dana', addr: 'dana@example.com', subject: 'Top 3?', at: now - 1000 });
    im.msgs[0].flags.add('\\Seen');
    im.msgs.splice(1, 1); // expunged / moved out of INBOX
    const r2 = await syncMail();
    expect(r2.accounts[0]).toMatchObject({ ok: true, full: false, result: { added: 1, changed: 1, removed: 1 } });
    expect(rows('imap').map((r) => [r.provider_id, r.unread])).toEqual([['7.4', 1], ['7.1', 0]]);
    expect(getSyncState('imap')!.cursor).toBe('7:4');
    // every open was read-only (EXAMINE: syncing can never mark mail read), and every connection logged out
    expect(im.opens.every((o) => o.path === 'INBOX' && o.readOnly)).toBe(true);
    expect(im.logouts).toBe(im.connections);
  });

  it('a UIDVALIDITY change resyncs the whole window under the new ids', async () => {
    const im = new FakeImap();
    im.add({ from: 'A', addr: 'a@x.example', subject: 'One', at: now - DAY });
    im.add({ from: 'B', addr: 'b@x.example', subject: 'Two', at: now - DAY });
    setMailProviders(() => [imapProvider({ connect: im.connect })]);
    await syncMail();
    expect(rows('imap').map((r) => r.provider_id).sort()).toEqual(['7.1', '7.2']);
    im.resetUidValidity();
    const r = await syncMail();
    expect(r.accounts[0]).toMatchObject({ ok: true, full: true, result: { added: 2, removed: 2 } });
    expect(rows('imap').map((r) => r.provider_id).sort()).toEqual(['8.3', '8.4']);
    expect(getSyncState('imap')!.cursor).toBe('8:4');
  });

  it('a refused login marks needs_reconnect', async () => {
    const im = new FakeImap(); im.failLogin = true;
    setMailProviders(() => [imapProvider({ connect: im.connect })]);
    const r = await syncMail();
    expect(r.accounts[0]).toMatchObject({ ok: false, needsReconnect: true });
    expect(getSyncState('imap')!.needs_reconnect).toBe(1);
  });
});

describe('Outlook (Graph messages delta)', () => {
  beforeEach(() => { gr.msgs.clear(); gr.changes = []; gr.seq = 0; gr.expiredBefore = 0; gr.revoked = false; gr.requests = []; gr.drafts = []; gr.sendCalls = 0; });
  it('first sync pages to a deltaLink; later syncs apply additions, read changes and removals from it', async () => {
    for (let i = 1; i <= 5; i++) gr.add({ id: `o${i}`, from: `Sender ${i}`, addr: `s${i}@example.com`, subject: `Subject ${i}`, at: now - i * 3_600_000 });
    gr.add({ id: 'old', from: 'Old', addr: 'old@example.com', subject: 'Old', at: now - 30 * DAY });
    setMailProviders(() => [outlookProvider()]);
    const r1 = await syncMail();
    expect(r1.accounts[0]).toMatchObject({ ok: true, full: true });
    expect(rows('outlook').map((r) => r.provider_id)).toEqual(['o1', 'o2', 'o3', 'o4', 'o5']);
    expect(gr.requests.filter((x) => x.includes('/delta')).length).toBe(3); // 5 messages, pages of 2
    expect(getSyncState('outlook')!.cursor).toMatch(/\$deltatoken=\d+$/);
    expect(rows('outlook')[0]).toMatchObject({ from_name: 'Sender 1', thread_id: 'c-o1', snippet: 'Preview of Subject 1', unread: 1 });

    gr.add({ id: 'o6', from: 'Dana', addr: 'dana@example.com', subject: 'New', at: now - 1000 });
    gr.markRead('o2');
    gr.remove('o3');
    const r2 = await syncMail();
    expect(r2.accounts[0]).toMatchObject({ ok: true, full: false, result: { added: 1, changed: 1, removed: 1 } });
    expect(rows('outlook').map((r) => [r.provider_id, r.unread])).toEqual([['o6', 1], ['o1', 1], ['o2', 0], ['o4', 1], ['o5', 1]]);
  });

  it('an expired delta token (410) resyncs the window; a revoked sign-in (401) needs a reconnect', async () => {
    gr.add({ id: 'p1', from: 'A', addr: 'a@example.com', subject: 'One', at: now - DAY });
    setMailProviders(() => [outlookProvider()]);
    await syncMail();
    gr.remove('p1');
    gr.add({ id: 'p2', from: 'B', addr: 'b@example.com', subject: 'Two', at: now - 1000 });
    gr.expiredBefore = gr.seq + 1;
    const r = await syncMail();
    expect(r.accounts[0]).toMatchObject({ ok: true, full: true });
    expect(rows('outlook').map((x) => x.provider_id)).toEqual(['p2']);

    gr.revoked = true;
    const bad = await syncMail();
    expect(bad.accounts[0]).toMatchObject({ ok: false, needsReconnect: true });
    expect(getSyncState('outlook')).toMatchObject({ needs_reconnect: 1 });
    expect(rows('outlook')).toHaveLength(1); // what was there stays
  });
});

describe('across accounts', () => {
  it('the same email in Gmail and Outlook is stored per account and listed once (by Message-ID)', async () => {
    gm.msgs.clear(); gm.history = []; gm.oldestHistory = 0; gm.refuseToken = false;
    gr.msgs.clear(); gr.changes = []; gr.seq = 0; gr.revoked = false; gr.expiredBefore = 0;
    gm.add({ id: 'same-g', from: 'Dana Lee <dana@example.com>', subject: 'Top 3?', at: now - 3_600_000, headers: { From: 'Dana Lee <dana@example.com>', Subject: 'Top 3?', 'Message-ID': '<shared-1@example.com>' } });
    gm.add({ id: 'only-g', from: 'a@x.example', subject: 'Gmail only', at: now - 7_200_000 });
    gr.add({ id: 'same-o', from: 'Dana Lee', addr: 'dana@example.com', subject: 'Top 3?', at: now - 3_600_000 + 4000, messageId: '<SHARED-1@example.com>' });
    setMailProviders(() => [gmailProvider({ auth: gAuth(), rootUrl: gm.base }), outlookProvider()]);
    await syncMail();
    expect(rows()).toHaveLength(3);
    const listed = listMail({ limit: 50 });
    expect(listed.map((r) => r.provider_id)).toEqual(['same-o', 'only-g']); // one copy: the newest
    expect(mailId('outlook', 'same-o')).toMatch(/^m_/);
  });
});
