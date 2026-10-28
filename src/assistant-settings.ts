/**
 * The assistant's own settings (v2 build, slice S2): its AI brain (provider, key, model), the image model, what it can
 * touch (the access level and the granted folders) and how it works with you (Guided or Direct). ONE implementation
 * that both the classic page (serve.ts POST /api/save, which: 'provider' | 'image-model' | 'access' | 'style') and the
 * v1 routes (src/api/routes/assistant.ts) call, so the two can never drift apart.
 *
 * What changed from the code that sat in serve.ts (both paths get it):
 *   - inputs are checked first: a provider MWA knows, a model name on one line, a key on one line, a base URL only for
 *     Azure or Ollama, an access level and a style from their lists (an unknown one used to fall back silently);
 *   - a NEW folder must be an absolute path to an existing folder on this computer, not a whole drive, not a network
 *     share, not a folder that holds the helper's .env or mwa.config.json, and not its data (memory, vault, sign-in
 *     tokens, logs, browser profiles) or anything inside or around it, compared where the folder really is (links
 *     and junctions followed; Windows without case): the file tools have no other guard for those, so granting one
 *     would hand the assistant its own secrets. Folders granted before keep their old rule (kept while they exist);
 *   - a base URL may not point at a cloud metadata service or a link-local address;
 *   - with no key typed, the live check uses the saved key (it is not written again);
 *   - a check that fails never echoes the key back (some providers quote part of it in their error).
 *
 * The live check, the model list and .env writes go through setAssistantDeps so tests never call a provider or touch
 * the real .env.
 */
import { existsSync, readFileSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { resolve, dirname, isAbsolute, join, parse as parsePath, sep } from 'node:path';
import { configPath, loadConfig, setStyle, INTERACTION_STYLES, type InteractionStyle, type MwaConfig } from './config.js';
import { listModels, PROVIDERS } from './provider.js';
import { testProvider, envKeyForProvider, upsertEnv } from './wizard.js';
import { accessPolicy, setAccess, ACCESS_PRESETS, type AccessPreset } from './tools/access.js';
import { externalInstallState } from './installer/policy.js';
import { injectionNote } from './model-safety.js';
import { dataDir, dbFile, vaultPath, browserDir, runLogPath, notifyPath, mwaLogPath, installLogPath, connectorTokenPath } from './paths.js';

export interface AssistantDeps {
  testProvider: (provider: string, model: string, key?: string, baseUrl?: string) => Promise<{ ok: boolean; message: string }>;
  listModels: (provider: string, opts: { key?: string; baseUrl?: string; kind?: 'chat' | 'image' }) => Promise<{ id: string; name?: string }[]>;
  /** write keys to .env and this process (wizard.ts upsertEnv) */
  saveEnv: (kv: Record<string, string>) => void;
  hasEnv: (name: string) => boolean;
}
const realDeps: AssistantDeps = {
  testProvider: (p, m, k, b) => testProvider(p, m, k, b),
  listModels: (p, o) => listModels(p, o),
  saveEnv: (kv) => upsertEnv(kv),
  hasEnv: (n) => !!process.env[n],
};
let deps: AssistantDeps = realDeps;
export function setAssistantDeps(d: Partial<AssistantDeps> | null): void { deps = d ? { ...realDeps, ...d } : realDeps; }

export type Outcome = { ok: true; message: string } | { ok: false; code: string; message: string };
const fail = (code: string, message: string): Outcome => ({ ok: false, code, message });

// ── providers ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The providers the settings offer (the classic page's list; Azure is accepted but needs its address, so it is not
 *  offered). `images`: it can have image models. */
export const PROVIDER_CHOICES: { id: string; label: string; keyless: boolean; images: boolean }[] = [
  { id: 'openrouter', label: 'OpenRouter (many models, one key)', keyless: false, images: true },
  { id: 'anthropic', label: 'Anthropic (Claude)', keyless: false, images: false },
  { id: 'openai', label: 'OpenAI', keyless: false, images: true },
  { id: 'gemini', label: 'Google Gemini', keyless: false, images: true },
  { id: 'ollama', label: 'Local (Ollama), no key', keyless: true, images: true },
];
const isProvider = (p: unknown): p is string => typeof p === 'string' && (PROVIDERS as readonly string[]).includes(p);
const LINE = /^[^\r\n\0]*$/;

