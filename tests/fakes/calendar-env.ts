/**
 * Point MWA's real Google and Outlook connectors at the fakes (v2 build, slice A7 tests): OAuth client ids, token
 * files in a temp folder, and the test-only base-URL variables (MWA_GOOGLE_API_ROOT, MWA_GOOGLE_TOKEN_URL,
 * MWA_GRAPH_BASE, MWA_MS_AUTH_BASE). Nothing here talks to Google or Microsoft.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeGoogleCalendar } from './google-calendar.js';
import { FakeGraphCalendar } from './graph-calendar.js';

const KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MWA_GOOGLE_TOKEN', 'MWA_GOOGLE_API_ROOT', 'MWA_GOOGLE_TOKEN_URL',
  'MICROSOFT_CLIENT_ID', 'MWA_MS_TOKEN', 'MWA_GRAPH_BASE', 'MWA_MS_AUTH_BASE', 'MWA_TZ', 'MWA_V2_DRAFTS', 'MWA_CALENDAR_SYNC'];

export interface CalendarFakes {
  google: FakeGoogleCalendar; graph: FakeGraphCalendar; dir: string;
  /** write the Google token file: expired → the client refreshes against the fake first */
  googleToken(o?: { expired?: boolean }): void;
  outlookToken(o?: { expired?: boolean }): void;
  disconnect(which: 'google' | 'outlook'): void;
  done(): Promise<void>;
}

export async function calendarFakes(): Promise<CalendarFakes> {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const google = await new FakeGoogleCalendar().start();
  const graph = await new FakeGraphCalendar().start();
  const dir = mkdtempSync(join(tmpdir(), 'mwa-a7-'));
  const gTok = join(dir, 'google-token.json'), mTok = join(dir, 'microsoft-token.json');
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: 'fake-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fake-secret', MWA_GOOGLE_TOKEN: gTok,
    MWA_GOOGLE_API_ROOT: `${google.base}/`, MWA_GOOGLE_TOKEN_URL: `${google.base}/token`,
    MICROSOFT_CLIENT_ID: 'fake-ms-client', MWA_MS_TOKEN: mTok, MWA_GRAPH_BASE: `${graph.base}/v1.0`, MWA_MS_AUTH_BASE: `${graph.base}/auth`,
    MWA_TZ: 'America/New_York', MWA_CALENDAR_SYNC: '0',
  });
  delete process.env.MWA_V2_DRAFTS;
  const f: CalendarFakes = {
    google, graph, dir,
    googleToken: (o = {}) => writeFileSync(gTok, JSON.stringify({
      access_token: google.accessToken, refresh_token: 'google-refresh', token_type: 'Bearer',
      scope: 'https://www.googleapis.com/auth/calendar.events', expiry_date: o.expired ? Date.now() - 60_000 : Date.now() + 3_600_000,
    })),
    outlookToken: (o = {}) => writeFileSync(mTok, JSON.stringify({
      access_token: graph.accessToken, refresh_token: 'ms-refresh', scope: 'offline_access Calendars.ReadWrite',
      expires_at: o.expired ? Date.now() - 60_000 : Date.now() + 3_600_000,
    })),
    disconnect: (which) => rmSync(which === 'google' ? gTok : mTok, { force: true }),
    done: async () => {
      await google.close(); await graph.close();
      rmSync(dir, { recursive: true, force: true });
      for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    },
  };
  f.googleToken(); f.outlookToken();
  return f;
}
