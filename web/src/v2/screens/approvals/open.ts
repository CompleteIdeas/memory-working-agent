/**
 * Opening the approval sheet from anywhere (v2 build, slice S4): Today's "Needs you" card, the working sheet (a job's
 * Review, the "Needs your OK" group), Important's Review, and a tapped "Something needs your OK" notification
 * (#/approval/<id>). One window event, so no screen needs the shell's state threaded through it; the shell listens.
 * `id` null opens the list of everything waiting.
 */
import { useEffect } from 'react';

const EVENT = 'mwa-open-approval';

export function openApproval(id: string | null): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { id } }));
}

export function useApprovalOpener(onOpen: (id: string | null) => void): void {
  useEffect(() => {
    const h = (e: Event) => {
      const id = (e as CustomEvent<{ id?: unknown }>).detail?.id;
      onOpen(typeof id === 'string' && id ? id : null);
    };
    window.addEventListener(EVENT, h);
    return () => window.removeEventListener(EVENT, h);
  }, [onOpen]);
}
