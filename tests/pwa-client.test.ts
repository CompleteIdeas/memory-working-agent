// v2 build, slices P1/P2: the page's side. The update machine (web/src/pwa/update.ts): a waiting worker shows
// "A new version is ready", Reload makes it take over and reloads ONCE, a page that already runs the new build takes
// it quietly, the 426 path looks for a worker first; install advice in plain words (install.ts); the offline banner's
// words (offline.ts); and the banners and the install card rendered from a real store.
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initialUpdate, reduceUpdate, updateWords, type UpdateEvent, type UpdateState, type Effect } from '../web/src/pwa/update';
import { installAdvice, installWay, isIos, secureAddress } from '../web/src/pwa/install';
import { offlineWords, savedWhen, waitingLine } from '../web/src/pwa/offline';
import { pageEntry, registersWorker } from '../web/src/pwa/register';
import { MwaClient } from '../web/src/v2/api/client';
import { V2Store, type StoreState, type StreamLike } from '../web/src/v2/store/core';
import { MemoryCache } from '../web/src/v2/store/cache';
import { StoreProvider } from '../web/src/v2/store/react';
import { OfflineBar, UpdateBar } from '../web/src/v2/shell/Shell';
import { InstallCard } from '../web/src/v2/screens/settings/InstallCard';
import { FixtureServer, FixtureEventSource, fixtureFetch } from '../web/src/v2/dev/fixtures';
import { FIXTURE_NOW } from '../web/src/v2/dev/fixture-data';

function play(events: UpdateEvent[], from: UpdateState = initialUpdate) {
  let s = from; const effects: Effect[] = [];
  for (const e of events) { const r = reduceUpdate(s, e); s = r.state; effects.push(...r.effects); }
  return { s, effects };
}

describe('the update machine', () => {
  it('a new build\'s worker waiting: "A new version is ready" — nothing reloads by itself', () => {
    const { s, effects } = play([{ type: 'waiting', pageRunsIt: false }]);
    expect(s).toMatchObject({ phase: 'ready', reason: 'worker', waiting: true });
    expect(effects).toEqual([]);
    expect(updateWords(s)).toEqual({ text: 'A new version is ready', button: 'Reload' });
  });
  it('Reload: the worker takes over (SKIP_WAITING), then the page reloads once when it controls the page', () => {
    const a = play([{ type: 'waiting', pageRunsIt: false }, { type: 'apply' }]);
    expect(a.s.phase).toBe('applying');
    expect(a.effects).toEqual(['skip-waiting', 'arm-timeout']);
    const b = play([{ type: 'controller-changed', hadController: true }], a.s);
    expect(b.s.phase).toBe('reloading');
    expect(b.effects).toEqual(['reload']);
    // a second controllerchange, a second tap, a late timeout: no second reload
    const c = play([{ type: 'controller-changed', hadController: true }, { type: 'apply' }, { type: 'apply-timeout' }], b.s);
    expect(c.effects).toEqual([]);
  });
  it('a worker that never takes over still gets the reload, once', () => {
    const { effects } = play([{ type: 'waiting', pageRunsIt: false }, { type: 'apply' }, { type: 'apply-timeout' }, { type: 'apply-timeout' }]);
    expect(effects.filter((e) => e === 'reload')).toHaveLength(1);
  });
  it('a double tap on Reload sends one SKIP_WAITING', () => {
    const { effects } = play([{ type: 'waiting', pageRunsIt: false }, { type: 'apply' }, { type: 'apply' }]);
    expect(effects.filter((e) => e === 'skip-waiting')).toHaveLength(1);
  });
  it('the page already runs the waiting build (it loaded index.html from the network after a deploy): taken quietly', () => {
    const a = play([{ type: 'waiting', pageRunsIt: true }]);
    expect(a.s.phase).toBe('idle');
    expect(a.effects).toEqual(['skip-waiting']);
    const b = play([{ type: 'controller-changed', hadController: true }], a.s);
    expect(b.s.phase).toBe('idle'); // not news, no reload
    expect(b.effects).toEqual([]);
  });
  it('the first install claiming the page is not an update', () => {
    expect(play([{ type: 'controller-changed', hadController: false }]).s.phase).toBe('idle');
  });
  it('another tab took the update: this page is the old build now and offers Reload', () => {
    const { s, effects } = play([{ type: 'controller-changed', hadController: true }]);
    expect(s.phase).toBe('ready');
    expect(effects).toEqual([]);
    // Reload with nothing waiting any more: look, find nothing, reload
    const r = play([{ type: 'apply' }, { type: 'checked', found: false }], s);
    expect(r.effects).toEqual(['check', 'reload']);
  });
  it('426 from the API: the same banner, and it looks for the new worker first', () => {
    const a = play([{ type: 'server-too-old' }]);
    expect(a.s).toMatchObject({ phase: 'ready', reason: 'server' });
    expect(a.effects).toEqual(['check']);
    expect(updateWords(a.s)!.text).toBe('A new version is ready');
    // found: it waits like any other; Reload then takes it over
    const b = play([{ type: 'checked', found: true }, { type: 'waiting', pageRunsIt: false }, { type: 'apply' }], a.s);
    expect(b.effects).toEqual(['skip-waiting', 'arm-timeout']);
    // tapped before the worker finished installing: it takes over as soon as it is waiting
    const c = play([{ type: 'apply' }, { type: 'checked', found: true }, { type: 'waiting', pageRunsIt: false }], a.s);
    expect(c.effects).toEqual(['check', 'skip-waiting', 'arm-timeout']);
    // nothing new to fetch (the server wants a client nobody has deployed): a plain reload
    const d = play([{ type: 'apply' }, { type: 'checked', found: false }], a.s);
    expect(d.effects).toEqual(['check', 'reload']);
  });
  it('a 426 while a worker is already waiting changes nothing', () => {
    const a = play([{ type: 'waiting', pageRunsIt: false }]);
    expect(play([{ type: 'server-too-old' }], a.s)).toEqual({ s: a.s, effects: [] });
  });
});