export function parseSpec(spec: string): { provider: string; model: string } {
  const i = spec.indexOf(':');
  return { provider: i > 0 ? spec.slice(0, i) : '', model: i > 0 ? spec.slice(i + 1) : spec };
}

function readRaw(): any {
  let raw: any = {};
  try { if (existsSync(configPath())) raw = JSON.parse(readFileSync(configPath(), 'utf8')); } catch { /* */ }
  return raw;
}

/** The strong tier after picking provider:model as the brain. It stays Anthropic Sonnet ONLY when an Anthropic key is
 *  present; otherwise it mirrors the pick, so a single-provider setup (e.g. keyless Ollama) doesn't leave reason
 *  pointing at a provider with no key (which would break escalation and the scheduler). */
export function reasonAfter(provider: string, model: string, raw: any = readRaw()): string {
  const spec = `${provider}:${model}`;
  return (provider === 'anthropic' || process.env.ANTHROPIC_API_KEY)
    ? (provider === 'anthropic' ? spec : (raw.models?.reason || 'anthropic:claude-sonnet-4-6'))
    : spec;
}

/** Persist the chosen brain into mwa.config.json: the cheap tier becomes the pick, the strong tier per reasonAfter. */
export function setFetchModel(provider: string, model: string): void {
  const raw = readRaw();
  raw.models = raw.models ?? {};
  const reason = reasonAfter(provider, model, raw);
  raw.models.fetch = `${provider}:${model}`;
  raw.models.reason = reason;
  writeFileSync(configPath(), JSON.stringify(raw, null, 2) + '\n');
}

/** Set (or clear, when model is empty) the image-generation model in mwa.config.json. */
export function setImageModel(provider: string, model: string): void {
  const raw = readRaw();
  raw.models = raw.models ?? {};
  if (model) raw.models.image = `${provider}:${model}`; else delete raw.models.image;
  writeFileSync(configPath(), JSON.stringify(raw, null, 2) + '\n');
}

/** Would "add from npm" be available with provider:model as the brain? (The reviewer is models.installer, else the
 *  strong tier, which the pick may change.) */
export function npmAfterBrain(provider: string, model: string, cfg: MwaConfig = loadConfig(), raw: any = readRaw()): boolean {
  const next: MwaConfig = { ...cfg, models: { ...cfg.models, reason: reasonAfter(provider, model, raw) } };
  if (raw.models?.installer) next.models.installer = raw.models.installer; else delete next.models.installer;
  try { return externalInstallState(next).enabled; } catch { return false; }
}

/** Take a key (and anything shaped like one) out of a provider's message before it reaches a page. */
export function scrub(message: string, key?: string): string {
  let m = String(message ?? '');
  if (key && key.length >= 4) m = m.split(key).join('•••');
  return m
    .replace(/\b(sk|pk|rk|sess|key)[-_][A-Za-z0-9_*.\-]{6,}/gi, '•••')
    .replace(/\b(AIza)[A-Za-z0-9_\-]{10,}/g, '•••')
    .replace(/\b[A-Za-z0-9_\-]{32,}\b/g, '•••');
}

function checkKey(key: unknown): string | undefined | Outcome {
  if (key === undefined || key === null || key === '') return undefined;
  if (typeof key !== 'string' || key.length > 4096 || !LINE.test(key)) return fail('bad_key', 'That doesn’t look like an API key. Paste it again, on one line.');
  return key.trim() || undefined;
}
function checkModel(model: unknown): string | Outcome {
  if (typeof model !== 'string' || !model.trim()) return fail('bad_model', 'Pick a model first.');
  const m = model.trim();
  if (m.length > 200 || !LINE.test(m) || /\s/.test(m)) return fail('bad_model', 'That isn’t a model name. Load the models and pick one.');
  return m;
}
function checkBaseUrl(provider: string, baseUrl: unknown): string | undefined | Outcome {
  if (baseUrl === undefined || baseUrl === null || baseUrl === '') return undefined;
  if (provider !== 'azure' && provider !== 'ollama') return fail('bad_base_url', 'Only Azure and Ollama take an address.');
  if (typeof baseUrl !== 'string' || baseUrl.length > 500 || !/^https?:\/\/[^\s]+$/i.test(baseUrl)) return fail('bad_base_url', 'The address should start with http:// or https://.');
  let host = '';
  try { host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return fail('bad_base_url', 'That isn’t a web address.'); }
  if (isMetadataHost(host)) return fail('bad_base_url', 'That address is the cloud server’s own settings service, not an AI provider.');
  return baseUrl;
}

