/**
 * Settings › Your assistant's data (v2 build, slice S2): GET /assistant and every change through the typed client,
 * each with its own Idempotency-Key. Keys are write-only: what is typed goes to the server and is cleared from the
 * screen; the settings only ever say whether a key is saved.
 *
 * The words are plain functions, tested without React (tests/web-v2-s2.test.ts).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SignInRequired, newKey, type AccessPreset, type AddFromNpm, type AssistantChange, type AssistantSettings, type InteractionStyle, type Me, type ModelChoices } from '../../api/client';
import { useStore } from '../../store/react';
import { isAdmin, messageOf, type ActOutcome } from './useSettings';

export type Provider = AssistantSettings['providers'][number];
export type ModelChoice = ModelChoices['models'][number];

export const PRESETS: { id: AccessPreset; label: string; detail: string }[] = [
  { id: 'locked-down', label: 'Locked-down', detail: 'Only its own workspace. Never runs commands.' },
  { id: 'assistant', label: 'Assistant', detail: 'Its workspace and the folders you add. Looks things up while you watch, and asks before running anything else.' },
  { id: 'developer', label: 'Developer', detail: 'Runs any command without asking. It can reach this computer, so approvals don’t protect you here.' },
];
export const STYLES: { id: InteractionStyle; label: string; detail: string }[] = [
  { id: 'guided', label: 'Guided', detail: 'Explains in plain words, suggests next steps, takes the lead, and learns about you.' },
  { id: 'direct', label: 'Direct', detail: 'Short and to the point. Leads with the answer, no extra suggestions.' },
];

export function providerLabel(a: AssistantSettings, id: string): string {
  return a.providers.find((p) => p.id === id)?.label ?? (id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Not set');
}
/** "openrouter" + "openai/gpt-6.1-sol" → "openrouter:openai/gpt-6.1-sol" (empty when nothing is set). */
export const specOf = (x: { provider: string; model: string }) => (x.model ? (x.provider ? `${x.provider}:${x.model}` : x.model) : '');

/** The line about adding plug-ins from npm, which depends on the brain. */
export function npmLine(x: AddFromNpm): string {
  return x.available ? `On. ${x.reviewer ?? 'Your AI'} checks each one before you decide.` : `Off. ${x.reason}`;
}
/** What picking this model does to adding plug-ins from npm (null when nothing changes, or it can't be told). */
export function npmAfterLine(m: ModelChoice | undefined, x: AddFromNpm): string | null {
  if (!m || m.npmAfter === null) return null;
  if (m.npmAfter === false && x.available) return 'With this model, adding plug-ins from npm turns off: it needs a stronger model to check them.';
  if (m.npmAfter === true && !x.available) return 'With this model, adding plug-ins from npm turns on.';
  return null;
}
/** The key field's hint for a provider. */
export function keyHint(p: Provider | undefined): string | null {
  if (!p || p.keyless) return null;
  return p.keySaved ? 'A key is saved. Leave this empty to keep it, or paste a new one.' : 'Paste your API key. It stays on the computer your helper runs on, and I never show it again.';
}
export function imageLine(a: AssistantSettings): string {
  return a.image.on ? specOf(a.image) : 'Off. Set one up and I can make pictures when you ask.';
}
export function noModelsLine(p: Provider | undefined, kind: 'chat' | 'image'): string {
  if (!p) return 'Pick a provider first.';
  if (kind === 'image') return `${p.label.replace(/ \(.*\)$/, '').replace(/, no key$/, '')} doesn’t offer image models with this key. OpenRouter has several: pick it above and load again.`;
  if (p.keyless) return 'No local models found. Is Ollama running?';
  return p.keySaved ? 'I couldn’t load the models. Check the key, or type the model’s name below.' : 'Paste your key first, then load the models.';
}
export function presetOf(id: AccessPreset) { return PRESETS.find((p) => p.id === id) ?? PRESETS[1]; }
export function styleOf(id: InteractionStyle) { return STYLES.find((s) => s.id === id) ?? STYLES[0]; }
export function folderPlaceholder(hosted: boolean, ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  if (hosted) return '/mnt/files';
  return /Win/i.test(ua) ? 'C:\\Users\\you\\Documents' : '/Users/you/Documents';
}

export interface AssistantData { me: Me | null; a: AssistantSettings | null; loading: boolean; error: string | null }

export function useAssistant() {
  const store = useStore();
  const client = store.client;
  const [data, setData] = useState<AssistantData>({ me: null, a: null, loading: true, error: null });
  const reload = useCallback(async () => {
    try {
      const [me, a] = await Promise.all([client.getMe(), client.getAssistant()]);
      setData({ me, a, loading: false, error: null });
    } catch (e) {
      if (e instanceof SignInRequired) { store.signedOut(); return; }
      setData((d) => ({ ...d, loading: false, error: messageOf(e) }));
    }
  }, [client, store]);
  useEffect(() => { void reload(); }, [reload]);

  const actions = useMemo(() => {
    const act = async (run: (key: string) => Promise<AssistantChange>): Promise<ActOutcome> => {
      try {
        const r = await run(newKey());
        setData((d) => ({ ...d, a: r.assistant }));
        return { ok: true, message: r.message };
      } catch (e) {
        if (e instanceof SignInRequired) { store.signedOut(); return { ok: false, message: e.message }; }
        return { ok: false, message: messageOf(e) };
      }
    };
    return {
      loadModels: async (provider: string, kind: 'chat' | 'image', key?: string): Promise<{ ok: true; models: ModelChoice[] } | { ok: false; message: string }> => {
        try { return { ok: true, models: (await client.listModels({ provider, kind, ...(key ? { key } : {}) }, { key: newKey() })).models }; }
        catch (e) { if (e instanceof SignInRequired) store.signedOut(); return { ok: false, message: messageOf(e) }; }
      },
      saveBrain: (provider: string, model: string, key?: string) => act((k) => client.saveBrain({ provider, model, ...(key ? { key } : {}) }, { key: k })),
      saveImage: (provider: string, model: string, key?: string) => act((k) => client.saveImageModel({ provider, model, ...(key ? { key } : {}) }, { key: k })),
      turnOffImages: () => act((k) => client.turnOffImages({ key: k })),
      setPreset: (preset: AccessPreset) => act((k) => client.setAccessLevel(preset, { key: k })),
      grant: (path: string) => act((k) => client.grantFolder(path, { key: k })),
      remove: (path: string) => act((k) => client.removeFolder(path, { key: k })),
      setStyle: (style: InteractionStyle) => act((k) => client.setStyle(style, { key: k })),
    };
  }, [client, store]);

  return { ...data, admin: isAdmin(data.me), reload, ...actions };
}
