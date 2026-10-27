/**
 * The quiet offline banner's words (v2 build, slice P2), pure so they are unit-tested (tests/pwa-offline.test.ts):
 *   "Offline · showing what I had at 9:10 AM"
 *   "2 things will be sent when you're back online"
 * Shown while the device is offline, or the helper can't be reached (the computer asleep, Tailscale off), never for a
 * sign-in or an update (those have their own screens).
 */
export type Conn = 'starting' | 'connecting' | 'live' | 'offline' | 'unreachable';

export interface OfflineFacts {
  connection: Conn;
  /** when the cache last caught up with the server (ms), or null if it never has */
  updatedAt: number | null;
  /** actions waiting in the outbox */
  waiting: number;
  now: number;
  /** a sign-in or an update owns the screen */
  blocked?: boolean;
}

const time = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
function sameDay(a: number, b: number) {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** When the saved copy is from: "at 9:10 AM" today, "yesterday at 6:02 PM", "on Mon, Nov 9 at 9:10 AM". */
export function savedWhen(updatedAt: number, now: number): string {
  if (sameDay(updatedAt, now)) return `at ${time(updatedAt)}`;
  if (sameDay(updatedAt, now - 86_400_000)) return `yesterday at ${time(updatedAt)}`;
  const d = new Date(updatedAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return `on ${d} at ${time(updatedAt)}`;
}

export function waitingLine(n: number): string | null {
  if (n <= 0) return null;
  return `${n === 1 ? '1 thing' : `${n} things`} will be sent when you’re back online`;
}

export function offlineWords(f: OfflineFacts): { head: string; waiting: string | null } | null {
  if (f.blocked) return null;
  if (f.connection !== 'offline' && f.connection !== 'unreachable') return null;
  const lead = f.connection === 'offline' ? 'Offline' : 'Can’t reach your helper';
  const saved = f.updatedAt ? `showing what I had ${savedWhen(f.updatedAt, f.now)}` : 'nothing saved on this device yet';
  const waiting = f.waiting > 0 ? (f.connection === 'offline' ? waitingLine(f.waiting) : `${f.waiting === 1 ? '1 thing' : `${f.waiting} things`} will be sent when I can reach your helper`) : null;
  return { head: `${lead} · ${saved}`, waiting };
}
