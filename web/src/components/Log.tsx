import { useEffect, useState } from 'react';
import { getRuns, getSchedule, type RunLog } from '../api';

function when(due: number, recur: string | null): string {
  if (recur?.startsWith('every:')) return `every ${recur.slice(6)} min`;
  if (recur?.startsWith('daily:')) return `daily at ${recur.slice(6)}`;
  try { return new Date(due).toLocaleString(); } catch { return 'soon'; }
}

// Review-and-iterate surface: what's SCHEDULED to run, and a record of every run so you
// can watch responses get better and learning accumulate (steps down, learned up).
export function Log() {
  const [runs, setRuns] = useState<RunLog[] | null>(null);
  const [scheduled, setScheduled] = useState<{ instruction: string; due: number; recur: string | null }[]>([]);
  useEffect(() => { getRuns().then(setRuns); getSchedule().then(setScheduled); }, []);

  if (!runs) return <div className="py-16 mono text-dim text-sm">loading…</div>;

  return (
    <div className="py-8 space-y-8">
      {scheduled.length > 0 && (
        <div>
          <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-3">scheduled · {scheduled.length}</div>
          <div className="space-y-2">
            {scheduled.map((s, i) => (
              <div key={i} className="flex justify-between gap-3 items-baseline rounded-[4px] border border-line bg-surface px-4 py-2.5">
                <span className="text-[15px]">{s.instruction}</span>
                <span className="mono text-[11px] text-signal whitespace-nowrap">{when(s.due, s.recur)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div>
        <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-3">recent runs · {runs.length}</div>
        {runs.length === 0 ? (
          <div className="text-dim">No runs logged yet. Ask me something and it'll show up here.</div>
        ) : (
          <div className="divide-y divide-line">
            {runs.map((r, i) => (
              <div key={i} className="py-3">
                <div className="flex justify-between gap-3 items-baseline">
                  <div className="text-[15px] truncate">{r.instruction}</div>
                  <div className="mono text-[11px] text-dim whitespace-nowrap">{r.reason} · {r.steps} steps</div>
                </div>
                <div className="mono text-[11px] text-dim mt-1">
                  learned {r.learned} · skills {r.skills} · questions {r.questions} · ${Number(r.costUsd ?? 0).toFixed(4)}
                </div>
                {r.summary && <div className="text-dim text-[13px] mt-1">{r.summary}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