/** Cloud metadata services (the key to a server's cloud account) and link-local addresses: never an AI provider.
 *  localhost and private addresses stay allowed (Ollama usually runs on this computer or the local network). An IP
 *  written as one number or in hex (http://2852039166/) is refused too, as it can hide 169.254.169.254. */
export function isMetadataHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (/^169\.254\./.test(h)) return true; // IPv4 link-local, AWS/Azure/GCP/OCI metadata
  if (/^fe[89ab][0-9a-f]?:/.test(h)) return true; // IPv6 link-local
  if (/^fd00:ec2::254$/.test(h) || /^::ffff:(169\.254\.|a9fe:)/.test(h)) return true; // AWS IPv6, IPv4-mapped
  if (h === '100.100.100.200') return true; // Alibaba Cloud
  if (h === 'metadata' || h === 'metadata.google.internal' || h.endsWith('.metadata.google.internal') || h === 'instance-data' || h.startsWith('instance-data.')) return true;
  if (/^(0x[0-9a-f]+|\d+)$/.test(h)) return true; // a bare number or hex: an obfuscated IPv4
  if (/^0x|(^|\.)0x/.test(h) || /(^|\.)0\d/.test(h)) return true; // hex or octal parts (0xa9.0376.…)
  return false;
}
const isOutcome = (x: unknown): x is Outcome => !!x && typeof x === 'object' && 'ok' in (x as object);

// ── the brain ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The key (and Azure's address) the live check uses: the one typed now, else the one saved on the server. Only for
 *  the check: a saved key is never written again. */
export function credentialsForCheck(provider: string, typedKey?: string, typedBaseUrl?: string, env: NodeJS.ProcessEnv = process.env): { key?: string; baseUrl?: string } {
  const name = envKeyForProvider(provider);
  const key = typedKey || (name ? env[name] || undefined : undefined);
  const baseUrl = typedBaseUrl || (provider === 'azure' ? env.AZURE_GPT_BASE_URL || undefined : undefined);
  return { key, baseUrl };
}

export const brainFixed = () => !!process.env.MWA_MODEL;
export const imageFixed = () => !!process.env.MWA_MODEL_IMAGE;

/** Check provider:model live with the key (typed now, or the saved one), then save the key and make it the brain. */
export async function saveBrain(b: { provider?: unknown; model?: unknown; key?: unknown; baseUrl?: unknown }): Promise<Outcome> {
  if (!isProvider(b.provider)) return fail('bad_provider', 'Pick one of the AI providers in the list.');
  const provider = b.provider;
  const model = checkModel(b.model); if (isOutcome(model)) return model;
  const key = checkKey(b.key); if (isOutcome(key)) return key;
  const baseUrl = checkBaseUrl(provider, b.baseUrl); if (isOutcome(baseUrl)) return baseUrl;
  if (brainFixed()) return fail('fixed', 'The server’s MWA_MODEL setting chooses the model, and it wins over a choice here. Change it there.');
  let r: { ok: boolean; message: string };
  // review of S2: with no key typed, check with the saved one (it is not saved again); without this, changing only the
  // model always failed "a key is required for this provider", on the classic page too
  const check = credentialsForCheck(provider, key, baseUrl);
  try { r = await deps.testProvider(provider, model, check.key, check.baseUrl); } catch (e) { r = { ok: false, message: `couldn’t check it: ${(e as Error).message.slice(0, 120)}` }; }
  if (!r.ok) return fail('check_failed', scrub(scrub(r.message, key), check.key));
  const envKey = envKeyForProvider(provider);
  const kv: Record<string, string> = {};
  if (envKey && key) kv[envKey] = key;
  if (provider === 'azure') { if (baseUrl) kv.AZURE_GPT_BASE_URL = baseUrl; kv.AZURE_GPT_DEPLOYMENT = model; }
  if (provider === 'ollama' && baseUrl) kv.OLLAMA_BASE_URL = baseUrl;
  if (Object.keys(kv).length) deps.saveEnv(kv);
  setFetchModel(provider, model); // make the picked brain actually take effect
  return { ok: true, message: scrub(r.message, key) };
}

/** Set the image model (no live check: a test image costs money; the first picture says if it fails), or turn it off
 *  with an empty model. */
