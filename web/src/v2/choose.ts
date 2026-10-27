/**
 * Which UI to show (v2 build, slice W1): `?ui=v1` / `?ui=v2` (remembered by App.tsx in localStorage `mwa-ui`),
 * fixture mode (`?fixtures=1`) implies v2, else what was remembered; v1 is the default until W6. Kept out of the
 * lazy v2 chunk: App.tsx needs it before that chunk loads.
 */
export function chooseUi(search: string, stored: string | null, pathname = '/'): 'v1' | 'v2' {
  const q = new URLSearchParams(search);
  if (/^\/pair\/?$/.test(pathname)) return 'v2'; // W5: the pairing link (a phone that has never opened MWA) is the v2 app's
  const ui = q.get('ui');
  if (ui === 'v1' || ui === 'v2') return ui;
  if (q.get('fixtures') === '1') return 'v2';
  return stored === 'v2' ? 'v2' : 'v1';
}
