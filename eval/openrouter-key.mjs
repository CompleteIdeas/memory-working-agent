// The OpenRouter key for MWA's evaluation and model trials: USEA's own key (Robert, 2026-10-19 — this project is
// paid for by work), never another project's. It lives in the USEA_OPENROUTER_API_KEY user environment variable,
// not in any file. A shell opened before the variable was set does not have it, so on Windows it is read from the
// user environment directly. OPENROUTER_API_KEY in the process environment still wins, for an explicit override.
import { execFileSync } from 'node:child_process';

export function openRouterKey() {
  const fromEnv = process.env.OPENROUTER_API_KEY || process.env.USEA_OPENROUTER_API_KEY;
  if (fromEnv) return fromEnv.trim();
  if (process.platform !== 'win32') return undefined;
  try {
    const v = execFileSync('powershell', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('USEA_OPENROUTER_API_KEY','User')"], { encoding: 'utf8' }).trim();
    return v || undefined;
  } catch { return undefined; }
}
