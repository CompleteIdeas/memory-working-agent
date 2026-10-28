/** W5: Settings asks the start gate to look again (after "Start the welcome again"). */
export const START_CHECK_EVENT = 'mwa-v2-start-check';
/** S6: go to a screen of the app from outside it (first run's "Open Connections when I finish"): detail { view }. */
export const GO_EVENT = 'mwa-v2-go';
export function goTo(view: string): void { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(GO_EVENT, { detail: { view } })); }
