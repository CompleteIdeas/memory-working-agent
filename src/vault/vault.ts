/**
 * BL-63 — the vault. Robert, 2026-10-20: "the agent asked for information in the chat and then a prompt came up in the
 * chat and you could provide your username and password or provide a key ... store it direct into a vault on the
 * agent's VM, to be recalled safely without prompting within the chat."
 *
 * A person saves a login or a key through a setup card (src/connect/setup.ts); it is stored here, encrypted. The model
 * only ever sees entry names, their site and their field names. A tool that needs a value takes a reference,
 * {{vault:<entry>.<field>}}, and MWA puts the value in at the moment of use — and only for a request to the entry's own
 * site, so a page or an email cannot get the agent to send a saved password somewhere else. Any saved value that comes
 * back in a tool's output is masked before the model sees it.
 *
 * Encryption is AES-256-GCM. The key is MWA_VAULT_KEY (64 hex characters) when the deployment sets one — keep it in
 * the host's secret store — or else a key file created beside the vault (mode 600). With the key file, the vault keeps
 * values out of the conversation, logs, memory and backups of the vault file alone; it does not protect against
 * someone who can read the whole data folder. MWA_VAULT_KEY kept apart from the data volume does.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { vaultPath as vaultFile } from '../paths.js';

export interface VaultEntryView { name: string; site?: string; fields: string[]; savedAt: number }
interface StoredEntry { site?: string; fields: Record<string, string>; savedAt: number }

const vaultPath = () => vaultFile();

function vaultKey(): Buffer {
  const env = (process.env.MWA_VAULT_KEY ?? '').trim();
  if (env) {
    if (!/^[0-9a-f]{64}$/i.test(env)) throw new Error('MWA_VAULT_KEY must be 64 hex characters (32 bytes)');
    return Buffer.from(env, 'hex');
  }
  const kp = `${vaultPath()}.key`;
  if (existsSync(kp)) return Buffer.from(readFileSync(kp, 'utf8').trim(), 'hex');
  mkdirSync(dirname(kp), { recursive: true });
  const k = randomBytes(32);
  writeFileSync(kp, k.toString('hex'), { mode: 0o600 });
  return k;
}

function seal(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
function open(sealed: string, key: Buffer): string {
  const [v, iv, tag, ct] = sealed.split(':');
  if (v !== 'v1') throw new Error('unknown vault format');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

function load(): Record<string, StoredEntry> {
  const p = vaultPath();
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
}
function store(all: Record<string, StoredEntry>): void {
  const p = vaultPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(`${p}.tmp`, JSON.stringify(all, null, 2), { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
  plainCache = null;
}

// Decrypted values, for masking tool output. Rebuilt after every save or delete.
let plainCache: { entry: string; field: string; value: string }[] | null = null;
function plainValues(): { entry: string; field: string; value: string }[] {
  if (plainCache) return plainCache;
  const all = load();
  if (!Object.keys(all).length) return (plainCache = []);
  const key = vaultKey();
  const out: { entry: string; field: string; value: string }[] = [];
  for (const [entry, e] of Object.entries(all)) for (const [field, sealed] of Object.entries(e.fields)) {
    try { out.push({ entry, field, value: open(sealed, key) }); } catch { /* a value this key can't open is skipped */ }
  }
  return (plainCache = out.sort((a, b) => b.value.length - a.value.length));
}

/** An entry name as people say it, kept simple so a reference is easy to write and to read. */
export function vaultName(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}
/** The host a site string names ("https://portal.useventing.com/login" → "portal.useventing.com"). */
export function siteHost(site: string): string | undefined {
  const s = site.trim();
  if (!s) return undefined;
  try { return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase(); } catch { return undefined; }
}

export function vaultList(): VaultEntryView[] {
  return Object.entries(load()).map(([name, e]) => ({ name, site: e.site, fields: Object.keys(e.fields), savedAt: e.savedAt }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Saves (or replaces) an entry. Field names are kept as given, lower-cased; values are encrypted. */
export function vaultSave(name: string, site: string | undefined, values: Record<string, string>): string {
  const n = vaultName(name);
  if (!n) throw new Error('an entry needs a name');
  const key = vaultKey();
  const fields: Record<string, string> = {};
  for (const [f, v] of Object.entries(values)) if (v) fields[vaultName(f) || 'value'] = seal(v, key);
  if (!Object.keys(fields).length) throw new Error('nothing to save');
  const all = load();
  all[n] = { site: site ? siteHost(site) : undefined, fields, savedAt: Date.now() };
  store(all);
  return n;
}

export function vaultForget(name: string): boolean {
  const all = load();
  const n = vaultName(name);
  if (!all[n]) return false;
  delete all[n];
  store(all);
  return true;
}

const REF = /\{\{\s*vault:([a-z0-9-]+)\.([a-z0-9-]+)\s*\}\}/gi;

/** True when the text holds at least one {{vault:entry.field}} reference. */
export function hasVaultRef(text: string): boolean { REF.lastIndex = 0; return REF.test(text); }

/**
 * Puts saved values into a request bound for `targetUrl`. Refuses — throws, nothing is sent — when an entry is saved
 * for another site, is unknown, or has no such field. An entry saved with no site can be sent anywhere the person's
 * own request goes; the card asks for a site so that is rare.
 */
export function resolveVaultRefs(text: string, targetUrl: string): string {
  if (!hasVaultRef(text)) return text;
  const host = siteHost(targetUrl);
  const all = load();
  const key = vaultKey();
  return text.replace(REF, (_m, entry: string, field: string) => {
    const e = all[entry.toLowerCase()];
    if (!e) throw new Error(`no vault entry "${entry}" (vault_list shows what is saved)`);
    if (e.site && !(host && (host === e.site || host.endsWith(`.${e.site}`)))) throw new Error(`the vault entry "${entry}" is saved for ${e.site}, not ${host ?? 'this address'} — it is only ever sent to its own site`);
    const sealed = e.fields[field.toLowerCase()];
    if (!sealed) throw new Error(`the vault entry "${entry}" has no field "${field}" (it has: ${Object.keys(e.fields).join(', ')})`);
    return open(sealed, key);
  });
}

/** Masks every saved value in a tool's output, so nothing saved reaches the model or the logs that way. */
export function redactVault(text: string): string {
  if (!text) return text;
  let out = text;
  for (const p of plainValues()) if (p.value.length >= 4 && out.includes(p.value)) out = out.split(p.value).join(`‹vault:${p.entry}.${p.field}›`);
  return out;
}

/** For tests. */
export function _resetVaultCache(): void { plainCache = null; }
