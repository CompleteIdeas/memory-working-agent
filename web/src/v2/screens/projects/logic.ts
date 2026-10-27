/**
 * The Projects tab's words (v2 build, slice W4), apart from the components so they are unit-tested in node.
 */
import type { Job, Project, Turn } from '../../api/client';

const RUNNING = new Set(['working', 'continuing']);
const WAITING = new Set(['waiting', 'partly_done']);

/** A job's title as part of a sentence: "Gathering this week’s AI news" → "gathering this week’s AI news". */
function lower(title: string): string {
  return /^[A-Z][a-z]/.test(title) ? title[0].toLowerCase() + title.slice(1) : title;
}

/** Whether a job is this project's (General also holds the jobs no project claims). */
export function jobOf(p: Pick<Project, 'id' | 'general'>, j: Pick<Job, 'projectId'>): boolean {
  return j.projectId === p.id || (p.general && !j.projectId);
}

/**
 * A project's row in the list: what it is doing, and its badge. Waiting for the person first (it needs them), then
 * working, then an answer being written in its thread. Nothing going on: no line (the row says the last activity).
 */
export function projectStatus(p: Pick<Project, 'id' | 'general'>, jobs: Job[], latest?: Pick<Turn, 'kind'> | null): {
  line: string | null; badge: { text: string; tone: 'needs' | 'working' } | null;
} {
  const mine = jobs.filter((j) => !j.archived && jobOf(p, j));
  const waiting = mine.filter((j) => WAITING.has(j.status.state));
  const working = mine.filter((j) => RUNNING.has(j.status.state));
  if (waiting.length) return { line: `Waiting for you: ${lower(waiting[0].title)}`, badge: { text: waiting.length > 1 ? `${waiting.length} waiting` : 'Waiting', tone: 'needs' } };
  if (working.length) return { line: `Working: ${lower(working[0].title)}`, badge: { text: working.length > 1 ? `${working.length} working` : 'Working', tone: 'working' } };
  if (latest?.kind === 'running') return { line: 'Writing an answer…', badge: { text: 'Answering', tone: 'working' } };
  return { line: null, badge: null };
}

/** "Last: today 9:04 AM", "Last: yesterday", "Last: Nov 3"; "Nothing here yet" for an empty thread. */
export function activityText(ts: number | null, now: number): string {
  if (!ts) return 'Nothing here yet';
  const d = new Date(ts), n = new Date(now);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / 86_400_000);
  if (diff <= 0) return `Last: today ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  if (diff === 1) return 'Last: yesterday';
  if (diff < 7) return `Last: ${d.toLocaleDateString('en-US', { weekday: 'long' })}`;
  return `Last: ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== n.getFullYear() ? { year: 'numeric' } : {}) })}`;
}

/** A file's size as people say it. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The last part of a workspace path. */
export function baseName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
}

/** A turn's place in the thread: where it was moved from, and whether it came from before projects. */
export function turnNotes(t: Pick<Turn, 'movedFrom' | 'source'>, projects: Record<string, Pick<Project, 'name'>>): string[] {
  const out: string[] = [];
  if (t.movedFrom) out.push(`Moved here from ${projects[t.movedFrom]?.name ?? 'another project'}`);
  if (t.source === 'voice') out.push('Spoken');
  return out;
}

/** Turns in thread order, earlier pages first, with no turn twice. */
export function mergeTurns(older: Turn[], recent: Turn[]): Turn[] {
  const seen = new Set<string>();
  const out: Turn[] = [];
  for (const t of [...older, ...recent]) { if (seen.has(t.id)) continue; seen.add(t.id); out.push(t); }
  return out.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
}
