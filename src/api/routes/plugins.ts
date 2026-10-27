/**
 * Plug-ins for the v2 app (v2 build, slice S1): the MCP servers in mwa.config.json `tools.mcpServers` — the curated
 * library (src/connectors/registry.ts), the owner's own (hand-added, or added from npm after a review), and "add from
 * npm" behind the installation-model review (src/installer). The same logic and safety gates as the classic
 * Connections page (serve.ts /api/connections), as routes:
 *
 *   GET    /plugins                  the library (on/off, what it can touch, key NAMES and whether each is saved — never
 *                                     a value), the owner's own (command shown, env values and secret-looking
 *                                     arguments hidden), and whether "add from npm" is available (and why not) (read)
 *   POST   /plugins/{id}/enable      turn a library plug-in on; refused while a required key is missing (admin)
 *   POST   /plugins/{id}/disable     turn a library plug-in off (admin)
 *   PUT    /plugins/{id}/keys        save keys, write-only: only the names that plug-in declares (admin)
 *   DELETE /plugins/{id}/keys/{name} clear one saved key (a name that plug-in declares; not while it is on and needs it)
 *   DELETE /plugins/{id}             remove one of the owner's own (not a library one: turn that off) (admin)
 *   POST   /plugins/review           the safety review of an npm package; nothing is installed (admin)
 *   POST   /plugins/approve          install a package this server reviewed in the last 30 minutes, at the version it
 *                                     reviewed; a "dangerous" verdict needs acceptRisk: true (admin)
 *
 * Every change takes effect on the next message (the tool registry is rebuilt from the config then).
 * Writes to .env, the reviewer and the install log come through setPluginRouteDeps so tests never touch the real ones.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApiError, type Route } from '../router.js';
import {
  listConnectors, getConnector, enableConnector, disableConnector, enabledConnectorIds, listMcpServers, removeMcpServer,
  enableExternalNpm, type ConnectorEntry,
} from '../../connectors/registry.js';
import { externalInstallState } from '../../installer/policy.js';
import { reviewConnector, type RiskReport } from '../../installer/review.js';
import { loadConfig, type MwaConfig } from '../../config.js';
import { upsertEnv, removeEnv } from '../../wizard.js';
import { installLogPath } from '../../paths.js';
import { logger } from '../../logger.js';

export interface PluginRouteDeps {
  /** write keys to .env and this process (wizard.ts upsertEnv) */
  saveEnv: (kv: Record<string, string>) => void;
  /** remove keys from .env and this process (wizard.ts removeEnv) */
  removeEnv: (names: string[]) => void;
  /** is this env var set (a key is "saved") */
  hasEnv: (name: string) => boolean;
  config: () => MwaConfig;
  review: (pkg: string, cfg: MwaConfig) => Promise<RiskReport>;
  /** one JSON line per approved install (the same log the classic page and the agent's tools write) */
  logInstall: (line: Record<string, unknown>) => void;
  now: () => number;
}
const realDeps: PluginRouteDeps = {
  saveEnv: (kv) => upsertEnv(kv),
  removeEnv: (names) => removeEnv(names),
  hasEnv: (n) => !!process.env[n],
  config: () => loadConfig(),
  review: (pkg, cfg) => reviewConnector(pkg, cfg),
  logInstall: (line) => { const lp = installLogPath(); mkdirSync(dirname(lp), { recursive: true }); appendFileSync(lp, JSON.stringify(line) + '\n'); },
  now: () => Date.now(),
};
let deps: PluginRouteDeps = realDeps;
export function setPluginRouteDeps(d: Partial<PluginRouteDeps> | null): void { deps = d ? { ...realDeps, ...d } : realDeps; reviews.clear(); }

export const APPLIES = 'Changes take effect on your next message.';
const bodyOf = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {});

// ── views ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function pluginView(c: ConnectorEntry, on: boolean) {
  const keys = (c.secrets ?? []).map((s) => ({ name: s.env, label: s.label, help: s.help ?? null, optional: !!s.optional, saved: deps.hasEnv(s.env) }));
  return {
    id: c.id, name: c.name, category: c.category, description: c.description, access: c.access, tier: c.tier,
    source: c.source ?? null, on, keys, missing: keys.filter((k) => !k.optional && !k.saved).map((k) => k.name),
  };
}

/**
 * A command-line argument that may carry a secret is masked with "•••" (the admin view; a caller without admin gets
 * no arguments at all). Masked: the value after a secret-looking flag (`--token abc`, even `--key -abc`), after
 * `-e`/`--env`/`-H`/`--header` (the name is kept: `DATABASE_URL=•••`, `Authorization: •••`), any `X=Y` whose name looks
 * secret or whose value holds `:` `@` or `;` (connection strings, URLs), a URL's password (`user:•••@`), a URL whose
 * path looks like a webhook or a token, a Bearer token, and a long token-looking string. The env block is never shown
 * (names only).
 */
