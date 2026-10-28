/**
 * BL-62 — connect an account by asking. Robert, 2026-10-20: "having the ability to talk to the agent and having it
 * walk through the actions of connecting accounts as opposed to having to look up numbers and stuff, and you would
 * just get prompted for what you are needed."
 *
 * The agent starts a connection (connect_account). What the service needs is fixed here, per service — the model
 * names a service, never a setting, so a planted instruction can't make MWA ask for, or overwrite, anything else.
 * A secret never passes through the conversation: the agent opens a setup card, the person types the value into it,
 * the server checks it against the service itself and saves it to .env. The model only ever hears how it went.
 * Outlook needs no secret at all when an app id is available: it is a device code the person enters at Microsoft.
 */
import { randomBytes } from 'node:crypto';
import { vaultSave, vaultName } from '../vault/vault.js';
import { listConnectors, enabledConnectorIds, enableConnector, missingSecrets } from '../connectors/registry.js';

export interface SetupField { env: string; label: string; help?: string; secret: boolean; optional?: boolean }
export interface CheckResult { ok: boolean; message: string }

export interface SetupService {
  id: string;
  name: string;
  aliases: string[];
  /** what the person does, in a few plain steps, before they fill the card */
  howTo: string;
  fields: SetupField[];
  connected: () => boolean;
  /** checks the values against the service itself before anything is saved */
  check?: (v: Record<string, string>) => Promise<CheckResult>;
  /** runs once the values are saved (turn a connector on, start a sign-in) */
  after?: (v: Record<string, string>) => Promise<CheckResult>;
  /** a connection that needs no card (Outlook with an app id): starts it and says what the person does next */
  start?: () => Promise<CheckResult>;
}

/** The live hooks a service uses; injectable so tests run without the network. */
export interface SetupDeps {
  save: (values: Record<string, string>) => void;
  gmailConnected: () => boolean;
  checkGmail: (user: string, pass: string) => Promise<CheckResult>;
  outlookConnected: () => boolean;
  outlookAppReady: () => boolean;
  startOutlookDeviceCode: () => Promise<{ user_code: string; verification_uri: string; expires_in: number }>;
  telegramConnected: () => boolean;
  checkTelegram: (token: string) => Promise<CheckResult>;
}

let deps: SetupDeps | null = null;
export function setSetupDeps(d: SetupDeps): void { deps = d; }
function need(): SetupDeps {
  if (!deps) throw new Error('setup is not wired in this process');
  return deps;
}

async function outlookDeviceCode(): Promise<CheckResult> {
  const dc = await need().startOutlookDeviceCode();
  const mins = Math.max(1, Math.round(dc.expires_in / 60));
  return { ok: true, message: `Go to ${dc.verification_uri} and enter the code ${dc.user_code} (it works for ${mins} minutes), then sign in with the account you want me to use. I'll be connected as soon as you finish — nothing to paste here.` };
}

