/** The prototype's icons (prototype-v2/app.js `I` and index.html), as components. All decorative: aria-hidden. */
const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export const Spark = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" fill="currentColor" /></svg>
);
export const Close = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth={2} strokeLinecap="round" /></svg>
);
export const Mic = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" {...S} /></svg>
);
export const Arrow = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" /></svg>
);
export const Back = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" /></svg>
);
export const Chev = () => (
  <svg className="chevron" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></svg>
);
export const Person = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="3.6" {...S} /><path d="M5 19.5c1.3-3.2 4-4.8 7-4.8s5.7 1.6 7 4.8" {...S} /></svg>
);
export const TabToday = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth={1.8} /><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" /></svg>
);
export const TabCalendar = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="3" fill="none" stroke="currentColor" strokeWidth={1.8} /><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" /></svg>
);
export const TabImportant = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" /></svg>
);
export const TabProjects = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" /></svg>
);
const PROJ: Record<string, string> = {
  horse: 'M7 20l1.5-6L6 11l2-6 5 1.5 3 3.5 2 1-1 2.5-3-1-1.5 2.5V20',
  home: 'M4 11l8-6.5 8 6.5V20h-5v-5.5h-6V20H4z',
  leaf: 'M5 19c0-8 5-13 14-14-1 9-6 14-14 14zM5 19l7-7',
  heart: 'M12 19.5s-7.5-4.4-7.5-10A4 4 0 0 1 12 7.2a4 4 0 0 1 7.5 2.3c0 5.6-7.5 10-7.5 10z',
};
export const ProjectIcon = ({ name }: { name: string | null }) => {
  if (name === 'spark') return <Spark size={20} />;
  const d = PROJ[name ?? ''];
  if (!d) return <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4" width="14" height="16" rx="2.5" {...S} /><path d="M9 9h6M9 13h6M9 17h3" {...S} /></svg>;
  return <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d={d} {...S} /></svg>;
};
