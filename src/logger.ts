/**
 * Structured logging — one place to emit operator-readable events instead of ad-hoc
 * console.* scattered across the codebase. Each entry is a JSON line in data/mwa.log
 * (MWA_LOG to override) AND mirrored to the console for dev. readLogs() backs the
 * /api/logs endpoint so an operator can see WHY a run/scheduler/MCP step failed.
 *
 * Deliberately tiny + zero-dependency (matches MWA's lightweight ethos). Routed through
 * the critical paths (agent lifecycle, scheduler, MCP, serve); cosmetic console.* left as-is.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';
export interface LogEntry { ts: number; level: LogLevel; category: string; msg: string; data?: Record<string, unknown>; }

function logPath(): string { return process.env.MWA_LOG ?? resolve('./data/mwa.log'); }

export function log(level: LogLevel, category: string, msg: string, data?: Record<string, unknown>): void {
  const entry: LogEntry = { ts: Date.now(), level, category, msg: String(msg).slice(0, 1000), ...(data ? { data } : {}) };
  try {
    const p = logPath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(entry) + '\n');
  } catch { /* logging is best-effort — never throw from a log call */ }
  const line = `[${category}] ${msg}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const logger = {
  info: (category: string, msg: string, data?: Record<string, unknown>) => log('info', category, msg, data),
  warn: (category: string, msg: string, data?: Record<string, unknown>) => log('warn', category, msg, data),
  error: (category: string, msg: string, data?: Record<string, unknown>) => log('error', category, msg, data),
};

/** Recent log entries, newest-first. Backs /api/logs. */
export function readLogs(opts?: { since?: number; limit?: number; level?: LogLevel }): LogEntry[] {
  let lines: string[];
  try { lines = readFileSync(logPath(), 'utf8').trim().split('\n'); } catch { return []; }
  const since = opts?.since ?? 0;
  const limit = opts?.limit ?? 100;
  const out: LogEntry[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const e = JSON.parse(lines[i]) as LogEntry;
      if (e.ts > since && (!opts?.level || e.level === opts.level)) out.push(e);
    } catch { /* skip malformed line */ }
  }
  return out;
}
