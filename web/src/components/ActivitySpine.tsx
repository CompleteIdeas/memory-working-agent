import { motion, AnimatePresence } from 'framer-motion';
import type { SpineStep } from '../api';

// Instrument readout: the agent's work as a numbered mono log. Memory moments
// (recall/learn/think) tick in signal-orange; the live row blinks a signal caret.
const DOT: Record<string, string> = {
  recall: 'text-signal', learn: 'text-signal', think: 'text-signal', act: 'text-dim', done: 'text-dim',
};

export function ActivitySpine({ steps, live }: { steps: SpineStep[]; live: boolean }) {
  if (!steps.length && !live) return null;
  // Collapse consecutive same-label steps into one row with a ×N count, so a chatty run
  // (e.g. several recalls in a row) reads as a clean timeline, not a wall of repeats.
  const rows: (SpineStep & { count: number })[] = [];
  for (const s of steps) {
    const last = rows[rows.length - 1];
    if (last && last.label === s.label) { last.count++; if (s.detail) last.detail = s.detail; }
    else rows.push({ ...s, count: 1 });
  }
  return (
    <div className="mono text-[13px] leading-relaxed">
      <AnimatePresence initial={false}>
        {rows.map((s, i) => (
          <motion.div
            key={s.id}
            initial={{ opacity: 0, x: -3 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="flex items-baseline gap-2"
          >
            <span className="text-dim tabular-nums">{String(i + 1).padStart(2, '0')}</span>
            <span className={DOT[s.tone] ?? 'text-dim'}>·</span>
            <span className="text-graphite">{s.label}{s.count > 1 && <span className="text-dim"> ×{s.count}</span>}</span>
            {s.detail && <span className="text-dim truncate max-w-[55%]">{s.detail}</span>}
          </motion.div>
        ))}
      </AnimatePresence>
      {live && (
        <div className="flex items-center gap-2 text-dim">
          <span className="tabular-nums">{String(steps.length + 1).padStart(2, '0')}</span>
          <motion.span
            className="inline-block w-[7px] h-[14px] bg-signal translate-y-[2px]"
            animate={{ opacity: [1, 0.15, 1] }}
            transition={{ repeat: Infinity, duration: 1 }}
          />
          <span>working</span>
        </div>
      )}
    </div>
  );
}
