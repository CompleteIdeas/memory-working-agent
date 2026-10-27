/**
 * "Install on this phone" (v2 build, slice P1): what this browser can do, in plain words. Pure, unit-tested in
 * tests/pwa-install.test.ts; register.ts keeps the browser's install prompt (beforeinstallprompt) for the button.
 */

export type InstallWay =
  /** already opened from the home screen (or installed on this computer) */
  | 'installed'
  /** Chrome, Edge, Samsung Internet: the browser's own Install, from our button */
  | 'prompt'
  /** iPhone or iPad Safari: Share › Add to Home Screen */
  | 'ios-safari'
  /** iPhone or iPad, another browser (they cannot install; Safari can) */
  | 'ios-other'
  /** not a secure address (http://100.x… or a LAN name): the phone refuses to install */
  | 'insecure'
  /** a secure address, but no prompt (yet): the browser's menu */
  | 'menu';

export interface InstallFacts {
  secure: boolean;
  /** display-mode standalone, or iOS navigator.standalone */
  standalone: boolean;
  /** a beforeinstallprompt event is being held */
  canPrompt: boolean;
  userAgent: string;
  /** maxTouchPoints, to tell an iPad that says it is a Mac */
  touchPoints?: number;
}

export function isIos(ua: string, touchPoints = 0): boolean {
  return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && touchPoints > 1);
}

export function installWay(f: InstallFacts): InstallWay {
  if (f.standalone) return 'installed';
  if (!f.secure) return 'insecure';
  if (isIos(f.userAgent, f.touchPoints)) return /CriOS|FxiOS|EdgiOS|OPiOS/i.test(f.userAgent) ? 'ios-other' : 'ios-safari';
  if (f.canPrompt) return 'prompt';
  return 'menu';
}

/**
 * The secure address to give a phone that is on an insecure one. `publicUrl` is the helper's https address when the
 * server knows it (MWA_PUBLIC_URL); otherwise a template the person fills in with their own names.
 */
export function secureAddress(publicUrl?: string | null): string {
  if (publicUrl && /^https:\/\//i.test(publicUrl)) return publicUrl.replace(/\/+$/, '');
  return 'https://<your-helper>.<your-tailnet>.ts.net';
}

export interface InstallAdvice { title: string; lines: string[]; button?: string }

export function installAdvice(way: InstallWay, publicUrl?: string | null): InstallAdvice {
  switch (way) {
    case 'installed':
      return { title: 'Installed on this device', lines: ['You opened MWA from your home screen. It works offline with what it last saw.'] };
    case 'prompt':
      return { title: 'Install on this phone', lines: ['Put MWA on your home screen. It opens full screen, like any app, and works offline with what it last saw.'], button: 'Install' };
    case 'ios-safari':
      return {
        title: 'Install on this phone',
        lines: ['Tap the Share button (the square with an arrow, at the bottom of Safari).', 'Scroll down and tap Add to Home Screen, then Add.', 'Open MWA from the new icon on your home screen.'],
      };
    case 'ios-other':
      return { title: 'Install on this phone', lines: ['On iPhone and iPad, only Safari can put MWA on your home screen. Open this page in Safari, then tap Share › Add to Home Screen.'] };
    case 'insecure':
      return {
        title: 'Install on this phone',
        lines: [`Your phone needs the secure address to install — open ${secureAddress(publicUrl)}`, 'That address works only on devices signed in to your Tailscale.'],
      };
    case 'menu':
      return { title: 'Install on this phone', lines: ['Open your browser’s menu and choose Install app (or Add to Home screen).'] };
  }
}
