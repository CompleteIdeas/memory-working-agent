// v2 build, slice A8: /api/v1/mail over real HTTP — the plain mailbox, the reader (sanitised, untrusted, never
// stored), saving a reply DRAFT (idempotent, never a send), scopes, needs_reconnect, and /sync's `mail` collection.
// Providers are FAKES (tests/fixtures/fake-mail.ts): Gmail REST and Graph as HTTP servers, IMAP at imapflow's interface.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV1 } from '../src/api/router.js';
import { v1Routes } from '../src/api/v1.js';
import { ALL_SCOPES, type Caller } from '../src/api/auth.js';
import { appDb, resetAppDb } from '../src/v2/db.js';
import { mailId } from '../src/v2/mail.js';
import { saveReplyDraft } from '../src/sync/mail.js';
import { setMailProviders, syncMail, bodyCacheSize } from '../src/sync/mail.js';
import { gmailProvider } from '../src/sync/gmail.js';
import { imapProvider } from '../src/sync/imap.js';
import { outlookProvider } from '../src/sync/outlook-mail.js';
import { FakeGmail, FakeGraph, FakeImap, googleTestAuth } from './fixtures/fake-mail.js';
import { HOSTILE } from './fixtures/hostile-email.js';

const ADMIN: Caller = { kind: 'session', id: 'session', scopes: new Set(ALL_SCOPES), viaCookie: true };
const PHONE_READ: Caller = { kind: 'device', id: 'dev_r', scopes: new Set(['read']), viaCookie: false };
const PHONE_ACT: Caller = { kind: 'device', id: 'dev_a', scopes: new Set(['read', 'act', 'approve']), viaCookie: false };
const DAY = 86_400_000, now = Date.now();
const BODY_MARKER = 'UNIQUE-BODY-MARKER-7731';

let who: Caller = ADMIN;
let server: Server, base = '';
let gm: FakeGmail, gr: FakeGraph, im: FakeImap, tmp: string;
const envBefore = { ...process.env };
const G = 'google:robert@gmail.example', O = 'outlook:robert@outlook.example', I = 'imap:robert@gmail.example';

