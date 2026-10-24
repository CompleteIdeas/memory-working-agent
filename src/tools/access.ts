/**
 * Local-machine access policy. The agent reads untrusted content (email, web) with a cheap
 * model, so its file/command reach is the prompt-injection blast radius. One rule for every
 * file tool: a granted-roots allowlist (the workspace, always, + folders the user granted).
 * `run_command` can't be path-confined (a shell command goes where it wants), so it's gated
 * by the chosen preset instead. Three presets, picked at setup:
 *
 *   locked-down — workspace only; run_command OFF.
 *   assistant   — workspace + granted folders; run_command ON only when a human is watching
 *                 (interactive), OFF when unattended (scheduled). [default] Even when watched, only
 *                 parsed read-only commands run directly; anything else is staged for the person's
 *                 approval (shell-gate.ts), and fetch tools can't reach this machine (net-guard.ts).
 *   developer   — workspace + granted folders; run_command ON always, ungated, full environment.
 *                 NO security boundary: a command can reach MWA's own approvals endpoint, so in this
 *                 mode the model can approve its own actions. Choose it only for a sandboxed machine.
 */
import { resolve, sep, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
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

/** How many files a folder holds, counted up to `cap` (skipping node_modules and dot-files), so a sources line can
 *  say "(41 files)" without walking a whole drive. */
function countFiles(root: string, cap: number): { files: number; capped: boolean } {
  let files = 0;
  const walk = (d: string): boolean => {
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return true; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      if (e.isDirectory()) { if (!walk(join(d, e.name))) return false; }
      else if (++files >= cap) return false;
    }
    return true;
  };
  const finished = walk(root);
  return { files, capped: !finished };
}

export interface GrantedFolder { path: string; files: number; capped: boolean; readable: boolean }

/**
 * The person's granted folders a run may read, beside its own working folder: resolved, de-duplicated, with a
 * capped file count. Usability review (2026-10-24, F07): the file tools already allowed these folders, but nothing
 * told the run they existed — the instruction named only the chat's folder, and `list_files` with no `dir` listed
 * only it — so a question about "my files" was answered "I couldn't find any files" with the files one folder away.
 * Locked-down grants nothing. A root that IS the working folder, or sits inside it, is already covered and left out.
 */
export function grantedFolders(sandboxDir: string): GrantedFolder[] {
  const { preset, grantedRoots } = accessPolicy();
  if (preset === 'locked-down') return [];
  const sb = resolve(sandboxDir);
  const out: GrantedFolder[] = []; const seen = new Set<string>();
  for (const g of grantedRoots) {
    let r: string; try { r = resolve(g); } catch { continue; }
    if (seen.has(r) || r === sb || r.startsWith(sb + sep)) continue;
    seen.add(r);
    let readable = false; try { readable = statSync(r).isDirectory(); } catch { /* gone or unreadable */ }
    const n = readable ? countFiles(r, 500) : { files: 0, capped: false };
    out.push({ path: r, files: n.files, capped: n.capped, readable });
  }
  return out;
}

/** The prompt line that names what a run can read. Empty when the person granted nothing (the prompt is then
 *  unchanged), so the cached prefix of every run without granted folders stays byte-identical. */
export function sourcesLine(sandboxDir: string): string {
  const roots = grantedFolders(sandboxDir).filter((r) => r.readable);
  if (!roots.length) return '';
  const named = roots.map((r) => `${r.path} (${r.capped ? `${r.files}+` : r.files} file${r.files === 1 ? '' : 's'})`).join('; ');
  return `FOLDERS YOU CAN READ: your working folder (where you save files), and the person's own folders: ${named}. ` +
    'With no `dir`, list_files and search_files cover all of them; read_file takes a file\'s full path. A question about ' +
    'the person\'s files, documents or notes means these folders: look there before saying a file is missing.';
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