describe('install advice', () => {
  const pixel = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36';
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile/15E148 Safari/604.1';
  const iphoneChrome = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 CriOS/131.0 Mobile/15E148 Safari/604.1';
  const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15';
  it('picks the way this browser installs', () => {
    expect(installWay({ secure: true, standalone: true, canPrompt: true, userAgent: pixel })).toBe('installed');
    expect(installWay({ secure: false, standalone: false, canPrompt: false, userAgent: pixel })).toBe('insecure');
    expect(installWay({ secure: true, standalone: false, canPrompt: true, userAgent: pixel })).toBe('prompt');
    expect(installWay({ secure: true, standalone: false, canPrompt: false, userAgent: pixel })).toBe('menu');
    expect(installWay({ secure: true, standalone: false, canPrompt: false, userAgent: iphone })).toBe('ios-safari');
    expect(installWay({ secure: true, standalone: false, canPrompt: false, userAgent: iphoneChrome })).toBe('ios-other');
    expect(isIos(ipad, 5)).toBe(true);
    expect(isIos(ipad, 0)).toBe(false);
  });
  it('says it in plain words, with the secure address when it is known', () => {
    expect(installAdvice('ios-safari').lines.join(' ')).toMatch(/Share.*Add to Home Screen/);
    expect(installAdvice('prompt').button).toBe('Install');
    expect(installAdvice('insecure').lines[0]).toBe('Your phone needs the secure address to install — open https://<your-helper>.<your-tailnet>.ts.net');
    expect(installAdvice('insecure', 'https://mwa.tail1a2b.ts.net/').lines[0]).toBe('Your phone needs the secure address to install — open https://mwa.tail1a2b.ts.net');
    expect(secureAddress('http://100.64.0.3:7788')).toMatch(/<your-helper>/); // an http address is no help
  });
});