beforeAll(async () => {
  gm = await new FakeGmail().start();
  gr = await new FakeGraph().start();
  tmp = mkdtempSync(join(tmpdir(), 'mwa-a8-api-'));
  writeFileSync(join(tmp, 'ms.json'), JSON.stringify({ access_token: 'fake-graph-token', expires_at: Date.now() + 3_600_000, scope: 'Mail.ReadWrite' }));
  Object.assign(process.env, { MWA_GRAPH_BASE: gr.base, MWA_MS_TOKEN: join(tmp, 'ms.json'), MICROSOFT_CLIENT_ID: 'test-client', MWA_GOOGLE_TOKEN: join(tmp, 'no-google-token.json') });
  const v1 = createV1(v1Routes(), { authenticate: () => who, sameOrigin: () => true });
  server = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
});
afterAll(() => {
  server?.close(); gm.close(); gr.close(); setMailProviders(null);
  for (const k of ['MWA_GRAPH_BASE', 'MWA_MS_TOKEN', 'MICROSOFT_CLIENT_ID', 'MWA_GOOGLE_TOKEN']) { if (envBefore[k] === undefined) delete process.env[k]; else process.env[k] = envBefore[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  resetAppDb(':memory:'); who = ADMIN;
  gm.msgs.clear(); gm.history = []; gm.drafts = []; gm.requests = []; gm.sendCalls = 0; gm.oldestHistory = 0; gm.refuseToken = false; gm.readOnly = false;
  gr.msgs.clear(); gr.changes = []; gr.seq = 0; gr.drafts = []; gr.requests = []; gr.sendCalls = 0; gr.revoked = false; gr.expiredBefore = 0; gr.readOnly = false;
  im = new FakeImap();
  gm.add({ id: 'ellen', from: 'Coach Ellen <ellen@willowcreekfarm.example>', subject: 'Saturday schooling — are you in?', at: now - 3_600_000,
    html: HOSTILE.replace('Hi Robert,', `Hi Robert, ${BODY_MARKER}`),
    headers: { From: 'Coach Ellen <ellen@willowcreekfarm.example>', Subject: 'Saturday schooling — are you in?', 'Message-ID': '<ellen-1@willowcreekfarm.example>', References: '<earlier-0@willowcreekfarm.example>' } });
  gm.add({ id: 'dana', from: 'Dana Lee <dana@example.com>', subject: 'Newsletter: your top 3 for Thursday?', at: now - DAY, headers: { From: 'Dana Lee <dana@example.com>', Subject: 'Newsletter: your top 3 for Thursday?', 'Message-ID': '<dana-top3@example.com>' } });
  gm.add({ id: 'batch', from: 'The Batch <news@thebatch.example>', subject: 'This week in AI', at: now - 2 * DAY, labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] });
  gr.add({ id: 'AAMkAD/x+y==', from: 'Dana Lee', addr: 'dana@example.com', subject: 'Newsletter: your top 3 for Thursday?', at: now - DAY + 5000, messageId: '<dana-top3@example.com>' });
  gr.add({ id: 'o-sam', from: 'Sam', addr: 'sam@example.com', subject: 'Lunch Tuesday?', at: now - 5 * DAY, html: '<p>Lunch? <a href="https://maps.example.com/x">Here</a></p>' });
  im.add({ from: 'Oakwood PTA', addr: 'pta@oakwood.example', subject: 'Book fair this Saturday, 3–6pm', at: now - 2 * 3_600_000, html: '<p>The fall book fair is in the gym.</p>' });
  setMailProviders(() => [gmailProvider({ auth: googleAuth, rootUrl: gm.base }), outlookProvider(), imapProvider({ connect: im.connect, user: 'robert@gmail.example' })]);
  await syncMail();
});
let googleAuth: unknown;
beforeAll(async () => { googleAuth = await googleTestAuth(gm.tokenUrl); });

const j = async (r: Response) => ({ status: r.status, headers: r.headers, body: await r.json() as any });
const get = (p: string) => fetch(base + p).then(j);
let keyN = 0;
const post = (p: string, body: unknown, key = `mail-test-${++keyN}-${Date.now()}`) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) }).then(j);
const idOf = (account: string, pid: string) => mailId(account, pid);

describe('GET /mail — the plain mailbox', () => {
  it('lists headers newest first, one row per message across accounts, with the never-sends note', async () => {
    const r = await get('/mail');
    expect(r.status).toBe(200);
    expect(r.body.note).toBe('Your helper reads and writes drafts. It never sends.');
    expect(r.body.mail.map((m: any) => m.subject)).toEqual([
      'Saturday schooling — are you in?', 'Book fair this Saturday, 3–6pm', 'Newsletter: your top 3 for Thursday?', 'This week in AI', 'Lunch Tuesday?',
    ]);
    const dana = r.body.mail.find((m: any) => m.subject.startsWith('Newsletter'));
    expect(dana).toMatchObject({ account: O, alsoIn: [G] }); // the newer copy is shown, the other is noted
    expect(r.body.mail.find((m: any) => m.subject === 'This week in AI').labels).toContain('CATEGORY_PROMOTIONS');
    expect(r.body.mail[0]).toMatchObject({ from: { name: 'Coach Ellen', addr: 'ellen@willowcreekfarm.example' }, unread: true, provider: 'gmail' });
    expect(r.body.mail[0]).not.toHaveProperty('bodyText'); // headers only
  });
  it('pages with an opaque cursor, without overlap', async () => {
    const p1 = await get('/mail?limit=2');
    expect(p1.body.mail).toHaveLength(2);
    expect(p1.body.nextBefore).toMatch(/^\d+\.m_/);
    const p2 = await get(`/mail?limit=2&before=${encodeURIComponent(p1.body.nextBefore)}`);
    const p3 = await get(`/mail?limit=2&before=${encodeURIComponent(p2.body.nextBefore)}`);
    expect(p3.body.nextBefore).toBeNull();
    const all = [...p1.body.mail, ...p2.body.mail, ...p3.body.mail].map((m: any) => m.id);
    expect(new Set(all).size).toBe(5);
    expect((await get('/mail?before=nonsense')).body.error.code).toBe('bad_cursor');
    expect((await get('/mail?limit=0')).status).toBe(400);
    expect((await get('/mail?limit=500')).status).toBe(400);
  });
  it('GET /mail/accounts lists the connected accounts', async () => {
    const r = await get('/mail/accounts');
    expect(r.body.accounts.map((a: any) => [a.account, a.provider, a.needsReconnect])).toEqual([[G, 'gmail', false], [O, 'outlook', false], [I, 'imap', false]]);
    expect(r.body.accounts[0].lastOk).toBeGreaterThan(0);
  });
});

