/** The Important list's small marks (prototype-v2/app.js `I.mail`, `I.paper`, `I.cal`, `I.check`, `I.link`), plus a
 *  warning triangle for caution items. All decorative: aria-hidden. */
import type { ImportantItem } from '../../api/client';
import { Spark } from '../../shell/icons';

const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export const MailIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="2" {...S} /><path d="M3.5 7l8.5 6 8.5-6" {...S} /></svg>
);
export const PaperIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h13v14H6a2 2 0 0 1-2-2zM17 9h3v8a2 2 0 0 1-2 2h-1M7.5 9h6M7.5 12.5h6M7.5 16h4" {...S} /></svg>
);
export const CalIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="3" {...S} /><path d="M3.5 10h17M8 3v4M16 3v4" {...S} /></svg>
);
export const CheckIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" /></svg>
);
export const LinkIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" /></svg>
);
export const WarnIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l9.5 16.5h-19z" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" /><path d="M12 10v4.5" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" /><circle cx="12" cy="17.3" r="1.2" fill="currentColor" /></svg>
);

/** The source mark: envelope (an email), newspaper (a newsletter), calendar, ✦ (your helper). */
export function SourceIcon({ source }: { source: ImportantItem['source'] }) {
  if (source === 'newsletter' || source === 'pdf') return <PaperIcon />;
  if (source === 'calendar-conflict' || source === 'calendar-change' || source === 'deadline') return <CalIcon />;
  if (source === 'job-result' || source === 'approval' || source === 'connection') return <Spark size={16} />;
  return <MailIcon />;
}
