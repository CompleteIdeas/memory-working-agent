/**
 * Settings → Voice, kept on this device only (localStorage `mwa-v2-voice`): voice on or off, and the language to listen
 * for ('' = this browser's language). A tiny store so the dock, the Ask sheet and Settings agree at once.
 */
export interface VoicePrefs { on: boolean; lang: string }
export const VOICE_PREFS_KEY = 'mwa-v2-voice';
export const DEFAULT_VOICE_PREFS: VoicePrefs = { on: true, lang: '' };

/** Languages offered (the browser's own is the default). Recognition support differs by browser. */
export const VOICE_LANGS: { code: string; name: string }[] = [
  { code: 'en-US', name: 'English (US)' }, { code: 'en-GB', name: 'English (UK)' }, { code: 'en-AU', name: 'English (Australia)' },
  { code: 'en-CA', name: 'English (Canada)' }, { code: 'es-ES', name: 'Español (España)' }, { code: 'es-MX', name: 'Español (México)' },
  { code: 'fr-FR', name: 'Français' }, { code: 'de-DE', name: 'Deutsch' }, { code: 'it-IT', name: 'Italiano' },
  { code: 'pt-BR', name: 'Português (Brasil)' }, { code: 'nl-NL', name: 'Nederlands' }, { code: 'sv-SE', name: 'Svenska' },
  { code: 'pl-PL', name: 'Polski' }, { code: 'ja-JP', name: '日本語' }, { code: 'zh-CN', name: '中文 (普通话)' }, { code: 'hi-IN', name: 'हिन्दी' },
];

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
const storage = (): StorageLike | null => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } };

export function parseVoicePrefs(raw: string | null | undefined): VoicePrefs {
  if (!raw) return DEFAULT_VOICE_PREFS;
  try {
    const v = JSON.parse(raw) as Partial<VoicePrefs>;
    const lang = typeof v.lang === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(v.lang) ? v.lang : '';
    return { on: v.on !== false, lang };
  } catch { return DEFAULT_VOICE_PREFS; }
}

const listeners = new Set<() => void>();
let current: VoicePrefs | null = null;

export function readVoicePrefs(s: StorageLike | null = storage()): VoicePrefs {
  if (current) return current;
  let raw: string | null = null;
  try { raw = s?.getItem(VOICE_PREFS_KEY) ?? null; } catch { /* private mode */ }
  current = parseVoicePrefs(raw);
  return current;
}

export function writeVoicePrefs(p: Partial<VoicePrefs>, s: StorageLike | null = storage()) {
  current = { ...readVoicePrefs(s), ...p };
  try { s?.setItem(VOICE_PREFS_KEY, JSON.stringify(current)); } catch { /* private mode: this visit only */ }
  for (const fn of [...listeners]) fn();
}

export function subscribeVoicePrefs(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => { if (e.key === VOICE_PREFS_KEY) { current = null; fn(); } };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => { listeners.delete(fn); if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage); };
}

/** For tests: forget the cached value. */
export function resetVoicePrefsCache() { current = null; }