describe('GET /mail/{id} — the reader', () => {
  it('returns the body as sanitised plain text, marked untrusted', async () => {
    const r = await get(`/mail/${idOf(G, 'ellen')}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ trust: 'untrusted', subject: 'Saturday schooling — are you in?', from: { name: 'Coach Ellen' }, imagesHidden: 1, trackersRemoved: 2 });
    expect(r.body.bodyText).toContain('Pay now (billing.example.com)');
    expect(r.body.bodyText).not.toMatch(/HIDDEN-|https?:\/\/|javascript:|<script/i);
    expect(r.body.bodyText).not.toContain('secret.pdf'); // attachments are not bodies
  });
  it('fetches once, then serves from the in-process cache; the body is never written to app.db', async () => {
    const id = idOf(G, 'ellen');
    gm.requests = []; // the sync fetched its metadata; count only what the reader fetches
    await get(`/mail/${id}`); await get(`/mail/${id}`);
    expect(gm.requests.filter((x) => x === 'GET /gmail/v1/users/me/messages/ellen')).toHaveLength(1);
    expect(bodyCacheSize()).toBeGreaterThanOrEqual(1);
    const d = appDb();
    const tables = (d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name);
    for (const t of tables) expect(JSON.stringify(d.prepare(`SELECT * FROM "${t}"`).all()), t).not.toContain(BODY_MARKER);
  });
  it('reads Outlook (an id with / + =) and IMAP (read-only) messages too', async () => {
    const o = await get(`/mail/${idOf(O, 'o-sam')}`);
    expect(o.body.bodyText).toBe('Lunch? Here (maps.example.com)');
    const i = await get(`/mail/${idOf(I, '7.1')}`);
    expect(i.body.bodyText).toBe('The fall book fair is in the gym.');
    expect(im.opens.every((x) => x.readOnly)).toBe(true);
    const weird = await get(`/mail/${idOf(O, 'AAMkAD/x+y==')}`);
    expect(weird.status).toBe(200);
  });
  it('an unknown or malformed id is a 404; a message deleted at the provider is "gone"', async () => {
    expect((await get(`/mail/${idOf(G, 'nope')}`)).status).toBe(404);
    expect((await get('/mail/m_!!')).status).toBe(404);
    expect((await get('/mail/xyz')).status).toBe(404);
    gm.msgs.delete('dana');
    const r = await get(`/mail/${idOf(G, 'dana')}`);
    expect(r).toMatchObject({ status: 404, body: { error: { code: 'gone' } } });
  });
  it('a revoked sign-in is "needs_reconnect", and the account says so', async () => {
    gr.revoked = true;
    const r = await get(`/mail/${idOf(O, 'o-sam')}`);
    expect(r).toMatchObject({ status: 409, body: { error: { code: 'needs_reconnect' } } });
    expect(r.body.error.message).toMatch(/Outlook needs to be reconnected/);
    const a = await get('/mail/accounts');
    expect(a.body.accounts.find((x: any) => x.account === O).needsReconnect).toBe(true);
  });
});

describe('POST /mail/{id}/draft — save a drafted reply', () => {
  const reply = 'Hi Ellen, yes please — count Willow and me in for the 7am trailer on Saturday. Thanks!\nRobert';
  it('Gmail: one draft for two calls with the same key, threaded, and never a send', async () => {
    const id = idOf(G, 'ellen');
    const a = await post(`/mail/${id}/draft`, { body: reply }, 'same-key-gmail-0001');
    const b = await post(`/mail/${id}/draft`, { body: reply }, 'same-key-gmail-0001');
    expect(a).toMatchObject({ status: 201, body: { saved: true, sent: false, message: 'Saved to your drafts. Nothing was sent.' } });
    expect(b.status).toBe(201);
    expect(b.headers.get('idempotent-replay')).toBe('true');
    expect(gm.drafts).toHaveLength(1);
    const raw = gm.drafts[0].raw;
    expect(raw).toMatch(/^To: "Coach Ellen" <ellen@willowcreekfarm\.example>\r$/m);
    expect(raw).toMatch(/^Subject: =\?UTF-8\?B\?/m); // "Re: Saturday schooling — are you in?" (non-ASCII, encoded)
    expect(raw).toMatch(/^In-Reply-To: <ellen-1@willowcreekfarm\.example>\r$/m);
    expect(raw).toMatch(/^References: <earlier-0@willowcreekfarm\.example> <ellen-1@willowcreekfarm\.example>\r$/m);
    expect(Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(reply.replace(/\n/g, '\r\n'));
    expect(gm.drafts[0].threadId).toBe('t-ellen');
    // a new key is a new draft (the key is what dedupes)
    await post(`/mail/${id}/draft`, { body: reply }, 'other-key-gmail-0002');
    expect(gm.drafts).toHaveLength(2);
    expect(gm.sendCalls).toBe(0);
    expect(gm.requests.some((x) => /send/.test(x))).toBe(false);
  });
  it('Outlook: createReply once, and never a send', async () => {
    const id = idOf(O, 'o-sam');
    await post(`/mail/${id}/draft`, { body: 'Tuesday works.' }, 'same-key-graph-0001');
    const b = await post(`/mail/${id}/draft`, { body: 'Tuesday works.' }, 'same-key-graph-0001');
    expect(b.body.message).toBe('Saved to your drafts. Nothing was sent.');
    expect(gr.drafts).toEqual([expect.objectContaining({ id: 'od-1', replyTo: 'o-sam', comment: 'Tuesday works.' })]);
    expect(gr.sendCalls).toBe(0);
    expect(gr.requests.some((x) => /send|\/reply$/i.test(x))).toBe(false);
  });
  it('IMAP: one APPEND to Drafts flagged \\Draft, with reply headers', async () => {
    const id = idOf(I, '7.1');
    await post(`/mail/${id}/draft`, { body: 'I can help at 3:30.' }, 'same-key-imap-00001');
    await post(`/mail/${id}/draft`, { body: 'I can help at 3:30.' }, 'same-key-imap-00001');
    expect(im.appended).toHaveLength(1);
    expect(im.appended[0]).toMatchObject({ path: '[Gmail]/Drafts', flags: ['\\Draft'] });
    expect(im.appended[0].content).toMatch(/^From: robert@gmail\.example\r$/m);
    expect(im.appended[0].content).toMatch(/^In-Reply-To: <imap-1@mail\.example>\r$/m);
    expect(im.appended[0].content).toMatch(/^To: "Oakwood PTA" <pta@oakwood\.example>\r$/m);
  });
  it('refuses an empty or oversized reply, and a header injection cannot add a recipient', async () => {
    const id = idOf(G, 'ellen');
    expect((await post(`/mail/${id}/draft`, { body: '  ' })).body.error.code).toBe('bad_body');
    expect((await post(`/mail/${id}/draft`, {})).body.error.code).toBe('bad_body');
    expect((await post(`/mail/${id}/draft`, { body: 'x'.repeat(20_001) })).body.error.code).toBe('too_long');
    gm.msgs.get('ellen')!.headers.Subject = 'Hello\r\nBcc: attacker@evil.example';
    await post(`/mail/${id}/draft`, { body: 'ok' });
    expect(gm.drafts.at(-1)!.raw).not.toMatch(/^Bcc:/m);
  });
});

describe('scopes', () => {
  it('a phone with read can read but needs act to draft or refresh', async () => {
    who = PHONE_READ;
    expect((await get('/mail')).status).toBe(200);
    expect((await get(`/mail/${idOf(G, 'ellen')}`)).status).toBe(200);
    expect((await get('/mail/accounts')).status).toBe(200);
    const d = await post(`/mail/${idOf(G, 'ellen')}/draft`, { body: 'hi' });
    expect(d).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
    expect((await post('/mail/refresh', {})).status).toBe(403);
    expect(gm.drafts).toHaveLength(0);
    who = PHONE_ACT;
    expect((await post(`/mail/${idOf(G, 'ellen')}/draft`, { body: 'hi' })).status).toBe(201);
    who = null as unknown as Caller;
    expect((await get('/mail')).status).toBe(401);
  });
});

describe('POST /mail/refresh and /sync', () => {
  it('refresh syncs now; with no account it says to connect one', async () => {
    gm.add({ id: 'fresh', from: 'Hillside Hardware <orders@hillside.example>', subject: 'Your order has shipped', at: now - 1000 });
    const r = await post('/mail/refresh', {});
    expect(r).toMatchObject({ status: 200, body: { done: true, message: 'Up to date.' } });
    expect((await get('/mail')).body.mail[0].subject).toBe('Your order has shipped');
    setMailProviders(() => []);
    expect((await post('/mail/refresh', {})).body.error.code).toBe('not_connected');
  });
  it('/sync carries mail headers (once across accounts) as a snapshot, then as changes', async () => {
    const snap = await get('/sync?collections=jobs,mail');
    expect(snap.body.reset).toBe(true);
    expect(snap.body.upserts.mail).toHaveLength(5);
    expect(snap.body.upserts.jobs).toEqual([]);
    expect(snap.body.upserts.mail[0]).not.toHaveProperty('bodyText');
    const cursor = snap.body.cursor;

    gm.add({ id: 'new1', from: 'Riley <riley@example.com>', subject: 'Practice moved', at: now - 500 });
    gm.remove('batch');
    gm.markRead('ellen');
    await syncMail();
    const d = await get(`/sync?since=${cursor}&collections=mail`);
    expect(d.body.reset).toBe(false);
    expect(d.body).not.toHaveProperty('upserts.jobs');
    expect(d.body.upserts.mail.map((m: any) => m.subject).sort()).toEqual(['Practice moved', 'Saturday schooling — are you in?']);
    expect(d.body.upserts.mail.find((m: any) => m.subject.startsWith('Saturday')).unread).toBe(false);
    expect(d.body.deletes.mail).toEqual([idOf(G, 'batch')]);

    // the Outlook copy of Dana's email goes: the Gmail copy is shown in its place
    gr.remove('AAMkAD/x+y==');
    const c2 = d.body.cursor;
    await syncMail();
    const d2 = await get(`/sync?since=${c2}&collections=mail`);
    expect(d2.body.upserts.mail.map((m: any) => [m.account, m.subject])).toEqual([[G, 'Newsletter: your top 3 for Thursday?']]);
    expect(d2.body.deletes.mail).toEqual([idOf(O, 'AAMkAD/x+y==')]);
    expect((await get('/sync?collections=nope')).body.error.code).toBe('unknown_collection');
  });
});

// ── Review of A8: drafts, recipients and refusals ───────────────────────────────────────────────────────────────

describe('a draft retried after a lost answer is not saved twice (the draft id comes from the Idempotency-Key)', () => {
  const draftId = '<mwa-draft-0123456789abcdef0123456789abcdef@gmail.example>';
  it('Gmail: the second save finds the first draft by its Message-ID', async () => {
    const a = await saveReplyDraft(G, 'ellen', 'Yes please.', draftId);
    const b = await saveReplyDraft(G, 'ellen', 'Yes please.', draftId);
    expect([a.already, b.already]).toEqual([false, true]);
    expect(gm.drafts).toHaveLength(1);
    expect(gm.drafts[0].raw).toMatch(/^Message-ID: <mwa-draft-0123456789abcdef0123456789abcdef@gmail\.example>\r$/m);
  });
  it('IMAP: the second save finds the first in Drafts', async () => {
    await saveReplyDraft(I, '7.1', 'I can help.', draftId);
    const b = await saveReplyDraft(I, '7.1', 'I can help.', draftId);
    expect(b.already).toBe(true);
    expect(im.appended).toHaveLength(1);
    expect(im.opens.filter((o) => o.path === '[Gmail]/Drafts').every((o) => o.readOnly)).toBe(true);
  });
  it('Outlook: the second save finds the first by its extended property', async () => {
    await saveReplyDraft(O, 'o-sam', 'Tuesday works.', draftId);
    const b = await saveReplyDraft(O, 'o-sam', 'Tuesday works.', draftId);
    expect(b.already).toBe(true);
    expect(gr.drafts).toHaveLength(1);
  });
  it('over HTTP: two different requests (keys) are two drafts', async () => {
    const id = idOf(G, 'dana');
    await post(`/mail/${id}/draft`, { body: 'Wednesday.' }, 'key-aaaaaaaa-1');
    await post(`/mail/${id}/draft`, { body: 'Wednesday.' }, 'key-bbbbbbbb-2');
    expect(gm.drafts).toHaveLength(2);
  });
});

describe('who a reply goes to (review M4)', () => {
  it('a Reply-To that is not the sender is shown on the reader and on the saved draft', async () => {
    gm.add({ id: 'bank', from: 'Chase <alerts@chase.example>', subject: 'Verify your account', at: now - 60_000,
      headers: { From: 'Chase <alerts@chase.example>', 'Reply-To': 'Fraud Desk <fraud-desk@attacker.example>', Subject: 'Verify your account', 'Message-ID': '<bank-1@chase.example>' }, html: '<p>Reply to confirm.</p>' });
    await syncMail();
    const r = await get(`/mail/${idOf(G, 'bank')}`);
    expect(r.body).toMatchObject({ replyGoesElsewhere: true, replyTo: [{ name: 'Fraud Desk', addr: 'fraud-desk@attacker.example' }], replyNote: 'Your reply will go to fraud-desk@attacker.example (not the sender).' });
    const d = await post(`/mail/${idOf(G, 'bank')}/draft`, { body: 'ok' });
    expect(d.body).toMatchObject({ replyGoesElsewhere: true, to: [{ name: 'Fraud Desk', addr: 'fraud-desk@attacker.example' }] });
    expect(gm.drafts.at(-1)!.raw).toMatch(/^To: "Fraud Desk" <fraud-desk@attacker\.example>\r$/m);
    const plain = await get(`/mail/${idOf(G, 'ellen')}`);
    expect(plain.body).toMatchObject({ replyGoesElsewhere: false, replyNote: null });
  });
  it('a display name full of quotes and commas cannot add a recipient (Gmail header and IMAP envelope)', async () => {
    gm.add({ id: 'inj', from: 'x', subject: 'Hello', at: now - 60_000,
      headers: { From: '"Chase\\", fraud-desk@attacker.example, \\"x" <alerts@chase.example>', Subject: 'Hello\r\nBcc: spy@attacker.example', 'Message-ID': '<inj@chase.example>\r\nBcc: x@y.example' } });
    im.add({ from: 'Chase", fraud-desk@attacker.example, "x', addr: 'alerts@chase.example', subject: 'Hello', at: now - 60_000 });
    await syncMail();
    await post(`/mail/${idOf(G, 'inj')}/draft`, { body: 'ok' });
    const g = gm.drafts.at(-1)!.raw.split('\r\n\r\n')[0];
    expect(g).toMatch(/^To: "Chase\\", fraud-desk@attacker\.example, \\"x" <alerts@chase\.example>\r?$/m);
    expect(g).not.toMatch(/^Bcc:/m);
    expect(g.match(/<fraud-desk@attacker\.example>/g)).toBeNull(); // the attacker's address is only text inside the quoted name
    await post(`/mail/${idOf(I, '7.2')}/draft`, { body: 'ok' });
    const i = im.appended.at(-1)!.content.split('\r\n\r\n')[0];
    expect(i).toMatch(/^To: "Chase\\", fraud-desk@attacker\.example, \\"x" <alerts@chase\.example>\r?$/m);
  });
  it('the reader recipients line is cleaned', async () => {
    const r = await get(`/mail/${idOf(O, 'o-sam')}`);
    expect(r.body.to).toBe('Robert <robert@outlook.example>');
  });
});

describe('refusals that may not hold are not remembered against the key (transient)', () => {
  it('a read-only Gmail sign-in: 409 read_only; after reconnecting, the SAME key saves the draft', async () => {
    gm.readOnly = true;
    const a = await post(`/mail/${idOf(G, 'ellen')}/draft`, { body: 'Yes.' }, 'retry-key-0001');
    expect(a).toMatchObject({ status: 409, body: { error: { code: 'read_only' } } });
    expect(a.body.error.message).toBe('Gmail was connected read-only. Reconnect it in Settings with drafting allowed.');
    gm.readOnly = false;
    const b = await post(`/mail/${idOf(G, 'ellen')}/draft`, { body: 'Yes.' }, 'retry-key-0001');
    expect(b.status).toBe(201);
    expect(b.headers.get('idempotent-replay')).toBeNull();
    expect(gm.drafts).toHaveLength(1);
  });
  it('a read-only Outlook sign-in: 409 read_only too', async () => {
    gr.readOnly = true;
    expect((await post(`/mail/${idOf(O, 'o-sam')}/draft`, { body: 'Yes.' })).body.error.code).toBe('read_only');
  });
  it('needs_reconnect is transient too', async () => {
    gr.revoked = true;
    const a = await post(`/mail/${idOf(O, 'o-sam')}/draft`, { body: 'Yes.' }, 'retry-key-0002');
    expect(a.body.error.code).toBe('needs_reconnect');
    gr.revoked = false;
    expect((await post(`/mail/${idOf(O, 'o-sam')}/draft`, { body: 'Yes.' }, 'retry-key-0002')).status).toBe(201);
  });
});

describe('Gmail bodies are decoded by their charset (review LOW)', () => {
  it('Latin-1 and ISO-2022-JP parts read correctly', async () => {
    gm.add({ id: 'latin', from: 'Paris <p@x.example>', subject: 'Reunion', at: now - 60_000, text: 'Café, réunion à 10h', charset: 'latin1' });
    gm.add({ id: 'jis', from: 'Tokyo <t@x.example>', subject: 'Japan', at: now - 50_000, textBytes: Buffer.from([0x1b, 0x24, 0x42, 0x46, 0x7c, 0x4b, 0x5c, 0x1b, 0x28, 0x42]), charset: 'iso-2022-jp' }); // 日本
    await syncMail();
    expect((await get(`/mail/${idOf(G, 'latin')}`)).body.bodyText).toBe('Café, réunion à 10h');
    expect((await get(`/mail/${idOf(G, 'jis')}`)).body.bodyText).toBe('日本');
  });
});
