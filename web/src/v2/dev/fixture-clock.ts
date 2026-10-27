/**
 * The fixture clock per scenario (v2 build, slice W2). Kept tiny and free of example data: index.tsx imports it in the
 * main chunk. Every scenario is the prototype's Monday, November 9, 2026; most at 9:10 AM, the Today variants at the
 * time of day they show: N05 the morning check-in (7:30 AM), midday (12:30 PM), N09 the evening wrap (6:30 PM).
 */
export const SCENARIO_TIME: Record<string, [number, number]> = { N05: [7, 30], midday: [12, 30], N09: [18, 30] };

/**
 * `?now=<ISO>` freezes the clock — in fixture mode only (W2 review): against a real helper the clock is the real one,
 * whatever the address says. Null: not fixture mode, or no (readable) `now`.
 */
export function fixtureNow(search: string, fixtureMode: boolean): number | null {
  if (!fixtureMode) return null;
  const v = new URLSearchParams(search).get('now');
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/** The frozen clock of a fixture scenario (local time). */
export function scenarioClock(scenario: string | null | undefined): number {
  const [h, m] = SCENARIO_TIME[String(scenario)] ?? [9, 10];
  return new Date(2026, 10, 9, h, m).getTime();
}
