/**
 * "A new version is ready · Reload" (v2 build, slice P2) as a pure state machine, unit-tested in
 * tests/pwa-update.test.ts. register.ts feeds it the browser's events and carries out its effects.
 *
 * Two ways a page learns it is old:
 *   - worker: a new service worker installed (a new build was deployed) and is WAITING. It never takes over by itself
 *     (no forced reload mid-action). If the page already runs that build (it loaded index.html from the network after
 *     the deploy), the worker is told to take over quietly: nothing changes for the person.
 *   - server: the API answered 426 (this client is older than the server's MIN_CLIENT). The page asks the browser to
 *     look for a new worker first, so the Reload does not just bring back the same cached build.
 * Reload (the person's tap): the waiting worker takes over (SKIP_WAITING), and the page reloads ONCE when the new
 * worker controls it. No worker waiting: look for one, then reload. A worker that never takes over (an old browser
 * quirk) still gets the reload after a short wait. The outbox lives in IndexedDB, so it is there after the reload.
 * Another tab that took the update: this page now runs a build its worker no longer serves; it shows Reload too.
 */

export type Phase = 'idle' | 'ready' | 'applying' | 'reloading';
export interface UpdateState {
  phase: Phase;
  /** why it is ready: a new build's worker, or the server said this client is too old */
  reason: 'worker' | 'server' | null;
  /** a worker is waiting that is not the build this page runs */
  waiting: boolean;
  /** a worker was told to take over quietly (the page already runs its build): its controllerchange is not news */
  quiet: boolean;
}
export type UpdateEvent =
  /** a worker is installed and waiting; `pageRunsIt`: its entry script is the one this page loaded */
  | { type: 'waiting'; pageRunsIt: boolean }
  /** the API said 426 */
  | { type: 'server-too-old' }
  /** the person tapped Reload */
  | { type: 'apply' }
  /** the result of looking for a new worker (after 'check') */
  | { type: 'checked'; found: boolean }
  /** navigator.serviceWorker's controllerchange; `hadController`: the page was controlled before it */
  | { type: 'controller-changed'; hadController: boolean }
  /** applying, and the worker did not take over in time */
  | { type: 'apply-timeout' };
export type Effect = 'skip-waiting' | 'reload' | 'check' | 'arm-timeout';

export const initialUpdate: UpdateState = { phase: 'idle', reason: null, waiting: false, quiet: false };

export function reduceUpdate(s: UpdateState, e: UpdateEvent): { state: UpdateState; effects: Effect[] } {
  const out = (state: UpdateState, ...effects: Effect[]) => ({ state, effects });
  if (s.phase === 'reloading') return out(s);
  switch (e.type) {
    case 'waiting':
      if (e.pageRunsIt) return out({ ...s, quiet: true }, 'skip-waiting');
      if (s.phase === 'applying') return out({ ...s, waiting: true }, 'skip-waiting', 'arm-timeout');
      return out({ ...s, waiting: true, phase: 'ready', reason: s.reason ?? 'worker' });
    case 'server-too-old':
      if (s.phase !== 'idle') return out(s);
      return out({ ...s, phase: 'ready', reason: 'server' }, 'check');
    case 'apply':
      if (s.phase === 'applying') return out(s);
      if (s.waiting) return out({ ...s, phase: 'applying' }, 'skip-waiting', 'arm-timeout');
      // nothing waiting (yet): look for a new build first; reload when that is answered
      return out({ ...s, phase: 'applying' }, 'check');
    case 'checked':
      if (s.phase !== 'applying' || e.found) return out(s); // found: its 'waiting' follows
      return out({ ...s, phase: 'reloading' }, 'reload');
    case 'controller-changed':
      if (!e.hadController) return out(s); // the first install claimed this page: not an update
      if (s.phase === 'applying') return out({ ...s, phase: 'reloading' }, 'reload');
      if (s.quiet) return out({ ...s, quiet: false });
      // another tab took the update: this page is the old build now
      return out({ ...s, phase: 'ready', reason: s.reason ?? 'worker', waiting: false });
    case 'apply-timeout':
      if (s.phase !== 'applying') return out(s);
      return out({ ...s, phase: 'reloading' }, 'reload');
  }
}

/** The banner's words. */
export function updateWords(s: UpdateState): { text: string; button: string } | null {
  if (s.phase === 'idle') return null;
  if (s.phase === 'ready') return { text: 'A new version is ready', button: 'Reload' };
  return { text: 'Updating…', button: 'Reload' };
}
