/**
 * Small menus (W4: Project options, Move…): a click or tap outside closes them; the keyboard moves through them —
 * ArrowDown / ArrowUp (wrapping), Home / End, Escape closes and puts focus back on the button that opened the menu,
 * Tab closes. The first item gets focus when the menu opens.
 */
import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

export function useDismiss<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current(); };
    document.addEventListener('pointerdown', down);
    return () => document.removeEventListener('pointerdown', down);
  }, [open]);
  return ref;
}

/** Keyboard handling for a `role="menu"` element; `trigger` gets focus back on Escape. */
export function menuKeys(trigger: RefObject<HTMLElement | null>, close: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
    switch (e.key) {
      case 'ArrowDown': go(i + 1); break;
      case 'ArrowUp': go(i < 0 ? items.length - 1 : i - 1); break;
      case 'Home': go(0); break;
      case 'End': go(items.length - 1); break;
      case 'Escape': e.preventDefault(); close(); trigger.current?.focus(); break;
      case 'Tab': close(); break;
      default: break;
    }
  };
}