const MASK = '•••';
const SECRET_FLAG = /(token|key|secret|password|passwd|pwd|pat|auth|credential|bearer|cookie|session|dsn|conn)/i;
const VALUE_FLAG = /^(-e|--env|-H|--header|--headers)$/i;
const IS_FLAG = /^-{1,2}[A-Za-z]/;
function maskUrls(s: string): string {
  return s
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi, `$1$2:${MASK}@`)
    .replace(/((?:https?|wss?):\/\/[^\s/?#]+)([/?#][^\s]*)/gi, (m, host: string, rest: string) =>
      (/hook|token|secret|key|sig=|signature|password|auth/i.test(host + rest) || /[/=][A-Za-z0-9_-]{20,}/.test(rest) ? `${host}/${MASK}` : m))
    .replace(/\b(bearer|basic|token)\s+\S+/gi, `$1 ${MASK}`);
}
/** "NAME=value" → "NAME=•••"; "Header: value" → "Header: •••"; anything else → "•••" */
function maskPair(a: string): string {
  const eq = a.indexOf('='), col = a.indexOf(':');
  if (eq > 0 && (col < 0 || eq < col)) return `${a.slice(0, eq)}=${MASK}`;
  if (col > 0) return `${a.slice(0, col)}: ${MASK}`;
  return MASK;
}
const TOKENISH = (a: string) => /^(sk|pk|ghp|gho|ghs|github_pat|xox[abpr]|ntn|secret|tvly|fc|glpat|AKIA)[-_]?[A-Za-z0-9_-]{8,}$/i.test(a)
  || (/^[A-Za-z0-9_\-+/=]{32,}$/.test(a) && /\d/.test(a) && /[A-Za-z]/.test(a));
export function redactArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    const prev = i > 0 ? String(args[i - 1]) : '';
    const prevTakesValue = IS_FLAG.test(prev) && !prev.includes('=');
    if (prevTakesValue && VALUE_FLAG.test(prev)) { out.push(maskPair(a)); continue; }
    if (prevTakesValue && SECRET_FLAG.test(prev)) { out.push(MASK); continue; }
    const eq = /^(-{0,2}[A-Za-z0-9_.-]+)=([\s\S]*)$/.exec(a);
    if (eq) {
      if (VALUE_FLAG.test(eq[1])) out.push(`${eq[1]}=${maskPair(eq[2])}`);
      else if (SECRET_FLAG.test(eq[1]) || /[:@;]/.test(eq[2])) out.push(`${eq[1]}=${MASK}`);
      else out.push(a);
      continue;
    }
    if (/^\s*(authorization|proxy-authorization|cookie|x-[a-z-]*(key|token|secret|auth)[a-z-]*)\s*:/i.test(a)) { out.push(maskPair(a)); continue; }
    if (/(^|;)\s*(password|pwd|secret|token|key)\s*=/i.test(a)) { out.push(MASK); continue; }
    if (TOKENISH(a)) { out.push(MASK); continue; }
    out.push(maskUrls(a));
  }
  return out;
}
/** npx -y <package>[@version] → the package, to name the plug-in in plain words */
function npmPackageOf(command: string, args: string[]): string | null {
  if (!/^npx(\.cmd)?$/i.test(command)) return null;
  const pkg = args.find((a) => !a.startsWith('-'));
  return pkg ?? null;
}

/** Your own plug-ins. `full` (admin): the command with its arguments, secrets masked; otherwise the command name only
 *  (a paired phone never gets the arguments at all — review of S1). */
export function customViews(full: boolean) {
  const library = new Set(listConnectors().map((c) => c.id));
  return Object.entries(listMcpServers()).filter(([id]) => !library.has(id)).map(([id, spec]) => {
    const args = Array.isArray(spec.args) ? spec.args.map(String) : [];
    const shown = redactArgs(args);
    const cmd = String(spec.command ?? '');
    return {
      id, command: full ? [cmd, ...shown].join(' ').trim() : cmd, argsHidden: !full && args.length > 0,
      package: npmPackageOf(cmd, shown), envNames: Object.keys(spec.env ?? {}),
    };
  });
}

export function externalView() {
  let st: ReturnType<typeof externalInstallState>;
  try { st = externalInstallState(deps.config()); } catch { return { available: false, reason: 'Your settings file can’t be read, so adding from npm is off.', reviewer: null }; }
  return { available: st.enabled, reason: st.reason, reviewer: st.model || null };
}

export function pluginsView(admin: boolean) {
  const on = new Set(enabledConnectorIds());
  return {
    plugins: listConnectors().map((c) => pluginView(c, on.has(c.id))),
    custom: customViews(admin),
    addFromNpm: externalView(),
    applies: APPLIES,
  };
}

