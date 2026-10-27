/**
 * v1's answer to a 401 (its session expired, e.g. the server restarted): reload, which the server answers with its
 * sign-in page. At most ONCE per browser session (review of P1/P2): if the reload still lands on the app — a cached
 * shell from the service worker, or a page the server lets through signed out — a second 401 shows a plain sign-in
 * notice here instead of reloading again, so a signed-out page can never reload forever.
 */
export const LOCKED_KEY = 'mwa-401-reloaded';

export interface LockedEnv {
  get(): string | null;
  set(v: string): void;
  reload(): void;
  showSignIn(): void;
}

export function onLocked(env: LockedEnv): 'reload' | 'sign-in' {
  let done = false;
  try { done = env.get() === '1'; } catch { done = true; /* no session storage: never risk a loop */ }
  if (done) { env.showSignIn(); return 'sign-in'; }
  try { env.set('1'); } catch { env.showSignIn(); return 'sign-in'; }
  env.reload();
  return 'reload';
}

/** A plain, accessible notice over the page: "Sign in to continue" and a button to the sign-in page. */
export function showSignInNotice(doc: Document = document): void {
  if (doc.getElementById('mwa-signin-notice')) return;
  const box = doc.createElement('div');
  box.id = 'mwa-signin-notice';
  box.setAttribute('role', 'alertdialog');
  box.setAttribute('aria-labelledby', 'mwa-signin-title');
  box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(232,230,225,.96);color:#1e2127;font:16px/1.5 system-ui,sans-serif;padding:16px';
  box.innerHTML = '<div style="max-width:420px;background:#f4f3ef;border:1px solid #c9c6bd;border-radius:12px;padding:24px">'
    + '<h1 id="mwa-signin-title" style="font-size:24px;margin:0 0 8px">Sign in to continue</h1>'
    + '<p style="margin:0 0 16px">You were signed out of your helper.</p>'
    + '<button type="button" style="font:inherit;font-weight:600;padding:10px 18px;border-radius:8px;border:0;background:#1e2127;color:#e8e6e1;cursor:pointer">Sign in</button></div>';
  box.querySelector('button')!.addEventListener('click', () => {
    // a deliberate tap: allow one more reload-on-401 after this navigation
    try { sessionStorage.removeItem(LOCKED_KEY); } catch { /* */ }
    location.assign('/');
  });
  doc.body.appendChild(box);
  (box.querySelector('button') as HTMLButtonElement).focus();
}

export function browserLocked(): 'reload' | 'sign-in' {
  return onLocked({
    get: () => sessionStorage.getItem(LOCKED_KEY),
    set: (v) => sessionStorage.setItem(LOCKED_KEY, v),
    reload: () => location.reload(),
    showSignIn: () => showSignInNotice(),
  });
}
