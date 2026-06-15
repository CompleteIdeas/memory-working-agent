/**
 * Static analyzer (deterministic, runs BEFORE the model review). First cut: npm registry
 * METADATA only — install scripts, dependency sprawl, package age, downloads, maintainers,
 * typosquat distance. Deep tarball/source scanning is a Phase-3 hardening.
 */
export interface Finding { severity: 'info' | 'warn' | 'danger'; label: string; detail: string }
export interface PackageMeta {
  name: string; version: string; description?: string;
  ageDays?: number; downloads?: number; maintainers?: number;
  deps?: number; hasInstallScript?: boolean; tarball?: string; integrity?: string;
}
export interface Analysis { ok: boolean; error?: string; meta?: PackageMeta; findings: Finding[] }

// A small baseline of well-known packages/scopes for typosquat distance checks.
const KNOWN = [
  '@modelcontextprotocol/server-filesystem', '@modelcontextprotocol/server-github',
  '@modelcontextprotocol/server-memory', '@modelcontextprotocol/server-sequential-thinking',
  '@modelcontextprotocol/sdk', '@upstash/context7-mcp', '@playwright/mcp',
  '@notionhq/notion-mcp-server', 'tavily-mcp', 'firecrawl-mcp', 'exa-mcp-server',
  'express', 'react', 'lodash', 'axios', 'puppeteer',
];

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

export async function analyzeNpmPackage(name: string): Promise<Analysis> {
  const findings: Finding[] = [];
  if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(name)) {
    return { ok: false, error: 'That is not a valid npm package name.', findings };
  }
  let j: any;
  try {
    const r = await fetch(`https://registry.npmjs.org/${name.replace(/\//g, '%2F')}`);
    if (!r.ok) return { ok: false, error: `npm registry returned ${r.status} (package not found?)`, findings };
    j = await r.json();
  } catch (e) { return { ok: false, error: `Could not reach npm: ${(e as Error).message.slice(0, 80)}`, findings }; }

  const latest = j['dist-tags']?.latest;
  const v = j.versions?.[latest] ?? {};
  const scripts = v.scripts ?? {};
  const installScripts = Object.keys(scripts).filter((k) => /^(pre|post)?install$/.test(k));
  if (installScripts.length) findings.push({ severity: 'danger', label: 'Runs an install script', detail: `package.json defines ${installScripts.join(', ')} — code executes at install time, before you run anything.` });

  const deps = Object.keys(v.dependencies ?? {}).length;
  if (deps > 25) findings.push({ severity: 'warn', label: 'Many dependencies', detail: `${deps} direct dependencies — a larger supply-chain surface.` });

  const created = j.time?.created ? Date.parse(j.time.created) : undefined;
  const ageDays = created ? Math.round((Date.now() - created) / 86_400_000) : undefined;
  if (ageDays !== undefined && ageDays < 30) findings.push({ severity: 'warn', label: 'Very new package', detail: `First published ${ageDays} day(s) ago — little track record.` });

  const maintainers = (j.maintainers ?? []).length;
  if (!maintainers) findings.push({ severity: 'warn', label: 'No listed maintainers', detail: 'No maintainer metadata on the package.' });

  let downloads: number | undefined;
  try {
    const d = await fetch(`https://api.npmjs.org/downloads/point/last-month/${name.replace(/\//g, '%2F')}`);
    if (d.ok) { downloads = ((await d.json()) as any).downloads; if (typeof downloads === 'number' && downloads < 100) findings.push({ severity: 'warn', label: 'Low usage', detail: `${downloads} downloads last month — few other people run it.` }); }
  } catch { /* downloads optional */ }

  const near = KNOWN.find((k) => k !== name && levenshtein(k, name) > 0 && levenshtein(k, name) <= 2);
  if (near) findings.push({ severity: 'danger', label: 'Possible typosquat', detail: `Name is 1–2 characters from a well-known package "${near}".` });

  if (!findings.length) findings.push({ severity: 'info', label: 'No metadata red flags', detail: 'Nothing obviously wrong in the package metadata (not a guarantee — the model reviews it too).' });

  return {
    ok: true,
    meta: { name, version: latest, description: v.description, ageDays, downloads, maintainers, deps, hasInstallScript: !!installScripts.length, tarball: v.dist?.tarball, integrity: v.dist?.integrity },
    findings,
  };
}
