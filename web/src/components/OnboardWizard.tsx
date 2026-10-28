import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { onboardScan, onboardSave, type OnboardCandidate } from '../api';

/**
 * Warm-start wizard — turn a cold memory warm from the user's own material before
 * they ask their first question. Guided, plain-language (Mom-test), in the
 * "Instrument" system: bone/graphite, one signal color, mono numerals, hairlines.
 *
 * Flow: goal → point at folders/files → scan → REVIEW (edit + confirm each memory,
 * "make certain they're right before writing") → save.
 */

type Phase = 'goal' | 'sources' | 'scanning' | 'review' | 'saving' | 'done';

interface ReviewItem { key: string; concept: string; content: string; keep: boolean; source?: string }

const STEPS: { id: Phase; label: string }[] = [
  { id: 'goal', label: 'goal' },
  { id: 'sources', label: 'material' },
  { id: 'scanning', label: 'reading' },
  { id: 'review', label: 'review' },
  { id: 'done', label: 'ready' },
];

const field =
  'w-full rounded-[3px] border border-line bg-bone px-4 py-3 text-[15px] outline-none focus:border-signal transition-colors';
const area = field + ' resize-none leading-relaxed';

let seq = 0;
const nextKey = () => `oi-${++seq}`;

export function OnboardWizard(props: { onDone: () => void; onSkip?: () => void; onConnectService?: () => void }) {
  const [phase, setPhase] = useState<Phase>('goal');

  // Step 1 — the interview. Goal is the anchor; the rest are optional.
  const [goal, setGoal] = useState('');
  const [stack, setStack] = useState('');
  const [people, setPeople] = useState('');
  const [rules, setRules] = useState('');
  const [more, setMore] = useState(false);

  // Step 2 — sources.
  const [paths, setPaths] = useState<string[]>([]);
  const [pathInput, setPathInput] = useState('');

  // Step 3/4 — scan + review.
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [scanNote, setScanNote] = useState('');
  const [error, setError] = useState('');
  const [savedCount, setSavedCount] = useState(0);

  const stepIndex = Math.min(STEPS.findIndex((s) => s.id === phase), STEPS.length - 1);
  const displayIndex = phase === 'saving' ? 3 : phase === 'scanning' ? 2 : stepIndex < 0 ? 3 : stepIndex;

  function addPath() {
    const p = pathInput.trim();
    if (!p) return;
    setPaths((xs) => (xs.includes(p) ? xs : [...xs, p]));
    setPathInput('');
  }

  function interviewItems(): ReviewItem[] {
    const out: ReviewItem[] = [];
    const push = (concept: string, content: string) => {
      if (content.trim()) out.push({ key: nextKey(), concept, content: content.trim(), keep: true });
    };
    push('Goal of this memory', goal);
    push('Tech / domain', stack);
    push('Key people & systems', people);
    push('House rules & gotchas', rules);
    return out;
  }

  async function runScan() {
    setError('');
    setPhase('scanning');
    setScanNote('Reading your files…');
    let scanned: OnboardCandidate[] = [];
    if (paths.length) {
      const r = await onboardScan(paths);
      scanned = r.candidates ?? [];
      setScanNote(
        r.filesScanned
          ? `Read ${r.filesScanned} file${r.filesScanned === 1 ? '' : 's'} → ${scanned.length} draft${scanned.length === 1 ? '' : 's'}.`
          : "Couldn't find readable docs there — you can still keep the answers above.",
      );
    }
    const scannedItems: ReviewItem[] = scanned.map((c) => ({
      key: nextKey(),
      concept: c.concept,
      content: c.content,
      keep: true,
      source: c.source,
    }));
    setItems([...interviewItems(), ...scannedItems]);
    setPhase('review');
  }

  function skipToReview() {
    // No files — just review the interview answers.
    setItems(interviewItems());
    setScanNote('');
    setPhase('review');
  }

  async function save() {
    const keep = items.filter((i) => i.keep && i.content.trim());
    setPhase('saving');
    // S6 review: a note from a file says which file, so it stays a note from it (untrusted) even after editing
    const r = await onboardSave(keep.map((i) => ({ concept: i.concept, content: i.content, ...(i.source ? { source: i.source } : {}) })));
    setSavedCount(r.saved ?? keep.length);
    setPhase('done');
  }

  const keptCount = items.filter((i) => i.keep && i.content.trim()).length;

  return (
    <div className="py-10 max-w-2xl">
      {/* Instrument header: a mono step counter + a hairline progress rail */}
      <div className="flex items-center gap-3 mb-8">
        <div className="mono text-[11px] text-dim uppercase tracking-[0.2em]">
          warm‑start<span className="text-line"> / </span>
          <span className="text-graphite">{String(displayIndex + 1).padStart(2, '0')}</span>
          <span className="text-dim"> — {String(STEPS.length).padStart(2, '0')}</span>
          <span className="text-signal"> · {STEPS[Math.max(0, Math.min(displayIndex, STEPS.length - 1))].label}</span>
        </div>
        <div className="flex-1 flex gap-1">
          {STEPS.map((s, i) => (
            <div
              key={s.id}
              className="h-[3px] flex-1 rounded-full transition-colors duration-500"
              style={{ background: i < displayIndex ? 'var(--color-graphite)' : i === displayIndex ? 'var(--color-signal)' : 'var(--color-line)' }}
            />
          ))}
        </div>
      </div>

      <AnimatePresence mode="wait">
        {/* ── 1 · GOAL ─────────────────────────────────────────── */}
        {phase === 'goal' && (
          <motion.div key="goal" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.35 }}>
            <h1 className="text-4xl font-semibold tracking-tight leading-[1.05] mb-2">Let's warm up your memory.</h1>
            <p className="text-dim mb-6">A few quick answers and a look at your docs, and I'll be useful from your very first question — instead of learning everything from scratch.</p>

            <label className="block mb-2 font-medium">What should I get good at? What's the goal here?</label>
            <textarea autoFocus value={goal} onChange={(e) => setGoal(e.target.value)} rows={3}
              placeholder="e.g. Help me answer support questions accurately from our own data and rules."
              className={area} />

            <button onClick={() => setMore((m) => !m)} className="mt-4 mono text-[11px] text-dim uppercase tracking-[0.18em] hover:text-signal transition-colors">
              {more ? '– fewer questions' : '+ a few more (optional)'}
            </button>

            <AnimatePresence>
              {more && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                  <div className="space-y-4 pt-4">
                    <div>
                      <label className="block mb-1.5 text-sm text-dim">What's the tech, stack, or domain?</label>
                      <input value={stack} onChange={(e) => setStack(e.target.value)} placeholder="e.g. Node + Postgres; internal invoicing" className={field} />
                    </div>
                    <div>
                      <label className="block mb-1.5 text-sm text-dim">Key people or systems — and what you call them?</label>
                      <input value={people} onChange={(e) => setPeople(e.target.value)} placeholder="e.g. 'the reconciler' = the nightly job; Ada leads platform" className={field} />
                    </div>
                    <div>
                      <label className="block mb-1.5 text-sm text-dim">Any house rules or gotchas I should always follow?</label>
                      <input value={rules} onChange={(e) => setRules(e.target.value)} placeholder="e.g. Always verify an amount before marking paid" className={field} />
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="flex items-center gap-3 mt-8">
              <button onClick={() => setPhase('sources')} disabled={!goal.trim()}
                className="rounded-[3px] bg-signal text-onsignal px-6 py-3 font-medium disabled:opacity-40 transition-opacity">Next →</button>
              <button onClick={props.onSkip ?? props.onDone} className="text-dim text-sm hover:text-signal transition-colors">Skip for now</button>
            </div>
          </motion.div>
        )}

        {/* ── 2 · SOURCES ──────────────────────────────────────── */}
        {phase === 'sources' && (
          <motion.div key="sources" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.35 }}>
            <h1 className="text-4xl font-semibold tracking-tight leading-[1.05] mb-2">Point me at your material.</h1>
            <p className="text-dim mb-6">Give me a folder of docs, or specific files — Markdown, PDF, Word, CSV, or plain text. I'll read them here on your machine; nothing leaves.</p>

            <div className="flex gap-2">
              <input value={pathInput} onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPath(); } }}
                placeholder="e.g. C:\Users\you\project\docs" className={`${field} flex-1 mono text-[13px]`} />
              <button onClick={addPath} disabled={!pathInput.trim()}
                className="rounded-[3px] border border-line px-4 py-3 text-sm text-dim hover:border-signal whitespace-nowrap disabled:opacity-40 transition-colors">Add</button>
            </div>

            {paths.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {paths.map((p) => (
                  <motion.li key={p} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}
                    className="flex items-center justify-between rounded-[3px] border border-line bg-surface px-3 py-2">
                    <span className="mono text-[12px] truncate">{p}</span>
                    <button onClick={() => setPaths((xs) => xs.filter((x) => x !== p))} className="text-dim hover:text-signal text-sm px-1 transition-colors" aria-label={`Remove ${p}`}>×</button>
                  </motion.li>
                ))}
              </ul>
            )}

            {props.onConnectService && (
              <p className="text-dim text-sm mt-5">
                Prefer email? <button onClick={props.onConnectService} className="text-signal underline underline-offset-2">Connect an inbox</button> and I can learn from it too.
              </p>
            )}

            <div className="flex items-center gap-3 mt-8">
              <button onClick={runScan} disabled={!paths.length}
                className="rounded-[3px] bg-signal text-onsignal px-6 py-3 font-medium disabled:opacity-40 transition-opacity">Read my docs →</button>
              <button onClick={skipToReview} className="text-dim text-sm hover:text-signal transition-colors">Skip — just use my answers</button>
            </div>
          </motion.div>
        )}

        {/* ── 3 · SCANNING ─────────────────────────────────────── */}
        {phase === 'scanning' && (
          <motion.div key="scanning" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="py-16 flex flex-col items-center text-center">
            <div className="relative w-14 h-14 mb-6">
              <motion.div className="absolute inset-0 rounded-full border-2 border-line" />
              <motion.div className="absolute inset-0 rounded-full border-2 border-transparent" style={{ borderTopColor: 'var(--color-signal)' }}
                animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }} />
            </div>
            <div className="mono text-[11px] text-dim uppercase tracking-[0.2em]">reading your material</div>
            <p className="text-dim mt-2">{scanNote || 'One moment…'}</p>
          </motion.div>
        )}

        {/* ── 4 · REVIEW ───────────────────────────────────────── */}
        {phase === 'review' && (
          <motion.div key="review" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.35 }}>
            <h1 className="text-4xl font-semibold tracking-tight leading-[1.05] mb-2">Here's what I'll remember.</h1>
            <p className="text-dim mb-1">Edit anything, drop what's off — I'll only save what you keep. {scanNote && <span className="text-dim">{scanNote}</span>}</p>
            <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-5">{keptCount} to save<span className="text-line"> / </span>{items.length} found</div>

            {error && <p className="mono text-[13px] text-signal mb-4">{error}</p>}

            {items.length === 0 ? (
              <p className="text-dim">Nothing to save yet. Go back and add a goal or point me at some docs.</p>
            ) : (
              <div className="space-y-2.5">
                {items.map((it, i) => (
                  <motion.div key={it.key}
                    initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: Math.min(i * 0.03, 0.4) }}
                    className={`rounded-[4px] border bg-surface transition-colors ${it.keep ? 'border-line' : 'border-line/60 opacity-45'}`}
                    style={it.keep ? { boxShadow: 'inset 3px 0 0 var(--color-signal)' } : undefined}>
                    <div className="flex items-start gap-2 p-3.5">
                      <div className="flex-1 min-w-0">
                        <input value={it.concept}
                          onChange={(e) => setItems((xs) => xs.map((x) => (x.key === it.key ? { ...x, concept: e.target.value } : x)))}
                          className="w-full bg-transparent font-medium text-[15px] outline-none focus:text-signal transition-colors" />
                        <textarea value={it.content} rows={Math.min(4, Math.max(1, Math.ceil(it.content.length / 64)))}
                          onChange={(e) => setItems((xs) => xs.map((x) => (x.key === it.key ? { ...x, content: e.target.value } : x)))}
                          className="w-full mt-1 bg-transparent text-[13px] text-dim leading-relaxed outline-none resize-none focus:text-graphite transition-colors" />
                        {it.source && <div className="mono text-[10px] text-dim mt-1.5 uppercase tracking-[0.15em]">from {it.source}</div>}
                      </div>
                      <button onClick={() => setItems((xs) => xs.map((x) => (x.key === it.key ? { ...x, keep: !x.keep } : x)))}
                        className={`shrink-0 rounded-[3px] border px-2.5 py-1 text-[11px] mono uppercase tracking-[0.1em] transition-colors ${it.keep ? 'border-signal text-signal' : 'border-line text-dim hover:border-signal/60'}`}
                        aria-pressed={it.keep}>{it.keep ? 'keep' : 'skip'}</button>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-3 mt-8">
              <button onClick={save} disabled={keptCount === 0}
                className="rounded-[3px] bg-signal text-onsignal px-6 py-3 font-medium disabled:opacity-40 transition-opacity">
                Save {keptCount} {keptCount === 1 ? 'memory' : 'memories'}
              </button>
              <button onClick={() => setPhase('sources')} className="text-dim text-sm hover:text-signal transition-colors">← Add more material</button>
            </div>
          </motion.div>
        )}

        {/* ── SAVING ───────────────────────────────────────────── */}
        {phase === 'saving' && (
          <motion.div key="saving" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="py-16 flex flex-col items-center text-center">
            <div className="mono text-[11px] text-dim uppercase tracking-[0.2em]">saving to memory…</div>
          </motion.div>
        )}

        {/* ── 5 · DONE ─────────────────────────────────────────── */}
        {phase === 'done' && (
          <motion.div key="done" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="py-8">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.1, type: 'spring', stiffness: 220, damping: 18 }}
              className="w-12 h-12 rounded-full flex items-center justify-center mb-6" style={{ background: 'var(--color-signal)' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            </motion.div>
            <h1 className="text-4xl font-semibold tracking-tight leading-[1.05] mb-2">Your memory is warm.</h1>
            <p className="text-dim mb-8">I saved <span className="text-graphite font-medium">{savedCount}</span> {savedCount === 1 ? 'thing' : 'things'} about your project. Ask me anything — I'll recall what's relevant instead of starting from scratch.</p>
            <button onClick={props.onDone} className="rounded-[3px] bg-signal text-onsignal px-6 py-3 font-medium">Start using MWA →</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
