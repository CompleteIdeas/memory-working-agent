/**
 * Which UI to show (v2 build, slice W1): `?ui=v1` / `?ui=v2` (remembered by App.tsx in localStorage `mwa-ui`),
 * fixture mode (`?fixtures=1`) implies v2, else what was remembered. Since W6 v2 is the default: only a remembered
 * `v1` (the classic app chosen in Settings) or `?ui=v1` opens v1, which stays for one release. Kept out of the lazy v2
 * chunk: App.tsx needs it before that chunk loads.
 */
export function chooseUi(search: string, stored: string | null, pathname = '/'): 'v1' | 'v2' {
  const q = new URLSearchParams(search);
  if (/^\/pair\/?$/.test(pathname)) return 'v2'; // W5: the pairing link (a phone that has never opened MWA) is the v2 app's
  const ui = q.get('ui');
  if (ui === 'v1' || ui === 'v2') return ui;
  if (q.get('fixtures') === '1') return 'v2';
  return stored === 'v1' ? 'v1' : 'v2';
}

/** What to remember in `mwa-ui` for this visit. W6: `?ui=v2` is remembered (it undoes a remembered classic choice),
 *  except from a tapped notification (`from=notification`, that visit only — P3 review) or the installed app's start
 *  URL (`source=pwa`). `?ui=v1` is NOT remembered:
 *  a link into the classic app (a connector's setup page, src/api/routes/settings.ts) opens it for that visit only,
 *  and the default stays the new app; only Settings' "Use the classic app" remembers v1. */
export function uiToRemember(search: string): 'v1' | 'v2' | null {
  const q = new URLSearchParams(search);
  if (q.get('ui') !== 'v2') return null;
  // the installed app's start URL (manifest-v2 `?ui=v2&source=pwa`) opens v2 but must not undo a classic choice
  return q.get('from') === 'notification' || q.get('source') === 'pwa' ? null : 'v2';
}
