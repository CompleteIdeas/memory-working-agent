/** React views of the page's service-worker and install state (register.ts). */
import { useSyncExternalStore } from 'react';
import { canPromptInstall, getUpdate, isStandalone, subscribePwa, wasJustInstalled } from './register';
import type { UpdateState } from './update';

export function useUpdate(): UpdateState {
  return useSyncExternalStore(subscribePwa, getUpdate, getUpdate);
}

export function useInstallState(): { canPrompt: boolean; standalone: boolean; justInstalled: boolean } {
  const canPrompt = useSyncExternalStore(subscribePwa, canPromptInstall, canPromptInstall);
  const justInstalled = useSyncExternalStore(subscribePwa, wasJustInstalled, wasJustInstalled);
  return { canPrompt, standalone: isStandalone(), justInstalled };
}
