// v2 build, slice S3 review: a sign-in that was started can be stopped. Outlook's device-code poller runs one at a
// time (a new code cancels the old one), and Cancel / Disconnect stop it, so a code finished later never connects
// Outlook again; the browser sign-in's loopback listener closes on Cancel. Also: the Host check allows the tailnet
// name Tailscale joined with at this start, not what Settings saved since. A fake Microsoft token server stands in
// for Microsoft; nothing real is contacted.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { startMicrosoftDeviceCode, cancelMicrosoftSignIn } from '../src/connectors/microsoft.js';
import { catchOAuthCode, cancelOAuthCatch } from '../src/connect/oauth-catcher.js';
import { hostAllowed, relayedMode, captureTailscaleAtStart, resetTailscaleAtStart, tailscaleName } from '../src/api/trust.js';

let fake: Server, base = '';
const asked: string[] = []; // device codes the token endpoint was asked about
let n = 0;
const SAVED: Record<string, string | undefined> = {};
const KEYS = ['MWA_MS_AUTH_BASE', 'MWA_GRAPH_BASE', 'MWA_MS_TOKEN', 'MICROSOFT_CLIENT_ID', 'MWA_MS_DEVICE_POLL_MS', 'TAILSCALE_AUTHKEY', 'TAILSCALE_HOSTNAME', 'MWA_RELAYED'];
const tokenFile = () => process.env.MWA_MS_TOKEN!;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  for (const k of KEYS) SAVED[k] = process.env[k];
  fake = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; }).on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.endsWith('/devicecode')) { res.end(JSON.stringify({ device_code: `dc-${++n}`, user_code: `CODE-${n}`, verification_uri: 'https://microsoft.com/devicelogin', interval: 5, expires_in: 900 })); return; }
      if (req.url?.endsWith('/token')) {
        asked.push(new URLSearchParams(body).get('device_code') ?? '');
        res.end(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }));
        return;
      }
      if (req.url?.endsWith('/me')) { res.end(JSON.stringify({ userPrincipalName: 'robert@outlook.com' })); return; }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
});
beforeEach(() => {
  process.env.MWA_MS_AUTH_BASE = base;
  process.env.MWA_GRAPH_BASE = base;
  process.env.MWA_MS_TOKEN = join(mkdtempSync(join(tmpdir(), 'mwa-s3-ms-')), 'microsoft-token.json');
  process.env.MICROSOFT_CLIENT_ID = '11111111-2222-3333-4444-555555555555';
  process.env.MWA_MS_DEVICE_POLL_MS = '60';
  asked.length = 0;
});
afterAll(() => {
  fake?.close();
  for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
  resetTailscaleAtStart();
});

describe('Outlook device code', () => {
  it('a finished code connects (the control)', async () => {
    await startMicrosoftDeviceCode();
    await wait(400);
    expect(existsSync(tokenFile())).toBe(true);
  });
  it('Cancel before the person finishes: nothing is saved, the poller stops asking', async () => {
    const dc = await startMicrosoftDeviceCode();
    expect(dc.user_code).toMatch(/^CODE-/);
    expect(cancelMicrosoftSignIn()).toBe(true);
    await wait(400);
    expect(existsSync(tokenFile())).toBe(false);
    expect(asked).toEqual([]);
    expect(cancelMicrosoftSignIn()).toBe(false); // nothing waiting now
  });
  it('a new code cancels the old one: only the newest can connect', async () => {
    await startMicrosoftDeviceCode();
    const first = `dc-${n}`;
    await startMicrosoftDeviceCode();
    const second = `dc-${n}`;
    await wait(400);
    expect(asked).not.toContain(first);
    expect(asked).toContain(second);
    expect(existsSync(tokenFile())).toBe(true);
    rmSync(tokenFile(), { force: true });
  });
});

describe('the browser sign-in listener', () => {
  it('Cancel closes it and the attempt fails, so nothing comes back later', async () => {
    const port = 7900 + Math.floor(Math.random() * 90);
    const c = catchOAuthCode({ port, state: 'st', label: 'Google' });
    await c.ready;
    expect(cancelOAuthCatch(port)).toBe(true);
    await expect(c.code).rejects.toThrow(/cancelled/);
    await expect(fetch(`http://127.0.0.1:${port}/oauth?state=st&code=x`)).rejects.toThrow();
    expect(cancelOAuthCatch(port)).toBe(false);
  });
});

describe('Tailscale as it was at the start', () => {
  const req = (host: string) => ({ headers: { host } }) as unknown as IncomingMessage;
  it('the name is made the way the entrypoint makes it', () => {
    expect(tailscaleName('Barn_Helper!')).toBe('barnhelper');
    expect(tailscaleName('')).toBe('mwa');
    expect(tailscaleName(undefined)).toBe('mwa');
    expect(tailscaleName('x'.repeat(60))).toHaveLength(40);
  });
  it('saving or removing the key or name in Settings changes the Host check only after a restart', () => {
    process.env.TAILSCALE_AUTHKEY = 'tskey-auth-x'; process.env.TAILSCALE_HOSTNAME = 'Barn';
    process.env.MWA_RELAYED = '';
    captureTailscaleAtStart();
    expect(hostAllowed(req('barn.tail1a2b.ts.net'))).toBe(true);
    // removed in Settings: still served by tailscale until the restart
    delete process.env.TAILSCALE_AUTHKEY; delete process.env.TAILSCALE_HOSTNAME;
    expect(hostAllowed(req('barn.tail1a2b.ts.net'))).toBe(true);
    expect(relayedMode(process.env, () => false)).toBe(true);
    // a name saved now isn't the one Tailscale joined with
    process.env.TAILSCALE_AUTHKEY = 'tskey-auth-x'; process.env.TAILSCALE_HOSTNAME = 'other';
    expect(hostAllowed(req('other.tail1a2b.ts.net'))).toBe(false);
    expect(hostAllowed(req('evil.example'))).toBe(false);
    // the next start
    captureTailscaleAtStart();
    expect(hostAllowed(req('other.tail1a2b.ts.net'))).toBe(true);
    expect(hostAllowed(req('barn.tail1a2b.ts.net'))).toBe(false);
    // an explicit env (as the older tests pass) is read as given
    expect(hostAllowed(req('mwa.t.ts.net'), { TAILSCALE_AUTHKEY: 'k' })).toBe(true);
    resetTailscaleAtStart();
  });
});
