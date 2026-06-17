/**
 * Local-machine access policy. The agent reads untrusted content (email, web) with a cheap
 * model, so its file/command reach is the prompt-injection blast radius. One rule for every
 * file tool: a granted-roots allowlist (the workspace, always, + folders the user granted).
 * `run_command` can't be path-confined (a shell command goes where it wants), so it's gated
 * by the chosen preset instead. Three presets, picked at setup:
 *
 *   locked-down — workspace only; run_command OFF.
 *   assistant   — workspace + granted folders; run_command ON only when a human is watching
 *                 (interactive), OFF when unattended (scheduled). [default]
 *   developer   — workspace + granted folders; run_command ON always.
 */
import { resolve, sep } from 'node:path';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { loadConfig, configPath } from '../config.js';

export type AccessPreset = 'locked-down' | 'assistant' | 'developer';
export const ACCESS_PRESETS: AccessPreset[] = ['locked-down', 'assistant', 'developer'];

export interface AccessPolicy { preset: AccessPreset; grantedRoots: string[]; }

export function accessPolicy(): AccessPolicy {
  const a = (loadConfig().tools as any).access ?? {};
  const preset: AccessPreset = ACCESS_PRESETS.includes(a.preset) ? a.preset : 'assistant';
  const grantedRoots: string[] = Array.isArray(a.grantedRoots) ? a.grantedRoots.filter((s: unknown) => typeof s === 'string') : [];
  return { preset, grantedRoots };
}

/** Persist the access posture to mwa.config.json. grantedRoots are kept only if they exist
 *  and are folders (so a typo can't silently widen access to a non-folder). */
export function setAccess(preset: AccessPreset, grantedRoots?: string[]): { preset: AccessPreset; grantedRoots: string[]; dropped: string[] } {
  let raw: any = {};
  try { if (existsSync(configPath())) raw = JSON.parse(readFileSync(configPath(), 'utf8')); } catch { /* */ }
  raw.tools = raw.tools ?? {};
  const prev = raw.tools.access?.grantedRoots ?? [];
  const requested: string[] = Array.isArray(grantedRoots) ? grantedRoots : prev;
  const kept: string[] = [], dropped: string[] = [];
  for (const g of requested) {
    try { if (existsSync(g) && statSync(g).isDirectory()) kept.push(resolve(g)); else dropped.push(g); } catch { dropped.push(g); }
  }
  raw.tools.access = { preset: ACCESS_PRESETS.includes(preset) ? preset : 'assistant', grantedRoots: [...new Set(kept)] };
  writeFileSync(configPath(), JSON.stringify(raw, null, 2) + '\n');
  return { preset: raw.tools.access.preset, grantedRoots: raw.tools.access.grantedRoots, dropped };
}

/** Folders the file tools may touch: the agent's workspace + any granted folders. */
export function allowedRoots(sandboxDir: string): string[] {
  const { preset, grantedRoots } = accessPolicy();
  const roots = [resolve(sandboxDir)];
  // locked-down stays workspace-only; assistant/developer add the granted folders.
  if (preset !== 'locked-down') for (const g of grantedRoots) { try { roots.push(resolve(g)); } catch { /* skip */ } }
  return roots;
}

/** Resolve `target` (relative → against the workspace; or absolute) and return it ONLY if it
 *  lands inside one of the allowed roots; else null (refused). */
export function resolveAllowed(sandboxDir: string, target: string, roots = allowedRoots(sandboxDir)): string | null {
  const full = resolve(roots[0], target); // relative paths resolve against the workspace
  for (const r of roots) if (full === r || full.startsWith(r + sep)) return full;
  return null;
}

/** Whether run_command is permitted given the preset + whether a human is watching. */
export function runCommandAllowed(interactive: boolean | undefined): { ok: boolean; reason: string } {
  const { preset } = accessPolicy();
  if (preset === 'developer') return { ok: true, reason: '' };
  if (preset === 'assistant') return interactive
    ? { ok: true, reason: '' }
    : { ok: false, reason: 'running commands is off for unattended runs in Assistant mode' };
  return { ok: false, reason: 'running commands is off in Locked-down mode (switch to Developer mode to allow it)' };
}