export function setupServices(): SetupService[] {
  const builtIn: SetupService[] = [
    {
      id: 'gmail', name: 'Gmail', aliases: ['gmail', 'google mail', 'google email', 'googlemail'],
      howTo: [
        'Gmail lets me in with an app password (it reads and drafts mail; it can\'t change your Google account):',
        '1. 2-Step Verification has to be on for the account (Google Account → Security).',
        '2. Open https://myaccount.google.com/apppasswords, type a name like "MWA", and press Create.',
        '3. Put your Gmail address and the 16-letter password Google shows into the setup card.',
      ].join('\n'),
      fields: [
        { env: 'MWA_GMAIL_USER', label: 'Gmail address', secret: false },
        { env: 'MWA_GMAIL_APP_PASSWORD', label: 'App password (16 letters)', help: 'from myaccount.google.com/apppasswords', secret: true },
      ],
      connected: () => need().gmailConnected(),
      check: (v) => need().checkGmail(v.MWA_GMAIL_USER.trim(), v.MWA_GMAIL_APP_PASSWORD.replace(/\s+/g, '')),
    },
    {
      id: 'outlook', name: 'Outlook (Microsoft 365)', aliases: ['outlook', 'microsoft', 'microsoft 365', 'office 365', 'o365', 'exchange', 'hotmail'],
      howTo: [
        'Outlook needs an app registration this copy of MWA can sign in through, and none is set up yet. Whoever runs your Microsoft 365 can make one in a few minutes:',
        '1. Entra admin center → App registrations → New registration (any name; "Accounts in this organizational directory").',
        '2. Authentication → "Allow public client flows" = Yes.',
        '3. API permissions → Microsoft Graph, delegated: User.Read, Mail.ReadWrite, Calendars.ReadWrite, offline_access (MWA drafts mail; it never sends), then "Grant admin consent".',
        '4. Put the "Application (client) ID" and "Directory (tenant) ID" into the setup card. Neither is a secret.',
        'Then I\'ll give you a short code to sign in with.',
      ].join('\n'),
      fields: [
        { env: 'MICROSOFT_CLIENT_ID', label: 'Application (client) ID', help: 'a GUID from the app registration\'s Overview page', secret: false },
        { env: 'MICROSOFT_TENANT', label: 'Directory (tenant) ID', help: 'also on the Overview page; leave empty for personal accounts', secret: false, optional: true },
      ],
      connected: () => need().outlookConnected(),
      check: async (v) => {
        const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!guid.test(v.MICROSOFT_CLIENT_ID.trim())) return { ok: false, message: 'That doesn\'t look like an application ID — it is a GUID like 1b2c3d4e-…, on the app registration\'s Overview page.' };
        if (v.MICROSOFT_TENANT && !guid.test(v.MICROSOFT_TENANT.trim()) && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v.MICROSOFT_TENANT.trim())) return { ok: false, message: 'The tenant ID is a GUID (or your domain, like useventing.com).' };
        return { ok: true, message: 'Looks right.' };
      },
      after: () => outlookDeviceCode(),
      start: async () => (need().outlookAppReady() ? outlookDeviceCode() : { ok: false, message: 'no app' }),
    },
    {
      id: 'telegram', name: 'Telegram', aliases: ['telegram', 'telegram bot'],
      howTo: [
        'Telegram talks to me through a bot that only you control:',
        '1. In Telegram, open @BotFather and send /newbot. Give it a name, then a username ending in "bot".',
        '2. BotFather replies with a token (numbers, a colon, then letters). Put it into the setup card.',
      ].join('\n'),
      fields: [{ env: 'TELEGRAM_BOT_TOKEN', label: 'Bot token from @BotFather', secret: true }],
      connected: () => need().telegramConnected(),
      check: (v) => need().checkTelegram(v.TELEGRAM_BOT_TOKEN.trim()),
    },
  ];
  // The curated library: a connector whose key isn't set yet is set up the same way.
  const library: SetupService[] = listConnectors().filter((c) => (c.secrets ?? []).some((s) => !s.optional)).map((c) => ({
    id: c.id, name: c.name, aliases: [c.id, c.name.toLowerCase()],
    howTo: (c.secrets ?? []).filter((s) => !s.optional).map((s) => `${s.label}${s.help ? ` — ${s.help}` : ''}`).join('\n'),
    fields: (c.secrets ?? []).map((s) => ({ env: s.env, label: s.label, help: s.help, secret: true, optional: s.optional })),
    connected: () => enabledConnectorIds().includes(c.id) && missingSecrets(c).length === 0,
    after: async () => enableConnector(c.id),
  }));
  return [...builtIn, ...library];
}

/** The service a person's word names: an id, a name or a common alias. */
export function findService(name: string): SetupService | undefined {
  const n = name.trim().toLowerCase();
  if (!n) return undefined;
  const all = setupServices();
  // "email" alone names no service: Gmail and Outlook are both email, so the agent asks which.
  return all.find((s) => s.id === n) ?? all.find((s) => s.aliases.includes(n))
    ?? (n.length >= 4 ? all.find((s) => s.aliases.some((a) => n.includes(a) || (a.length >= 4 && a.includes(n)))) : undefined);
}

export type SetupStatus = 'waiting' | 'done' | 'failed' | 'cancelled' | 'expired';
export interface SetupRequest {
  id: string; service: string; name: string; howTo: string; fields: SetupField[];
  status: SetupStatus; message: string; session?: string; createdAt: number; expiresAt: number;
  /** BL-63: a card that saves to the vault (an entry and the site it is for), not to the app's settings */
  vault?: { name: string; site?: string };
}

const TTL_MS = 30 * 60_000;
const requests = new Map<string, SetupRequest>();
/** v2 S6: told when a card opens or changes (serve.ts records it as an app.db event, so the new app's stream says so). */
let onChange: (id: string) => void = () => {};
export function setSetupChangeListener(fn: ((id: string) => void) | null): void { onChange = fn ?? (() => {}); }
const changed = (id: string) => { try { onChange(id); } catch { /* best effort */ } };

function sweep(now = Date.now()): void {
  for (const r of requests.values()) if (r.status === 'waiting' && r.expiresAt <= now) { r.status = 'expired'; r.message = 'The setup card expired before it was filled in.'; changed(r.id); }
}

/** Opens a setup card for a service (one waiting card per service: asking again shows the same card). */
export function openSetupRequest(svc: SetupService, session?: string): SetupRequest {
  sweep();
  const open = [...requests.values()].find((r) => r.service === svc.id && r.status === 'waiting');
  if (open) return open;
  const now = Date.now();
  const r: SetupRequest = { id: `setup_${randomBytes(6).toString('hex')}`, service: svc.id, name: svc.name, howTo: svc.howTo, fields: svc.fields, status: 'waiting', message: '', session, createdAt: now, expiresAt: now + TTL_MS };
  requests.set(r.id, r);
  changed(r.id);
  return r;
}

