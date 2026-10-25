import { useEffect, useState } from 'react';
import { getRuns, type RunLog } from '../api';
import { parseRevision, shortenPaths, whenShort } from '../tasks';

/** What the person asked, out of the instruction a run was given (F11): the run log keeps the whole prompt, with the
 *  carried conversation, file notes and work notes the server adds. */
export function ownerWords(instruction: string): string {
  let t = instruction;
  const nr = /New request:\s*([\s\S]*)$/.exec(t); if (nr) t = nr[1];
  t = t.split(/\s*\((?:Files you write|Work you are doing|NOTE:|The answer to revise)/)[0];
  t = t.replace(/\n\nNOTE: It's unclear[\s\S]*$/, '');
  if (/^Call goal_note for goal/i.test(t)) return 'Background: noted where a piece of work stands';
  if (/^Recent conversation so far:/i.test(t)) return 'A follow-up in a conversation';
  const rev = parseRevision(t); if (rev) return `Revise “${rev.title}”: ${rev.change}`;
  return shortenPaths(t.replace(/\s+/g, ' ').trim()).slice(0, 220);
}
const REASON: Record<string, string> = { done: 'done', stopped: 'stopped by you', offer: 'offered to run in the background' };

/** The activity log (specialist detail, in Settings): each run in the person's words, its outcome and cost. */
export function Log() {
  const [runs, setRuns] = useState<RunLog[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => { void getRuns().then(setRuns); }, []);
  if (!runs) return <p className="text-[14px] text-dim">Loading…</p>;
  if (!runs.length) return <p className="text-[14px] text-dim">No runs yet.</p>;
  const shown = all ? runs : runs.slice(0, 15);
  return (
    <div>
      <ul className="divide-y divide-line border-y border-line">
        {shown.map((r, i) => (
          <li key={i} className="py-2.5">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="text-[14.5px] flex-1 min-w-[200px] break-words">{ownerWords(r.instruction)}</span>
              <span className="text-[12px] text-dim whitespace-nowrap">{r.ts ? whenShort(r.ts) : ''}</span>
            </div>
            <div className="text-[12.5px] text-dim mt-0.5">
              {REASON[r.reason] ?? `could not finish (${r.reason})`} · {r.steps} step{r.steps === 1 ? '' : 's'} · {r.toolCalls ?? 0} tool call{r.toolCalls === 1 ? '' : 's'} · ${Number(r.costUsd ?? 0).toFixed(4)}{r.learned ? ` · learned ${r.learned}` : ''}
            </div>
          </li>
        ))}
      </ul>
      {runs.length > shown.length && <button className="btn small mt-2" onClick={() => setAll(true)}>Show all {runs.length}</button>}
    </div>
  );
}