export async function saveImage(b: { provider?: unknown; model?: unknown; key?: unknown; baseUrl?: unknown }): Promise<Outcome> {
  if (imageFixed()) return fail('fixed', 'The server’s MWA_MODEL_IMAGE setting chooses the image model, and it wins over a choice here. Change it there.');
  const raw = typeof b.model === 'string' ? b.model.trim() : b.model;
  if (raw === '' || raw === undefined || raw === null) { setImageModel(String(b.provider ?? ''), ''); return { ok: true, message: 'Image generation turned off.' }; }
  if (!isProvider(b.provider)) return fail('bad_provider', 'Pick one of the AI providers in the list.');
  const provider = b.provider;
  if (provider === 'anthropic') return fail('bad_provider', 'Anthropic doesn’t make images. Pick another provider, like OpenRouter.');
  const model = checkModel(b.model); if (isOutcome(model)) return model;
  const key = checkKey(b.key); if (isOutcome(key)) return key;
  const baseUrl = checkBaseUrl(provider, b.baseUrl); if (isOutcome(baseUrl)) return baseUrl;
  const envKey = envKeyForProvider(provider);
  const kv: Record<string, string> = {};
  if (envKey && key) kv[envKey] = key;
  if (provider === 'ollama' && baseUrl) {
    // review of S2: OLLAMA_BASE_URL is shared with the brain; an image setting must not move an Ollama brain elsewhere
    const brain = parseSpec(loadConfig().models.fetch || '');
    const now = process.env.OLLAMA_BASE_URL;
    if (brain.provider === 'ollama' && (now ?? '') !== baseUrl) return fail('bad_base_url', 'Your AI brain uses Ollama at another address. Pictures use the same one: change it with the brain.');
    kv.OLLAMA_BASE_URL = baseUrl;
  }
  if (Object.keys(kv).length) deps.saveEnv(kv);
  setImageModel(provider, model);
  return { ok: true, message: `Image model set to ${provider}:${model}.` };
}

/** A provider's models: chat models that can run the assistant (tool-capable), or image models. The key typed now is
 *  used for this one listing and not saved. `npmAfter` (chat): would adding plug-ins from npm be available with it. */
export async function modelChoices(b: { provider?: unknown; kind?: unknown; key?: unknown }): Promise<{ ok: true; provider: string; kind: 'chat' | 'image'; models: { id: string; name: string | null; npmAfter: boolean | null }[] } | Extract<Outcome, { ok: false }>> {
  if (!isProvider(b.provider)) return { ok: false, code: 'bad_provider', message: 'Pick one of the AI providers in the list.' };
  const kind: 'chat' | 'image' = b.kind === 'image' ? 'image' : 'chat';
  const key = checkKey(b.key); if (isOutcome(key)) return key as Extract<Outcome, { ok: false }>;
  let list: { id: string; name?: string }[] = [];
  try { list = await deps.listModels(b.provider, { key, kind }); } catch { list = []; }
  const cfg = loadConfig(), raw = readRaw(); // read once per listing, not per model
  const models = list.filter((m) => typeof m?.id === 'string' && m.id && m.id.length <= 200).slice(0, 2000)
    .map((m) => ({ id: m.id, name: typeof m.name === 'string' && m.name ? m.name.slice(0, 200) : null, npmAfter: kind === 'chat' ? npmAfterBrain(b.provider as string, m.id, cfg, raw) : null }));
  return { ok: true, provider: b.provider, kind, models };
}

// ── what it can touch ───────────────────────────────────────────────────────────────────────────────────────────

const win = process.platform === 'win32';
/** A path as the file system sees it: links and junctions followed (realpath), and on Windows compared without case. */
function real(p: string): string {
  const abs = resolve(p);
  try { return realpathSync.native(abs); } catch { /* not there (yet): follow its nearest existing parent */ }
  const parent = dirname(abs);
  if (parent === abs) return abs;
  return join(real(parent), abs.slice(parent.length).replace(/^[\\/]+/, ''));
}
const key = (p: string) => { const r = real(p); return win ? r.toLowerCase() : r; };
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
/** Two paths name the same folder (Windows: in any case; links followed). */
export function samePath(a: string, b: string): boolean {
  try { return key(a) === key(b); } catch { return a === b; }
}

