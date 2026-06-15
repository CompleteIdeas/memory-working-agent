/**
 * `mwa connect` — guided, near-turnkey bring-your-own email setup (no broker).
 *
 * Automates as much of the per-provider OAuth-app creation as each cloud's CLI allows,
 * then hands off to the existing loopback connect:
 *   Outlook (Azure)  — `az ad app create` + Graph delegated permissions → fully automated.
 *   Gmail (Google)   — `gcloud` creates the project + enables APIs; the OAuth *client*
 *                      can't be created programmatically, so we deep-link the console and
 *                      capture the pasted Client ID/secret.
 * Falls back to printed manual steps when the CLI isn't installed. See docs/connect-email.md.
 */
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { upsertEnv } from '../wizard.js';
import { connectGmail } from './google.js';
import { connectMicrosoft } from './microsoft.js';

type Log = (m: string) => void;

const WIN = process.platform === 'win32';
function has(cmd: string): boolean {
  try { return spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: WIN }).status === 0; } catch { return false; }
}
function run(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: WIN });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function prompt(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

const MS_REDIRECT = 'http://localhost:7798/oauth';
// Microsoft Graph (resource appId) + well-known DELEGATED permission ids.
const GRAPH_APP = '00000003-0000-0000-c000-000000000000';
const GRAPH_DELEGATED = {
  'offline_access': '7427e0e9-2fba-42fe-b0c0-848c9e6a8182',
  'User.Read': 'e1fe6dd8-ba31-4d61-89e7-88639da4683d',
  'Mail.ReadWrite': 'e2a3a72e-5f79-4c64-b1b1-878b674786c9',
  'Calendars.ReadWrite': '1ec239c2-d7c9-4623-a91a-a9775856bb36',
};

function manualOutlook(onLog: Log): void {
  onLog('\nSet up Outlook by hand (5 steps):');
  onLog('  1. https://entra.microsoft.com → App registrations → New registration');
  onLog('  2. Supported accounts: "any org directory and personal Microsoft accounts"');
  onLog(`  3. Add a redirect URI — platform "Mobile & desktop applications": ${MS_REDIRECT}`);
  onLog('  4. API permissions → Microsoft Graph (delegated): Mail.ReadWrite, Calendars.ReadWrite, User.Read, offline_access');
  onLog('  5. Copy the Application (client) ID, then re-run: mwa connect outlook');
}

function manualGmail(onLog: Log): void {
  onLog('\nSet up Gmail by hand (5 steps):');
  onLog('  1. https://console.cloud.google.com/projectcreate → create/pick a project');
  onLog('  2. Enable the Gmail API and Google Calendar API');
  onLog('  3. Credentials → Create OAuth client ID → application type "Desktop app"');
  onLog('  4. Consent screen: keep it in Testing, add your own email as a test user');
  onLog('  5. Copy the Client ID + secret, then re-run: mwa connect gmail');
}

/** Outlook: automate the Azure app registration via `az` when available, else guide. */
export async function connectOutlookGuided(onLog: Log = (m) => console.log(m)): Promise<void> {
  if (process.env.MICROSOFT_CLIENT_ID) { onLog('Microsoft app already configured — signing you in…'); return connectMicrosoft(onLog); }
  if (!has('az')) { onLog('Azure CLI (`az`) not found — I\'ll guide you instead.'); manualOutlook(onLog); return; }

  onLog('Found the Azure CLI.');
  if (!run('az', ['account', 'show']).ok) { onLog('You\'re not signed in. Run `az login` first, then re-run `mwa connect outlook`.'); return; }
  const go = await prompt('Create an Azure app registration for MWA now? [Y/n] ');
  if (!/^(y|yes|)$/i.test(go)) { manualOutlook(onLog); return; }

  onLog('Creating app registration…');
  const create = run('az', ['ad', 'app', 'create', '--display-name', 'MWA (Memory Working Agent)', '--public-client-redirect-uris', MS_REDIRECT, '--sign-in-audience', 'AzureADandPersonalMicrosoftAccount', '-o', 'json']);
  if (!create.ok) { onLog(`az ad app create failed: ${create.stderr.slice(0, 200)}`); manualOutlook(onLog); return; }
  let appId = '';
  try { appId = JSON.parse(create.stdout).appId; } catch { /* */ }
  if (!appId) { onLog('Could not read the new app id from az output.'); manualOutlook(onLog); return; }

  onLog(`Created app ${appId}. Adding Microsoft Graph permissions…`);
  const perms = Object.values(GRAPH_DELEGATED).map((id) => `${id}=Scope`);
  const addPerm = run('az', ['ad', 'app', 'permission', 'add', '--id', appId, '--api', GRAPH_APP, '--api-permissions', ...perms]);
  if (!addPerm.ok) onLog(`(note) couldn't pre-add permissions automatically (${addPerm.stderr.slice(0, 120)}); you'll just approve them on the consent screen.`);

  upsertEnv({ MICROSOFT_CLIENT_ID: appId });
  onLog('Saved. Now signing you in (approve the scopes in the browser)…');
  return connectMicrosoft(onLog);
}

/** Gmail: automate project + API enable via `gcloud` when available; the OAuth client is
 *  created in the console (not scriptable) and the credentials pasted in. */
export async function connectGmailGuided(onLog: Log = (m) => console.log(m)): Promise<void> {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) { onLog('Google app already configured — signing you in…'); return connectGmail(onLog); }

  if (has('gcloud') && run('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']).ok) {
    const go = await prompt('Use gcloud to create a project and enable the Gmail + Calendar APIs? [Y/n] ');
    if (/^(y|yes|)$/i.test(go)) {
      const proj = `mwa-${Date.now().toString(36)}`;
      onLog(`Creating project ${proj}…`);
      if (run('gcloud', ['projects', 'create', proj, '--name', 'MWA']).ok) {
        run('gcloud', ['config', 'set', 'project', proj]);
        onLog('Enabling Gmail + Calendar APIs…');
        run('gcloud', ['services', 'enable', 'gmail.googleapis.com', 'calendar-json.googleapis.com', '--project', proj]);
      } else { onLog('(note) project create failed — continue in the console.'); }
    }
  } else { onLog('Google Cloud CLI (`gcloud`) not found or not signed in — that\'s fine, do the next bit in the console.'); }

  // The OAuth *client* can't be created programmatically — guide + capture.
  onLog('\nIn the console, create an OAuth client (application type: Desktop app):');
  onLog('  https://console.cloud.google.com/apis/credentials');
  onLog('  (Keep the consent screen in Testing and add your own email as a test user.)');
  const id = await prompt('Paste the Client ID: ');
  const secret = await prompt('Paste the Client secret: ');
  if (!id || !secret) { onLog('Need both the Client ID and secret. Re-run `mwa connect gmail` when you have them.'); return; }
  upsertEnv({ GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret });
  onLog('Saved. Now signing you in (approve access in the browser)…');
  return connectGmail(onLog);
}