/** Setup cards, newest first: waiting ones and the recently finished (what the person and the agent see). */
/**
 * BL-63: a card that saves a login or a key to the vault. The agent names the entry, its site and what to ask for
 * ("username", "password"); the person types the values into the card. Usernames and emails show as they are typed;
 * everything else is masked. One waiting card per entry.
 */
export function openVaultRequest(name: string, site: string | undefined, fieldLabels: string[], session?: string): SetupRequest {
  sweep();
  const n = vaultName(name);
  const open = [...requests.values()].find((r) => r.vault?.name === n && r.status === 'waiting');
  if (open) return open;
  const labels = (fieldLabels.length ? fieldLabels : ['password']).slice(0, 6);
  const fields: SetupField[] = labels.map((l) => ({ env: vaultName(l) || 'value', label: l.trim().slice(0, 60) || 'Value', secret: !/^(user ?name|user|login|e-?mail|account|email address|username or email)$/i.test(l.trim()) }));
  const now = Date.now();
  const where = site ? ` for ${site}` : '';
  const r: SetupRequest = { id: `setup_${randomBytes(6).toString('hex')}`, service: `vault:${n}`, name: `Vault · ${n}`, howTo: `Saved encrypted on this computer as "${n}"${where}. I can use it without seeing it, and only on that site.`, fields, status: 'waiting', message: '', session, createdAt: now, expiresAt: now + TTL_MS, vault: { name: n, site } };
  requests.set(r.id, r);
  changed(r.id);
  return r;
}

export function listSetupRequests(): SetupRequest[] {
  sweep();
  return [...requests.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
}

export function getSetupRequest(id: string): SetupRequest | undefined { sweep(); return requests.get(id); }

export function cancelSetupRequest(id: string): boolean {
  const r = requests.get(id);
  if (!r || r.status !== 'waiting') return false;
  r.status = 'cancelled'; r.message = 'You closed the setup card.';
  changed(r.id);
  return true;
}

/**
 * The person filled a card. Only that card's fields are taken (anything else in the form is ignored), the values are
 * checked against the service before they are saved, and nothing typed is ever put in a message.
 */
export async function submitSetupRequest(id: string, values: Record<string, unknown>): Promise<CheckResult> {
  sweep();
  const r = requests.get(id);
  if (!r) return { ok: false, message: 'That setup card is gone — ask me to connect it again.' };
  if (r.status !== 'waiting') return { ok: false, message: `That setup card is already ${r.status}.` };
  const v: Record<string, string> = {};
  for (const f of r.fields) {
    const val = String(values[f.env] ?? '').trim();
    if (!val && !f.optional) return { ok: false, message: `${f.label} is needed.` };
    if (val) v[f.env] = val;
  }
  if (r.vault) {
    try { const n = vaultSave(r.vault.name, r.vault.site, v); r.status = 'done'; r.message = `Saved to the vault as "${n}"${r.vault.site ? ` for ${r.vault.site}` : ''}.`; changed(r.id); }
    catch (e) { return { ok: false, message: `Couldn't save it: ${(e as Error).message.slice(0, 120)}` }; }
    return { ok: true, message: r.message };
  }
  const svc = setupServices().find((s) => s.id === r.service);
  if (!svc) return { ok: false, message: 'That service is no longer available.' };
  if (svc.check) {
    let c: CheckResult;
    try { c = await svc.check(v); } catch (e) { c = { ok: false, message: `I couldn't check it: ${(e as Error).message.slice(0, 120)}` }; }
    if (!c.ok) return c; // the card stays open: fix it and try again
  }
  need().save(v);
  let out: CheckResult = { ok: true, message: `${svc.name} is connected.` };
  if (svc.after) {
    try { out = await svc.after(v); } catch (e) { out = { ok: false, message: `Saved, but the next step failed: ${(e as Error).message.slice(0, 120)}` }; }
    if (out.ok && !/connect|code/i.test(out.message)) out = { ok: true, message: `${svc.name} is connected. ${out.message}` };
  }
  r.status = out.ok ? 'done' : 'failed';
  r.message = out.message;
  changed(r.id);
  return out;
}

/** What is connected and what isn't, one line each (no values, ever). */
export function connectionSummary(): string {
  const lines = setupServices().map((s) => {
    let on = false;
    try { on = s.connected(); } catch { /* not wired */ }
    return `• ${s.name} (${s.id}): ${on ? 'connected' : 'not connected'}`;
  });
  const waiting = listSetupRequests().filter((r) => r.status === 'waiting').map((r) => `• a setup card for ${r.name} is waiting for you`);
  return [...lines, ...waiting].join('\n');
}

/** For tests. */
export function _resetSetupRequests(): void { requests.clear(); }