/**
 * The helper's own places. `holds`: the folders the .env and mwa.config.json sit in: never granted, nor anything that
 * contains them (a folder INSIDE one is fine: the app folder, or a home folder the helper was started from, has
 * ordinary folders in it). `data`: where its keys, sign-in tokens, memory, logs, browser profiles and vault live (each
 * as relocated by its env var): never granted, nor anything that contains them, nor anything inside them.
 */
export function protectedFolders(): { holds: string[]; data: string[] } {
  const holds = [dirname(resolve(process.env.MWA_ENV_PATH ?? '.env')), dirname(resolve(configPath()))];
  const data = [
    dataDir(), dirname(resolve(dbFile())), dirname(resolve(vaultPath())), resolve(browserDir()),
    dirname(resolve(runLogPath())), dirname(resolve(notifyPath())), dirname(resolve(mwaLogPath())), dirname(resolve(installLogPath())),
    dirname(connectorTokenPath('google-token.json', 'MWA_GOOGLE_TOKEN')), dirname(connectorTokenPath('microsoft-token.json', 'MWA_MS_TOKEN')),
    ...['MWA_APPROVALS_DB', 'MWA_TOKEN_LOG'].map((n) => process.env[n]).filter((v): v is string => !!v && v !== ':memory:').map((v) => dirname(resolve(v))),
  ];
  return { holds: [...new Set(holds)], data: [...new Set(data)] };
}

/** S6 (review): a file or folder that is the helper's own: inside its data (memory, vault, sign-in tokens, logs,
 *  browser profiles), or its .env / mwa.config.json themselves. Compared where it really is (links followed). */
export function isProtectedPath(path: string): boolean {
  try {
    const k = key(path);
    const prot = protectedFolders();
    if (prot.data.some((f) => inside(k, key(f)))) return true;
    const own = [resolve(process.env.MWA_ENV_PATH ?? '.env'), resolve(configPath())].map((f) => key(f));
    return own.includes(k);
  } catch { return true; }
}

/** Why a folder can't be newly granted, or null when it can. */
export function folderProblem(path: string): { code: string; message: string } | null {
  const p = String(path ?? '').trim();
  if (!p) return { code: 'bad_folder', message: 'Type the folder’s full path.' };
  if (p.length > 1024 || !LINE.test(p)) return { code: 'bad_folder', message: 'That isn’t a folder path.' };
  if (/^(\\\\|\/\/)/.test(p)) return { code: 'refused', message: 'A network share can’t be granted. Use a folder on this computer.' };
  if (!isAbsolute(p) || (win && !/^[a-z]:[\\/]/i.test(p))) return { code: 'bad_folder', message: 'Type the folder’s full path, starting from the drive or /.' };
  const abs = resolve(p);
  let isDir = false; try { isDir = existsSync(abs) && statSync(abs).isDirectory(); } catch { /* unreadable */ }
  if (!isDir) return { code: 'not_found', message: `I couldn’t find a folder at ${p.slice(0, 200)}.` };
  // review of S2: compare where the folder really is (a link or junction to the helper's folder is the helper's folder)
  const k = key(abs);
  if (parsePath(abs).root === abs || parsePath(k).root === k || (win ? k === parsePath(k).root.toLowerCase() : false)) return { code: 'refused', message: 'A whole drive can’t be granted. Pick a folder on it, like Documents.' };
  const prot = protectedFolders();
  const own = 'That folder holds your helper’s own keys and settings, so it can’t be granted. Pick a folder that doesn’t contain them.';
  if (prot.holds.some((f) => inside(key(f), k))) return { code: 'refused', message: own };
  if (prot.data.some((f) => { const d = key(f); return inside(d, k) || inside(k, d); })) return { code: 'refused', message: 'That folder is part of your helper’s own data (its memory, sign-ins and saved logins), so it can’t be granted. Pick a folder outside it.' };
  return null;
}

/**
 * Save the access level and the granted folders (undefined folders: keep the current ones). A folder granted before
 * is kept while it still exists; a new one must pass folderProblem. Returns what was kept and what was not, and why.
 */
