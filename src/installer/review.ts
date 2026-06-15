/**
 * Connector review — the "installation model" step. Runs the static analyzer, then asks
 * the user's configured (capable) model to judge the risk of running this npm package as
 * an MCP server. The model is an ADVISOR: deterministic findings can only RAISE the
 * verdict, never lower it, and the human still approves. Metadata-only for now.
 */
import { resolveProvider } from '../provider.js';
import { parseJsonLoose } from '../util.js';
import { analyzeNpmPackage, type Analysis } from './analyze.js';
import { installerSpec } from './policy.js';
import type { MwaConfig } from '../config.js';

export type Verdict = 'safe' | 'caution' | 'dangerous';
export interface RiskReport {
  source: string;
  verdict: Verdict;
  summary: string;
  capabilities: string[];
  redFlags: string[];
  analysis: Analysis;
  pinnedVersion?: string;
  model: string;
}

const RANK: Record<Verdict, number> = { safe: 0, caution: 1, dangerous: 2 };

export async function reviewConnector(source: string, cfg: MwaConfig): Promise<RiskReport> {
  const model = installerSpec(cfg);
  const analysis = await analyzeNpmPackage(source);
  if (!analysis.ok) {
    return { source, verdict: 'dangerous', summary: `Couldn't analyze "${source}": ${analysis.error}`, capabilities: [], redFlags: [analysis.error ?? 'analysis failed'], analysis, model };
  }

  const sys = 'You are a skeptical security reviewer. A user wants to run this npm package as an MCP tool server — it will run as a child process with the user\'s privileges, so a malicious package is full compromise. Judge the risk from the metadata + automated findings. Respond ONLY with JSON: {"verdict":"safe|caution|dangerous","capabilities":["short phrases"],"redFlags":["short phrases"],"summary":"one short plain-language paragraph a non-expert can act on"}.';
  const m = analysis.meta!;
  const user = [
    `Package: ${m.name}@${m.version}`,
    `Description: ${m.description ?? '(none)'}`,
    `Direct deps: ${m.deps ?? '?'} | Age(days): ${m.ageDays ?? '?'} | Downloads/mo: ${m.downloads ?? '?'} | Maintainers: ${m.maintainers ?? '?'} | Install script: ${m.hasInstallScript}`,
    'Automated findings:',
    analysis.findings.map((f) => `- [${f.severity}] ${f.label}: ${f.detail}`).join('\n') || '(none)',
  ].join('\n');

  let parsed: any = {};
  try {
    const res = await resolveProvider(model).chat({ system: sys, messages: [{ role: 'user', content: user }], maxTokens: 700 });
    parsed = parseJsonLoose(res.text) ?? {};
  } catch (e) {
    return { source, verdict: 'caution', summary: `The reviewing model couldn't be reached (${(e as Error).message.slice(0, 80)}) — treat with caution and review it yourself.`, capabilities: [], redFlags: analysis.findings.filter((f) => f.severity !== 'info').map((f) => f.label), analysis, pinnedVersion: m.version, model };
  }

  let verdict: Verdict = (['safe', 'caution', 'dangerous'] as const).includes(parsed.verdict) ? parsed.verdict : 'caution';
  // Deterministic floor: any 'danger' finding (install script, typosquat) can only raise it.
  if (analysis.findings.some((f) => f.severity === 'danger') && RANK[verdict] < RANK.caution) verdict = 'caution';
  return {
    source, verdict,
    summary: typeof parsed.summary === 'string' ? parsed.summary : 'No summary returned.',
    capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities.slice(0, 8).map(String) : [],
    redFlags: Array.isArray(parsed.redFlags) && parsed.redFlags.length ? parsed.redFlags.slice(0, 8).map(String) : analysis.findings.filter((f) => f.severity !== 'info').map((f) => f.label),
    analysis, pinnedVersion: m.version, model,
  };
}