describe('the offline banner\'s words', () => {
  const nine10 = new Date(2026, 10, 9, 9, 10).getTime();
  it('"Offline · showing what I had at 9:10 AM", and what waits to be sent', () => {
    expect(offlineWords({ connection: 'offline', updatedAt: nine10, waiting: 2, now: nine10 + 3_600_000 })).toEqual({
      head: 'Offline · showing what I had at 9:10 AM', waiting: '2 things will be sent when you’re back online',
    });
    expect(waitingLine(1)).toBe('1 thing will be sent when you’re back online');
    expect(waitingLine(0)).toBeNull();
  });
  it('the helper unreachable (computer asleep, Tailscale off) says so; nothing for live, sign-in or an update', () => {
    expect(offlineWords({ connection: 'unreachable', updatedAt: nine10, waiting: 1, now: nine10 })).toEqual({
      head: 'Can’t reach your helper · showing what I had at 9:10 AM', waiting: '1 thing will be sent when I can reach your helper',
    });
    expect(offlineWords({ connection: 'live', updatedAt: nine10, waiting: 0, now: nine10 })).toBeNull();
    expect(offlineWords({ connection: 'unreachable', updatedAt: nine10, waiting: 0, now: nine10, blocked: true })).toBeNull();
    expect(offlineWords({ connection: 'offline', updatedAt: null, waiting: 0, now: nine10 })!.head).toBe('Offline · nothing saved on this device yet');
  });
  it('an older copy says which day', () => {
    expect(savedWhen(nine10, nine10 + 86_400_000)).toBe('yesterday at 9:10 AM');
    expect(savedWhen(nine10, nine10 + 3 * 86_400_000)).toBe('on Mon, Nov 9 at 9:10 AM');
  });
});

describe('registering the worker', () => {
  it('a production browser page registers it; the desktop app, dev, a share link and a popped-out file do not', () => {
    const o = { prod: true, desktop: false, v2: true };
    expect(registersWorker('/', o)).toBe(true);
    expect(registersWorker('/', { ...o, desktop: true })).toBe(false);
    expect(registersWorker('/', { ...o, prod: false })).toBe(false);
    expect(registersWorker('/s/abc', o)).toBe(false);
    expect(registersWorker('/view', o)).toBe(false);
  });
  it('knows the entry script the page loaded, as the worker lists it', () => {
    const doc = { querySelector: () => ({ getAttribute: () => './assets/index-AbCd1234.js' }) } as unknown as Document;
    expect(pageEntry(doc)).toBe('assets/index-AbCd1234.js');
    expect(pageEntry({ querySelector: () => null } as unknown as Document)).toBeNull();
  });
});

describe('the banners and the install card, rendered from the store', () => {
  function store(patch: Partial<StoreState>) {
    const fx = new FixtureServer('N00');
    const s = new V2Store({ client: new MwaClient({ fetch: fixtureFetch(fx) }), cache: new MemoryCache(), stream: (u) => new FixtureEventSource(fx, u) as unknown as StreamLike, now: () => FIXTURE_NOW, fixtures: true });
    (s as unknown as { set(p: Partial<StoreState>): void }).set(patch);
    return s;
  }
  const render = (s: V2Store, el: ReturnType<typeof h>) => renderToStaticMarkup(h(StoreProvider, { store: s }, el)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const queued = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, key: `k${i}`, kind: 'job.stop' as const, args: { id: `j${i}` }, label: 'Stop', createdAt: FIXTURE_NOW, attempts: 0 }));
  it('offline: the saved copy\'s time and the count waiting', () => {
    const s = store({ connection: 'offline', updatedAt: FIXTURE_NOW, outbox: queued(2) });
    expect(render(s, h(OfflineBar))).toBe('Offline · showing what I had at 9:10 AM 2 things will be sent when you’re back online');
    expect(render(store({ connection: 'live' }), h(OfflineBar))).toBe('');
  });
  it('426: "A new version is ready · Reload"', () => {
    expect(render(store({ updateReady: true }), h(UpdateBar))).toBe('A new version is ready Reload');
    expect(render(store({}), h(UpdateBar))).toBe('');
  });
  it('the install card on an address the phone will not install from', () => {
    expect(render(store({}), h(InstallCard))).toContain('Your phone needs the secure address to install — open https://&lt;your-helper&gt;.&lt;your-tailnet&gt;.ts.net');
  });
});