export function saveAccess(preset: unknown, folders?: unknown): Outcome & { grantedRoots?: string[]; dropped?: { path: string; code: string; message: string }[] } {
  if (typeof preset !== 'string' || !(ACCESS_PRESETS as readonly string[]).includes(preset)) return fail('bad_preset', 'Pick Locked-down, Assistant or Developer.');
  if (folders !== undefined && (!Array.isArray(folders) || folders.length > 50 || folders.some((f) => typeof f !== 'string'))) return fail('bad_folders', 'Send the folders as a list of paths (50 at most).');
  const before = accessPolicy().grantedRoots;

  const asked: string[] = folders === undefined ? before : (folders as string[]);
  const pass: string[] = [], dropped: { path: string; code: string; message: string }[] = [];
  for (const f of asked) {
    const known = before.some((g) => samePath(g, f));
    const problem = known ? null : folderProblem(f);
    if (problem) dropped.push({ path: f, ...problem }); else pass.push(f);
  }
  const saved = setAccess(preset as AccessPreset, pass);
  for (const f of saved.dropped) dropped.push({ path: f, code: 'not_found', message: `I couldn’t find a folder at ${f.slice(0, 200)}.` });
  const missing = dropped.filter((d) => d.code === 'not_found').map((d) => d.path);
  const refused = dropped.filter((d) => d.code !== 'not_found').map((d) => d.path);
  const message = !dropped.length ? 'Saved.'
    : `Saved.${missing.length ? ` Couldn't find: ${missing.join(', ')}` : ''}${refused.length ? `${missing.length ? '.' : ''} Not granted: ${refused.join(', ')} (${dropped.find((d) => d.code !== 'not_found')!.message})` : ''}`;
  return { ok: true, message, grantedRoots: saved.grantedRoots, dropped };
}

// ── how I work with you ─────────────────────────────────────────────────────────────────────────────────────────

export function saveStyle(style: unknown): Outcome {
  if (typeof style !== 'string' || !(INTERACTION_STYLES as readonly string[]).includes(style)) return fail('bad_style', 'Pick Guided or Direct.');
  const s = setStyle(style as InteractionStyle);
  return { ok: true, message: s === 'direct' ? 'Switched to Direct — concise replies.' : 'Switched to Guided — I\'ll explain and suggest next steps.' };
}

// ── the classic page (POST /api/save) ───────────────────────────────────────────────────────────────────────────

export const LEGACY_WHICH = new Set(['provider', 'image-model', 'access', 'style']);
/** serve.ts /api/save for these four: the same functions as the v1 routes, in the classic {ok, message} shape. */
export async function legacySave(b: Record<string, any>): Promise<{ ok: boolean; message: string }> {
  let r: Outcome;
  if (b.which === 'provider') r = await saveBrain({ provider: b.provider, model: b.model, key: b.key, baseUrl: b.baseUrl });
  else if (b.which === 'image-model') r = await saveImage({ provider: b.provider, model: b.model, key: b.key, baseUrl: b.baseUrl });
  else if (b.which === 'access') r = saveAccess(b.preset, Array.isArray(b.grantedRoots) ? b.grantedRoots.map(String) : undefined);
  else if (b.which === 'style') r = saveStyle(b.style);
  else return { ok: false, message: 'unknown setting' };
  return { ok: r.ok, message: r.message };
}

// ── the view ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Everything the settings show. No key value is ever in it: `keySaved` says only whether one is saved. */
export function assistantState() {
  const cfg = loadConfig();
  const brain = parseSpec(cfg.models.fetch || '');
  const image = parseSpec(cfg.models.image || '');
  const notes: { standing: string; text: string }[] = [];
  try {
    const m = injectionNote(cfg.models.fetch); if (m.standing !== 'held') notes.push(m);
    if (cfg.models.reason !== cfg.models.fetch) { const r = injectionNote(cfg.models.reason); if (r.standing !== 'held') notes.push(r); }
  } catch { /* no notes */ }
  const keySaved = (p: string) => { const k = envKeyForProvider(p); return k ? deps.hasEnv(k) : null; };
  const access = accessPolicy();
  return {
    brain: { provider: brain.provider, model: brain.model, fixed: brainFixed(), notes: notes.map((n) => ({ standing: n.standing === 'failed' ? 'failed' as const : 'unmeasured' as const, text: n.text })) },
    image: { provider: image.provider, model: image.model, on: !!cfg.models.image, fixed: imageFixed() },
    providers: PROVIDER_CHOICES.map((p) => ({ ...p, keySaved: keySaved(p.id) })),
    access: {
      preset: access.preset,
      folders: access.grantedRoots.map((f) => { let found = false; try { found = statSync(f).isDirectory(); } catch { /* gone */ } return { path: f, found }; }),
    },
    style: (cfg.style ?? 'guided') as InteractionStyle,
  };
}