// ── reviews this server ran (approve installs only what was reviewed here) ───────────────────────────────────────

const REVIEW_TTL_MS = 30 * 60_000;
const reviews = new Map<string, { report: RiskReport; at: number }>();
const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

function reviewView(r: RiskReport, at: number) {
  const d = r.deepScan;
  return {
    package: r.source, version: r.pinnedVersion ?? null, verdict: r.verdict, summary: r.summary,
    capabilities: r.capabilities, redFlags: r.redFlags,
    scan: d ? { ran: !!d.ran, files: d.filesScanned ?? null, checksum: d.integrityOk === undefined ? 'unknown' as const : d.integrityOk ? 'verified' as const : 'mismatch' as const, note: d.note ?? null }
      : { ran: false, files: null, checksum: 'unknown' as const, note: null },
    reviewer: r.model, expiresAt: at + REVIEW_TTL_MS,
    // review of S1: when the reviewing model could not be reached there is no AI judgement at all, only the automated
    // checks; approving then needs acceptRisk, as a dangerous verdict does
    aiReviewed: r.aiReviewed !== false,
  };
}
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function packageOf(b: Record<string, unknown>): string {
  const p = typeof b.package === 'string' ? b.package.trim() : '';
  if (!p) throw new ApiError(400, 'bad_body', 'Type the npm package name, for example @scope/server-name.');
  if (p.length > 214 || !NPM_NAME.test(p)) throw new ApiError(400, 'bad_package', 'That isn’t an npm package name. It looks like @scope/server-name or server-name, without a version.');
  return p;
}
function requireExternal(): void {
  const x = externalView();
  if (!x.available) throw new ApiError(409, 'npm_unavailable', x.reason);
}

// ── routes ──────────────────────────────────────────────────────────────────────────────────────────────────────

function libraryEntry(id: string): ConnectorEntry {
  const c = getConnector(id);
  if (!c) throw new ApiError(404, 'not_found', 'There is no plug-in with that name in the library.');
  return c;
}

