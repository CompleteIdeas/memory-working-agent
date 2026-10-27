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
import { upsertEnv } from '../../wizard.js';
import { installLogPath } from '../../paths.js';
import { logger } from '../../logger.js';

export interface PluginRouteDeps {
  /** write keys to .env and this process (wizard.ts upsertEnv) */
  saveEnv: (kv: Record<string, string>) => void;
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

/** A command-line argument that may carry a secret: shown as "•••". `--token abc`, `--api-key=abc`, `KEY=abc`, or a
 *  long token-looking string. The env block is never shown at all (names only). */
const SECRET_FLAG = /(token|key|secret|password|passwd|pat|auth|credential|bearer)/i;
export function redactArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    const prev = i > 0 ? String(args[i - 1]) : '';
    const eq = /^(-{0,2}[A-Za-z0-9_.-]+)=(.+)$/.exec(a);
    if (eq && SECRET_FLAG.test(eq[1])) out.push(`${eq[1]}=•••`);
    else if (/^-{1,2}[A-Za-z]/.test(prev) && !prev.includes('=') && SECRET_FLAG.test(prev) && !a.startsWith('-')) out.push('•••');
    else if (/^(sk|pk|ghp|gho|github_pat|xox[abp]|ntn|secret|tvly|fc)[-_][A-Za-z0-9_-]{8,}$/i.test(a) || (/^[A-Za-z0-9_\-+/=]{32,}$/.test(a) && /\d/.test(a) && /[A-Za-z]/.test(a))) out.push('•••');
    else out.push(a);
  }
  return out;
}
/** npx -y <package>[@version] → the package, to name the plug-in in plain words */
function npmPackageOf(command: string, args: string[]): string | null {
  if (!/^npx(\.cmd)?$/i.test(command)) return null;
  const pkg = args.find((a) => !a.startsWith('-'));
  return pkg ?? null;
}

export function customViews() {
  const library = new Set(listConnectors().map((c) => c.id));
  return Object.entries(listMcpServers()).filter(([id]) => !library.has(id)).map(([id, spec]) => {
    const args = Array.isArray(spec.args) ? spec.args.map(String) : [];
    const shown = redactArgs(args);
    return {
      id, command: [String(spec.command ?? ''), ...shown].join(' ').trim(), package: npmPackageOf(String(spec.command ?? ''), shown),
      envNames: Object.keys(spec.env ?? {}),
    };
  });
}

export function externalView() {
  let st: ReturnType<typeof externalInstallState>;
  try { st = externalInstallState(deps.config()); } catch { return { available: false, reason: 'Your settings file can’t be read, so adding from npm is off.', reviewer: null }; }
  return { available: st.enabled, reason: st.reason, reviewer: st.model || null };
}

export function pluginsView() {
  const on = new Set(enabledConnectorIds());
  return {
    plugins: listConnectors().map((c) => pluginView(c, on.has(c.id))),
    custom: customViews(),
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
  };
}

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
  { method: 'GET', path: '/plugins', scope: 'read', handler: () => ({ body: pluginsView() }) },
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
    method: 'DELETE', path: '/plugins/{id}', scope: 'admin',
    handler: ({ params }) => {
      if (getConnector(params.id)) throw new ApiError(400, 'library_plugin', 'That one comes with your helper. Turn it off instead.');
      if (!removeMcpServer(params.id)) throw new ApiError(404, 'not_found', 'No plug-in by that name, or it was already removed.');
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
      if (r.verdict === 'dangerous' && b.acceptRisk !== true) throw new ApiError(409, 'risky', 'The review found this package dangerous. Only install it if you trust where it came from, and say so (acceptRisk).');
      const library = new Set(listConnectors().map((c) => c.id));
      const id = pkg.replace(/[^a-z0-9_-]/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'connector';
      if (library.has(id)) throw new ApiError(409, 'name_taken', `A plug-in in the library is already called ${id}. Use that one instead.`);
      const done = enableExternalNpm(pkg, r.pinnedVersion);
      try { deps.logInstall({ ts: deps.now(), id: done.id, name: pkg, tier: 'approved-external', version: r.pinnedVersion, verdict: r.verdict, integrity: r.integrity ?? null }); } catch { /* best-effort, as the classic page */ }
      reviews.delete(pkg);
      logger.info('plugins', 'npm plug-in installed', { id: done.id, version: r.pinnedVersion, verdict: r.verdict });
      const mine = customViews().find((x) => x.id === done.id) ?? null;
      return { body: { plugin: mine, message: `Installed ${pkg}@${r.pinnedVersion}. Its tools are available on your next message.` } };
    },
  },
];
