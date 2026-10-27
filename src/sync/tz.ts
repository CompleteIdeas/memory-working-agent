/**
 * Time-zone arithmetic for the calendar cache (v2 build, slice A7). No dependency: Intl knows the IANA zones and
 * their daylight-saving rules, which is all that is needed to turn a wall-clock time in a zone into an instant and
 * an instant back into a local date.
 */

/** The person's zone: MWA_TZ, else the machine's. */
export function localTz(env: Record<string, string | undefined> = process.env): string {
  const z = env.MWA_TZ?.trim();
  if (z && validTz(z)) return z;
  if (z && !warnedTz.has(z)) {
    warnedTz.add(z);
    console.warn(`[mwa] MWA_TZ="${z.slice(0, 60)}" is not a time zone I know (use an IANA name such as America/New_York); using this machine's zone instead.`);
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
const warnedTz = new Set<string>();

export function validTz(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number, tz: string): Record<string, number> {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

/** The zone's offset from UTC at an instant, in minutes (New York in November: -300). */
export function offsetMinutes(ms: number, tz: string): number {
  const p = parts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;
const ZONED = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|([+-])(\d{2}):?(\d{2}))$/i;

/**
 * Refuse a date or time that does not exist instead of letting Date roll it over (review of A7: Feb 30 became Mar 2,
 * and month 13 next January). Hours 0–23, minutes and seconds 0–59.
 */
export function checkDateParts(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): void {
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (mo < 1 || mo > 12 || d < 1 || t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) throw new Error(`no such date: ${y}-${mo}-${d}`);
  if (h > 23 || mi > 59 || s > 59) throw new Error(`no such time: ${h}:${mi}:${s}`);
}

/**
 * A wall-clock time in a zone ('2026-11-14T15:00', 'America/New_York') → epoch ms. A time in the hour a clock skips
 * (spring forward) moves forward by the gap; in the hour that repeats (fall back) the first of the two instants is
 * taken — what calendar apps do.
 */
export function zonedToUtc(wall: string, tz: string): number {
  const m = WALL.exec(wall.trim());
  if (!m) throw new Error(`not a local date-time: ${wall}`);
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0', m[6] ?? '0'].map(Number);
  checkDateParts(y, mo, d, h, mi, s);
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  if (tz === 'UTC' || tz === 'Etc/UTC') return naive;
  // The offsets in force a day either side cover both sides of any change; a candidate is real when the zone's
  // offset at that instant is the one it was built with.
  const offs = [...new Set([offsetMinutes(naive - 86_400_000, tz), offsetMinutes(naive, tz), offsetMinutes(naive + 86_400_000, tz)])];
  const cands = offs.map((o) => ({ t: naive - o * 60_000, o }));
  const real = cands.filter((c) => offsetMinutes(c.t, tz) === c.o).map((c) => c.t);
  if (real.length) return Math.min(...real); // fall back: the first of the two
  return Math.max(...cands.map((c) => c.t)); // spring forward: 2:30 that never happens reads as 3:30
}

/** The local calendar date ('YYYY-MM-DD') of an instant in a zone. */
export function localDate(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Midnight at the start of a local date, as epoch ms. */
export function localMidnight(date: string, tz: string): number {
  return zonedToUtc(`${date}T00:00:00`, tz);
}

/** 'YYYY-MM-DD' plus n days (calendar arithmetic, no zone involved). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** ISO 8601 with an offset or Z → ms. A time with no offset is read in `tz`. A bare date is that date's midnight. */
export function parseWhen(s: string, tz: string): { ms: number; dateOnly: boolean } {
  const v = String(s ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ms: localMidnight(v, tz), dateOnly: true };
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(v)) {
    const m = ZONED.exec(v);
    if (!m) throw new Error(`not a date-time: ${s}`);
    checkDateParts(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0));
    if (m[8] && (+m[9] > 14 || +m[10] > 59)) throw new Error(`no such offset: ${s}`);
    const ms = Date.parse(v.replace(' ', 'T'));
    if (Number.isNaN(ms)) throw new Error(`not a date-time: ${s}`);
    return { ms, dateOnly: false };
  }
  return { ms: zonedToUtc(v, tz), dateOnly: false };
}

export const iso = (ms: number) => new Date(ms).toISOString();