export const pluginRoutes: Route[] = [
  { method: 'GET', path: '/plugins', scope: 'read', handler: ({ who }) => ({ body: pluginsView(!!who?.scopes.has('admin')) }) },
  {
    method: 'POST', path: '/plugins/{id}/enable', scope: 'admin',
    handler: ({ params }) => {
      const c = libraryEntry(params.id);
      const before = pluginView(c, enabledConnectorIds().includes(c.id));
      if (before.missing.length) {
        const labels = (c.secrets ?? []).filter((s) => before.missing.includes(s.env)).map((s) => s.label);
        throw new ApiError(409, 'needs_keys', `${c.name} needs ${labels.join(' and ')} first. Add it below, then turn it on.`);
      }
      const r = enableConnector(c.id);
      if (!r.ok) throw new ApiError(409, 'not_enabled', r.message);
      logger.info('plugins', 'plug-in turned on', { id: c.id });
      return { body: { plugin: pluginView(c, true), message: `${c.name} is on. ${APPLIES}` } };
    },
  },
  {
    method: 'POST', path: '/plugins/{id}/disable', scope: 'admin',
    handler: ({ params }) => {
      const c = libraryEntry(params.id);
      disableConnector(c.id);
      logger.info('plugins', 'plug-in turned off', { id: c.id });
      return { body: { plugin: pluginView(c, false), message: `${c.name} is off. ${APPLIES}` } };
    },
  },
  {
    method: 'PUT', path: '/plugins/{id}/keys', scope: 'admin',
    handler: ({ params, body }) => {
      const c = libraryEntry(params.id);
      const keys = bodyOf(body).keys;
      if (!keys || typeof keys !== 'object' || Array.isArray(keys) || !Object.keys(keys).length) {
        throw new ApiError(400, 'bad_body', 'Send {"keys": {"NAME": "value"}} with the keys this plug-in asks for.');
      }
      const declared = new Map((c.secrets ?? []).map((s) => [s.env, s]));
      const kv: Record<string, string> = {};
      for (const [name, value] of Object.entries(keys as Record<string, unknown>)) {
        // only a key this plug-in asks for (the 2026-10-23 settings test: any name was taken, PATH included)
        if (!declared.has(name)) throw new ApiError(400, 'unknown_key', `${c.name} doesn’t use a key called ${name.slice(0, 60)}.`);
        if (typeof value !== 'string' || !value.trim()) throw new ApiError(400, 'bad_value', `Type the ${declared.get(name)!.label}, or leave it out.`);
        if (value.length > 4096 || /[\r\n\0]/.test(value)) throw new ApiError(400, 'bad_value', `That doesn’t look like a ${declared.get(name)!.label}. Paste it again, on one line.`);
        kv[name] = value.trim();
      }
      deps.saveEnv(kv);
      logger.info('plugins', 'plug-in keys saved', { id: c.id, names: Object.keys(kv) });
      const view = pluginView(c, enabledConnectorIds().includes(c.id));
      return { body: { plugin: view, message: view.on ? `Saved. ${APPLIES}` : 'Saved. You can turn it on now.' } };
    },
  },
  {
    // clear one saved key (only a name this plug-in declares); refused while the plug-in is on and needs it
    method: 'DELETE', path: '/plugins/{id}/keys/{name}', scope: 'admin',
    handler: ({ params }) => {
      const c = libraryEntry(params.id);
      const s = (c.secrets ?? []).find((x) => x.env === params.name);
      if (!s) throw new ApiError(400, 'unknown_key', `${c.name} doesn’t use a key called ${params.name.slice(0, 60)}.`);
      const on = enabledConnectorIds().includes(c.id);
      if (on && !s.optional) throw new ApiError(409, 'in_use', `Turn ${c.name} off first, then clear its ${s.label}.`);
      if (!deps.hasEnv(s.env)) throw new ApiError(404, 'not_saved', `No ${s.label} is saved.`);
      deps.removeEnv([s.env]);
      logger.info('plugins', 'plug-in key cleared', { id: c.id, name: s.env });
      return { body: { plugin: pluginView(c, on), message: `Cleared the ${s.label}.${on ? ` ${APPLIES}` : ''}` } };
    },
  },
  {
    method: 'DELETE', path: '/plugins/{id}', scope: 'admin',
    handler: ({ params }) => {
      if (getConnector(params.id)) throw new ApiError(400, 'library_plugin', 'That one comes with your helper. Turn it off instead.');
      if (!hasOwn(listMcpServers(), params.id) || !removeMcpServer(params.id)) throw new ApiError(404, 'not_found', 'No plug-in by that name, or it was already removed.');
      logger.info('plugins', 'own plug-in removed', { id: params.id });
      return { body: { removed: params.id, message: `Removed ${params.id}. ${APPLIES}` } };
    },
  },
  {
    method: 'POST', path: '/plugins/review', scope: 'admin',
    handler: async ({ body }) => {
      const pkg = packageOf(bodyOf(body));
      requireExternal();
      let report: RiskReport;
      try { report = await deps.review(pkg, deps.config()); }
      catch (e) { throw new ApiError(503, 'review_failed', `The safety review couldn’t run just now (${(e as Error).message.slice(0, 120)}). Try again in a moment.`, true); }
      const at = deps.now();
      reviews.set(pkg, { report, at });
      return { body: { review: reviewView(report, at) } };
    },
  },
  {
    method: 'POST', path: '/plugins/approve', scope: 'admin',
    handler: ({ body }) => {
      const b = bodyOf(body);
      const pkg = packageOf(b);
      requireExternal();
      const got = reviews.get(pkg);
      if (!got || deps.now() - got.at > REVIEW_TTL_MS) throw new ApiError(409, 'review_first', 'Run the safety review for this package first (a review lasts 30 minutes).');
      const r = got.report;
      if (!r.analysis.ok || !r.pinnedVersion) throw new ApiError(409, 'not_installable', 'That package couldn’t be checked, so it can’t be installed.');
      if (r.aiReviewed === false && b.acceptRisk !== true) throw new ApiError(409, 'unreviewed', 'The safety check couldn’t reach the AI reviewer, so only the automated checks ran. Only install it if you trust where it came from, and say so (acceptRisk).');
      if (r.verdict === 'dangerous' && b.acceptRisk !== true) throw new ApiError(409, 'risky', 'The review found this package dangerous. Only install it if you trust where it came from, and say so (acceptRisk).');
      const library = new Set(listConnectors().map((c) => c.id));
      const id = pkg.replace(/[^a-z0-9_-]/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'connector';
      if (library.has(id)) throw new ApiError(409, 'name_taken', `A plug-in in the library is already called ${id}. Use that one instead.`);
      // review of S1: never write over a plug-in that is already there (a hand-added one with the same name included)
      if (hasOwn(listMcpServers(), id)) throw new ApiError(409, 'name_taken', `You already have a plug-in called ${id}. Remove it first if you want to replace it.`);
      const done = enableExternalNpm(pkg, r.pinnedVersion);
      try { deps.logInstall({ ts: deps.now(), id: done.id, name: pkg, tier: 'approved-external', version: r.pinnedVersion, verdict: r.verdict, integrity: r.integrity ?? null }); } catch { /* best-effort, as the classic page */ }
      reviews.delete(pkg);
      logger.info('plugins', 'npm plug-in installed', { id: done.id, version: r.pinnedVersion, verdict: r.verdict });
      const mine = customViews(true).find((x) => x.id === done.id) ?? null;
      return { body: { plugin: mine, message: `Installed ${pkg}@${r.pinnedVersion}. Its tools are available on your next message.` } };
    },
  },
];
