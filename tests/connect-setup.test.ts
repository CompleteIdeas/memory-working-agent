/**
 * BL-62 — connect an account by asking. The agent starts it; anything secret is typed into a setup card and checked
 * against the service before it is saved; the model only ever hears how it went.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setSetupDeps, findService, openSetupRequest, submitSetupRequest, listSetupRequests, cancelSetupRequest, _resetSetupRequests, type SetupDeps } from '../src/connect/setup.js';
import { connectTools } from '../src/tools/connect.js';
import { classifyTool, outputSource } from '../src/tools/governance.js';

const SECRET = 'abcd efgh ijkl mnop';
function wire(over: Partial<SetupDeps> = {}) {
  const saved: Record<string, string>[] = [];
  const state = { gmail: false, outlook: false, outlookApp: false, telegram: false };
  setSetupDeps({
    save: (v) => { saved.push(v); },
    gmailConnected: () => state.gmail,
    checkGmail: async (u, p) => (p === SECRET.replace(/\s+/g, '') ? { ok: true, message: `Signed in as ${u}.` } : { ok: false, message: 'Gmail refused that app password.' }),
    outlookConnected: () => state.outlook,
    outlookAppReady: () => state.outlookApp,
    startOutlookDeviceCode: async () => ({ user_code: 'K7QX-2M', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900 }),
    telegramConnected: () => state.telegram,
    checkTelegram: async (t) => (t.includes(':') ? { ok: true, message: 'Bot found.' } : { ok: false, message: 'Telegram doesn\'t know that token.' }),
    ...over,
  });
  return { saved, state };
}
const tool = (name: string) => connectTools().find((t) => t.def.name === name)!;
const ctx = (extra: Record<string, unknown> = {}) => ({ sandboxDir: '.', interactive: true, session: 's1', ...extra });

describe('connect an account by asking', () => {
  beforeEach(() => _resetSetupRequests());

  it('the person names a service in their own words; the agent can\'t name a setting', () => {
    expect(findService('my work Outlook')?.id).toBe('outlook');
    expect(findService('Office 365')?.id).toBe('outlook');
    expect(findService('gmail')?.id).toBe('gmail');
    expect(findService('github')?.id).toBe('github');
    expect(findService('OPENROUTER_API_KEY')).toBeUndefined();
    expect([findService('my email'), findService('o')]).toEqual([undefined, undefined]); // ambiguous: the agent asks
  });

  it('Gmail: a card, then a wrong password is refused and nothing is saved; the right one is saved and never echoed', async () => {
    const { saved } = wire();
    const said = await tool('connect_account').handler({ service: 'gmail' }, ctx());
    expect(said).toMatch(/setup card for Gmail/);
    expect(said).toMatch(/apppasswords/);
    expect(said).toMatch(/not into this chat/);
    const card = listSetupRequests()[0];
    expect(card.fields.map((f) => [f.env, f.secret])).toEqual([['MWA_GMAIL_USER', false], ['MWA_GMAIL_APP_PASSWORD', true]]);

    const bad = await submitSetupRequest(card.id, { MWA_GMAIL_USER: 'jordan@example.com', MWA_GMAIL_APP_PASSWORD: 'wrong' });
    expect(bad).toEqual({ ok: false, message: 'Gmail refused that app password.' });
    expect(saved).toEqual([]);
    expect(listSetupRequests()[0].status).toBe('waiting'); // fix it and try again

    // A field the card didn't ask for is dropped, not saved.
    const good = await submitSetupRequest(card.id, { MWA_GMAIL_USER: 'jordan@example.com', MWA_GMAIL_APP_PASSWORD: SECRET, OPENROUTER_API_KEY: 'sk-planted' });
    expect(good.ok).toBe(true);
    expect(saved).toEqual([{ MWA_GMAIL_USER: 'jordan@example.com', MWA_GMAIL_APP_PASSWORD: SECRET }]);
    const all = JSON.stringify([good, listSetupRequests(), await tool('connect_account').handler({ service: 'gmail' }, ctx())]);
    expect(all).not.toContain('mnop');
  });

  it('Outlook with an app id is a sign-in code, no card; without one, the card asks for the app ids and then gives the code', async () => {
    const { state, saved } = wire();
    state.outlookApp = true;
    const said = await tool('connect_account').handler({ service: 'outlook' }, ctx());
    expect(said).toMatch(/microsoft\.com\/devicelogin.*K7QX-2M/);
    expect(listSetupRequests()).toEqual([]);

    state.outlookApp = false;
    await tool('connect_account').handler({ service: 'outlook' }, ctx());
    const card = listSetupRequests()[0];
    expect(card.fields.every((f) => !f.secret)).toBe(true);
    expect((await submitSetupRequest(card.id, { MICROSOFT_CLIENT_ID: 'not-a-guid' })).ok).toBe(false);
    const ok = await submitSetupRequest(card.id, { MICROSOFT_CLIENT_ID: '1b2c3d4e-0000-4000-8000-123456789abc', MICROSOFT_TENANT: 'useventing.com' });
    expect(ok.message).toMatch(/K7QX-2M/);
    expect(saved).toEqual([{ MICROSOFT_CLIENT_ID: '1b2c3d4e-0000-4000-8000-123456789abc', MICROSOFT_TENANT: 'useventing.com' }]);
  });

  it('asking twice shows the same card; a closed card can be reopened', async () => {
    wire();
    await tool('connect_account').handler({ service: 'telegram' }, ctx());
    await tool('connect_account').handler({ service: 'telegram bot' }, ctx());
    expect(listSetupRequests().filter((r) => r.status === 'waiting')).toHaveLength(1);
    expect(cancelSetupRequest(listSetupRequests()[0].id)).toBe(true);
    await tool('connect_account').handler({ service: 'telegram' }, ctx());
    expect(listSetupRequests().filter((r) => r.status === 'waiting')).toHaveLength(1);
  });

  it('not from a scheduled run, and not from a conversation steered by an email or page', async () => {
    wire();
    expect(await tool('connect_account').handler({ service: 'gmail' }, ctx({ interactive: false }))).toMatch(/^\(refused/);
    expect(await tool('connect_account').handler({ service: 'gmail' }, ctx({ tainted: true }))).toMatch(/^\(refused/);
    expect(listSetupRequests()).toEqual([]);
  });

  it('already connected says so; status lists every service', async () => {
    const { state } = wire();
    state.telegram = true;
    expect(await tool('connect_account').handler({ service: 'telegram' }, ctx())).toMatch(/already connected/);
    const s = await tool('connection_status').handler({}, ctx());
    expect(s).toMatch(/Telegram \(telegram\): connected/);
    expect(s).toMatch(/Gmail \(gmail\): not connected/);
  });

  it('is classified as a local change whose output MWA wrote itself', () => {
    expect([classifyTool('connect_account'), classifyTool('connection_status')]).toEqual(['write-local', 'read']);
    expect([outputSource('connect_account'), outputSource('connection_status')]).toEqual(['own', 'own']);
  });
});
