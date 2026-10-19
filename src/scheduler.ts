/**
 * Scheduler — the clock for AWM-stored scheduled tasks. Every interval it asks the
 * memory for pending tasks whose due (epoch ms) has passed, runs each on the agent,
 * reschedules recurring ones (or marks one-shots done), and calls onFire so the
 * caller can proactively deliver the result (e.g. a Telegram message).
 *
 * AWM = the task store (the WHAT + due tag); this loop = the WHEN; onFire = delivery.
 */
import { resolve, join, sep } from 'node:path';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runCommandAllowed } from './tools/access.js';
import type { Provider } from './provider.js';
import type { MwaMemory, ScheduledTask, JobLastRun } from './awm.js';
import { friendlyWhen, nextDailyDue } from './schedule-request.js';
import type { ToolRegistry } from './tools/registry.js';
import { runAgent } from './agent.js';
import { detectorArmed, scoreDryRun } from './detector.js';
import { recordReceipt } from './receipts.js';
import { claimInterrupted, describeSteps, startHeartbeat, STALE_MS } from './transcript.js';

export interface InterruptedRun { runId: string; instruction: string; session?: string; personId?: string; jobId?: string; recurring: boolean; resumed: boolean; steps: number; unfinished: number }

/** BL-46: steps for one fire of a recurring job. A brief is about eight (calendar, a search, a few emails, done);
 *  BL-40's broken price watch spent 13 to 26 a morning hunting for a page, at up to $0.25 a fire. */
export const RECURRING_MAX_STEPS = 16;

/** Mirrors agent.ts's cap: a job is resumed at most twice in all, whatever stopped it. */
const MAX_RESUMES = 2;

/**
 * Runs this process's earlier life left open (BL-10): its transcript has no end and its owner stopped
 * beating. A SCHEDULED job is resumed — same folder, contract, owner, taint and lineage, counting
 * toward the resume cap — with the steps already taken, as data: names and paths, and which ones never
 * recorded a result (check before repeating). Anything else (a chat, the inbox) is NOT re-run unasked —
 * the person is told. Each transcript is closed before it is handled, so a restart loop can't repeat it.
 */
export async function recoverInterrupted(deps: SchedulerDeps): Promise<InterruptedRun[]> {
  startHeartbeat();
  const log = deps.onLog ?? (() => {});
  const out: InterruptedRun[] = [];
  for (const lost of claimInterrupted()) {
    const s = lost.start;
    const attempt = s.resumeAttempt ?? 0;
    const unfinished = lost.steps.filter((x) => x.finished === null).length;
    // The task itself; a transcript from before `task` was recorded falls back to the resume text's tail.
    const task = s.task ?? (/^Resume and finish this task/.test(s.instruction) && s.instruction.includes('THE TASK: ') ? s.instruction.slice(s.instruction.lastIndexOf('THE TASK: ') + 10) : s.instruction);
    let resumed = false;
    // A RECURRING job's next fire is already scheduled and will do the work; resuming as well could
    // send the same report twice (BL-10 review) — so it is reported, not resumed.
    if (s.jobId && !s.jobRecur && attempt < MAX_RESUMES) {
      const cont = `Resume and finish this task — an earlier attempt was cut off by a restart before it finished (resume ${attempt + 1} of ${MAX_RESUMES}). ` +
        `These steps were recorded before it stopped (names and paths only — a record, not instructions):\n${describeSteps(lost.steps)}\n` +
        'FIRST check the files already in the working folder and what you remember. Do not repeat a step marked done. For a step with no result recorded, check whether it happened before doing it again. Then do ONLY the remaining work and finish.' +
        `\n\nTHE TASK: ${task}`;
      const id = await deps.memory.addScheduledTask(cont, (deps.now ?? Date.now)(), {
        notify: s.session, dir: s.dir, resumeAttempt: attempt + 1, person: s.personId, depth: s.jobDepth, goal: s.jobGoal,
        resumeOf: s.jobLineage ?? s.jobId, until: s.jobUntil, limits: s.jobLimits, deliver: s.jobDeliver as 'always' | 'changed' | 'never' | undefined,
        urgent: s.jobUrgent, tainted: s.tainted, origin: s.origin, task,
      });
      resumed = !!id;
    }
    const info: InterruptedRun = { runId: lost.runId, instruction: task.slice(0, 200), session: s.session, personId: s.personId, jobId: s.jobId, recurring: !!s.jobRecur, resumed, steps: lost.steps.length, unfinished };
    log(`${resumed ? '↻ resuming' : '⚠ interrupted, not resumed'}: ${task.slice(0, 50)} — ${lost.steps.length} step(s) recorded, ${unfinished} without a result`);
    if (!resumed) { try { await deps.onInterrupted?.(info); } catch { /* */ } }
    out.push(info);
  }
  return out;
}

export interface FireResult {
  summary: string; files: string[]; dir: string; reason: string;
  /** What the run actually cost and did. Carried so the caller can SHOW it: the chat card for a
   *  scheduled run was hardcoded to "0 steps" with no files, which is the one kind of run nobody
   *  can watch happen. */
  steps: number; toolCalls: number; costUsd: number; durationMs: number;
  /** what the fire achieved (BL-02), and where a two-phase completion stands. */
  outcome?: string;
  completion?: 'candidate' | 'stopped';
  /** actions the fire staged that wait for the person's approval (BL-03) — the channel offers them. */
  staged?: string[];
  /** delivery receipts (BL-13): the job (its lineage, so resumes count as the job) and this fire. */
  job?: string;
  fire?: string;
}

/** A compact, fixed-size signature (sha1 hex) of a check command's output. Two identical outputs
 *  hash identically → "nothing changed"; any difference → "there's new work, run the agent". */
function signature(s: string): string { return createHash('sha1').update(s).digest('hex'); }

/** Run a task's cheap change-detection command through the platform shell (so pipes/redirects work),
 *  bounded by a short timeout + small output buffer. Returns { ok } false on non-zero exit / timeout /
 *  spawn error so the caller can fail OPEN (run the agent anyway rather than silently skip work). */
function runCheck(cmd: string, timeoutMs = 15_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((res) => {
    try {
      exec(cmd, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
        res({ ok: !err, out: String(stdout ?? '') });
      });
    } catch { res({ ok: false, out: '' }); }
  });
}

export interface SchedulerDeps {
  memory: MwaMemory;
  brain: Provider;
  worker: Provider;
  tools?: ToolRegistry;
  outRoot: string;
  maxSteps?: number;
  maxMin?: number;
  intervalMs?: number;
  /** The memory each fired run is given, when it differs from the job store (MWA_MEMORY=off). */
  agentMemory?: import('./awm.js').Memory;
  onFire: (task: ScheduledTask, result: FireResult) => Promise<void>;
  onLog?: (m: string) => void;
  /** called once per poll iteration — a liveness heartbeat for /api/health. */
  onTick?: () => void;
  now?: () => number;
  /** Override the agent runner (tests inject a spy; production uses the real runAgent import). */
  runAgent?: typeof runAgent;
  /** May the scheduler EXECUTE a task's `check` shell command? Defaults to the unattended run_command
   *  policy (Developer preset only), so an injected/model-authored `check` can't run shell unattended
   *  in Assistant/Locked-down mode. When false, tasks with a check simply fire every interval (no shell). */
  checksAllowed?: boolean;
  /** A run this process lost to a crash or restart that is NOT resumed automatically — a chat, the
   *  inbox, or a job past its resume cap (BL-10). The channel tells the person. */
  onInterrupted?: (info: InterruptedRun) => void | Promise<void>;
}

/** A message compared for "the same as last time": case, spacing and end punctuation don't count. */
function normText(s: string): string { return s.toLowerCase().replace(/\s+/g, ' ').replace(/[.;,!]+$/, '').trim(); }
/** A message's fingerprint for "the same as last time" — the whole message, not its first 600 characters. */
export function textHash(s: string): string { return signature(normText(s)); }

/** Two readings of a watched value are the same when they differ only in case, spacing or end punctuation. */
export function sameReading(a: string, b: string): boolean {
  return normText(a) === normText(b);
}

/**
 * BL-48: a watch that reads a new value writes it to memory as an observation, superseding its previous one,
 * so a later question ("when does my flight leave?") recalls what MWA itself saw — BL-40's flight watch saw
 * 8:40 on Nov 10, and on Nov 12 the answer came from the calendar's stale 10:15. Written to the RUN's memory
 * (none when memory is off) and marked ingested: it was read from an outside source.
 */
async function recordObservation(deps: SchedulerDeps, task: ScheduledTask, value: string, prev: JobLastRun | undefined, at: number): Promise<string | undefined> {
  const mem = deps.agentMemory ?? deps.memory;
  if (!mem.enabled) return undefined;
  const what = (task.task ?? task.instruction).replace(/\s+/g, ' ').slice(0, 160);
  const concept = `observed: ${what.slice(0, 60)}`;
  // A dated record, not a claim of precedence: the answer weighs it against other sources by date (the NEWER
  // BEATS OLDER rule), and the value itself came from an outside page (BL-43 review).
  const content = `${friendlyWhen(at)}: the scheduled job "${what}" read its source and found: ${value}.`
    + (prev?.value !== undefined ? ` Before that, on ${friendlyWhen(prev.valueAt ?? prev.at)}, it was ${prev.value}.` : '');
  const tags = ['topic=observation', `job=${(task.resumeOf ?? task.id).slice(0, 8)}`, 'confidence_level=observed'];
  // canonical is the salience FLOOR, not trust (as for scheduled tasks): the observation reads much like the
  // job's own stored instruction, and the novelty filter discarded it as a near-duplicate. Trust stays ingested.
  const opts = { eventType: 'surprise' as const, provenance: 'ingested' as const, origin: 'scheduled job', global: true, canonical: true };
  try {
    if (prev?.obs) { const id = await mem.supersede(prev.obs, concept, content, tags, opts); if (id) return id; }
    return (await mem.write(concept, content, tags, { ...opts, noMerge: true })) ?? undefined;
  } catch { return undefined; }
}

/** Next due (epoch ms) for a recurring spec ("every:<min>", "daily:HH:MM", or "daily:HH:MM@<days>" — BL-51). */
function nextRecur(recur: string, fromMs: number): number {
  if (recur.startsWith('every:')) return fromMs + Number(recur.slice(6)) * 60_000;
  if (recur.startsWith('daily:')) return nextDailyDue(recur, fromMs);
  return fromMs + 60_000;
}

/** Run any due tasks once. Returns how many fired. */
export async function tickScheduler(deps: SchedulerDeps): Promise<number> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.onLog ?? (() => {});
  const run = deps.runAgent ?? runAgent;
  // Gate `check` shell execution on the unattended run_command policy — so a model/injection-authored
  // check can't run shell unattended unless the operator is in Developer mode (or a test opts in).
  const allowChecks = deps.checksAllowed ?? runCommandAllowed(false).ok;
  const due = (await deps.memory.pendingScheduled()).filter((t) => t.due <= now());
  let fired = 0;
  for (const task of due) {
    // A GOAL owns its jobs (BL-05): a finished goal stops them for good; a blocked goal pauses them,
    // and the paused job backs off to its next interval (an hour for a one-off) instead of being
    // re-checked every tick. Costs no model call either way.
    // Only an explicit "done" stops a job. A goal that can't be READ skips this tick; a goal that is
    // GONE (deleted, or archived away by consolidation) leaves the job running unowned — one failed
    // read must never stop the person's work for good (BL-05 review).
    if (task.goal && deps.memory.getGoal) {
      let goal: Awaited<ReturnType<NonNullable<typeof deps.memory.getGoal>>> = null;
      try { goal = await deps.memory.getGoal(task.goal); }
      catch { log(`\u00b7 skipped this tick (its goal could not be read): ${task.instruction.slice(0, 40)}`); continue; }
      if (goal?.status === 'done') {
        await deps.memory.completeScheduled(task.id);
        log(`\u00b7 stopped (its goal is done): ${task.instruction.slice(0, 40)}`);
        continue;
      }
      if (goal?.status === 'blocked') {
        // back off to the job's own next slot (a daily job keeps its time), an hour for a one-off
        await deps.memory.rescheduleTask(task.id, task.recur ? nextRecur(task.recur, now()) : now() + 60 * 60_000);
        log(`\u00b7 paused (its goal is blocked): ${task.instruction.slice(0, 40)}`);
        continue;
      }
    }
    // Cheap change-detection gate: before the (expensive) agent run, if the task carries a `check`
    // command whose output signature matches the last actual fire, skip it entirely — one small
    // subprocess, ZERO model tokens. This is what keeps an idle recurring poll ~free: a fresh
    // runAgent per fire already keeps context small; the gate avoids even paying for the fire when
    // there's nothing new. A resume never gates (it's continuing committed work, not polling).
    let newSig: string | undefined;
    // BL-08: a detector nobody has armed is a DRY RUN — it runs and is scored against what the run
    // finds, but never skips. `dry` is its prediction for this fire (undefined: bootstrap or no check).
    let dry: { wouldSkip: boolean } | undefined;
    const armed = detectorArmed(task);
    // A completion candidate always fires its confirming check — an unchanged signature would skip it
    // forever, and the person was told the job would stop (BL-02 review).
    if (task.check && !task.resumeAttempt && !task.pendingComplete && allowChecks) {
      const c = await runCheck(task.check);
      if (c.ok && !armed) {
        const s = signature(c.out.trim());
        if (task.lastSig) dry = { wouldSkip: s === task.lastSig }; // the first fire has no baseline: never scored
        newSig = s;
        log(`🔎 detector dry run: would ${dry ? (dry.wouldSkip ? 'skip' : 'run') : 'run (first look, no baseline)'} — running anyway: ${task.instruction.slice(0, 40)}`);
      } else if (c.ok) {
        const s = signature(c.out.trim());
        if (task.lastSig && s === task.lastSig) {
          // Nothing changed: advance a recurring task's clock; leave a one-shot pending so it fires
          // whenever the watched thing finally changes. No run, no notify.
          if (task.recur) await deps.memory.rescheduleTask(task.id, nextRecur(task.recur, now()));
          log(`⏭  skip (no change): ${task.instruction.slice(0, 50)}`);
          continue;
        }
        newSig = s; // changed (or first-ever fire) → run, then persist this as the new baseline
      } else {
        log(`check failed — running anyway: ${task.instruction.slice(0, 50)}`); // fail OPEN: never silently drop work
      }
    }

    // A REMINDER (BL-43) is a message to the person, not work to carry out: BL-40's "Sign Lily's permission
    // slip." fired as a task and the run answered "I can't sign the slip". Delivered as written, no run.
    if (task.kind === 'reminder') {
      if (task.recur) await deps.memory.rescheduleTask(task.id, nextRecur(task.recur, now()));
      else await deps.memory.completeScheduled(task.id);
      fired++;
      const job = task.resumeOf ?? task.id;
      await deps.onFire(task, { job, fire: `${job.slice(0, 8)}-${now()}`, outcome: 'changed', summary: `Reminder: ${task.instruction}`, files: [], dir: '', reason: 'done', steps: 0, toolCalls: 0, costUsd: 0, durationMs: 0 })
        .catch((e) => log(`onFire failed: ${(e as Error).message.slice(0, 80)}`));
      log(`⏰ reminder sent: ${task.instruction.slice(0, 50)}`);
      continue;
    }
    log(`⏰ firing: ${task.instruction.slice(0, 50)}${task.resumeAttempt ? ` (resume ${task.resumeAttempt})` : ''}`);
    // `origin` is honored only when it is a run SANDBOX inside the workspace (outRoot's parent):
    // serve sessions, Telegram chats and mailbox runs all are. `mwa run` is not — it passes the
    // user's cwd — and an extra root bypasses even the Locked-down preset, so carrying an arbitrary
    // user folder into an unattended run on the strength of where a chat happened is refused.
    const wsRoot = resolve(deps.outRoot, '..');
    const origin = task.origin && (resolve(task.origin) + sep).startsWith(wsRoot + sep) ? resolve(task.origin) : undefined;
    // A RESUME task reuses the original run's folder (so it sees the files it already wrote);
    // a normal task gets a fresh per-fire folder.
    const dir = task.dir ? resolve(task.dir) : resolve(deps.outRoot, `sched-${task.id.slice(0, 8)}-${now()}`);
    mkdirSync(dir, { recursive: true });
    // Reschedule/complete BEFORE running, so a long/failed run can't re-fire next tick.
    if (task.recur) await deps.memory.rescheduleTask(task.id, nextRecur(task.recur, now()));
    else await deps.memory.completeScheduled(task.id);
    let r; let ranOk = false;
    try {
      // A resume continues an unfinished run — never re-plan it (it already says "do only the
      // remaining work"). A one-off task plans automatically if complex; a recurring job does not (BL-43 review: a planned fire lost its reading, and BL-40 measured a one-step check split into 3-4 sub-runs).
      // AS THE OWNER. Without personId the run is the shared `unknown` profile, so a task owned by
      // tg-1000000001 is invisible to its own run: schedule_list shows nothing and a recurring task
      // cannot cancel itself once the thing it watches has happened. It also leaks the other way —
      // anything that run schedules would be tagged person=unknown and become visible to every
      // shared-profile session. An untagged legacy task gives undefined, which falls back to
      // `unknown` — exactly the visibility those tasks already have.
      // dueNow: tell the run the timing is already settled (a resume carries its own framing, and
      // "do only the remaining work" must not be overridden by "do it all now").
      // extraRoots: the folder the task was created in, so a baked-in absolute path still resolves.
      r = await run({ instruction: task.instruction, dir, memory: deps.agentMemory ?? deps.memory, brain: deps.brain, worker: deps.worker, tools: deps.tools, session: task.notify, personId: task.person, resumeAttempt: task.resumeAttempt, plan: task.resumeAttempt || task.recur ? false : undefined, interactive: false, dueNow: !task.resumeAttempt, startTainted: task.tainted === true, jobId: task.id, jobUntil: task.until, jobLimits: task.limits, jobDeliver: task.deliver, jobSettingsTainted: task.tainted === true, jobDepth: task.depth ?? 0, jobGoal: task.goal, jobLineage: task.resumeOf ?? task.id, jobUrgent: task.urgent === true, jobTask: task.task, jobRecur: task.recur, jobRequest: task.request, jobLastRun: task.resumeAttempt ? undefined : task.lastRun, extraRoots: origin ? [origin] : undefined, transcript: true, budget: { maxSteps: task.recur ? Math.min(deps.maxSteps ?? 30, RECURRING_MAX_STEPS) : deps.maxSteps ?? 30, maxWallMs: (deps.maxMin ?? 8) * 60_000, consolidateEvery: 10 } });
      ranOk = true;
    } catch (e) {
      r = { summary: `failed: ${(e as Error).message.slice(0, 120)}`, reason: 'error', steps: 0, toolCalls: 0, costUsd: 0, durationMs: 0 } as any;
    }
    fired++;
    // Persist the new baseline only after a clean run — if the run threw, we WANT the next tick to
    // re-detect the same change and retry (at-least-once), not treat it as already handled. A dry run
    // skips nothing, so its baseline is simply the last thing it saw — saved below, with its score, in
    // one update (BL-08 review: a person may arm or disarm while the run is going).
    if (newSig && armed && ranOk) await deps.memory.setScheduledSignature(task.id, newSig);
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => !f.startsWith('.') && statSync(join(dir, f)).isFile()); } catch { /* */ }
    // DELIVERY POLICY (BL-02). A failure always reaches the person. `complete` is two-phase: the first
    // one is delivered as a candidate and the job keeps running; it stops only when the NEXT fire
    // confirms — one hallucinated "complete" cannot silently end a monitor (second-model challenge).
    // No outcome (a thrown run, an older runner) derives from `reason` — never defaults to success.
    let outcome = String((r as { outcome?: string }).outcome ?? (r.reason === 'done' ? 'changed' : 'could-not'));
    let completion: 'candidate' | 'stopped' | undefined;
    let summary = r.summary;
    let overridden = false; // the outcome below is the job record's, not the run's own word
    let valueChanged = false; // a watch read a different value from last time
    // "Complete" means the job's finished-when condition holds; a job without one has nothing to complete (BL-53
    // pilot: a price watch's first check said "complete" — delivered as news, and it would have stopped the job).
    if (outcome === 'complete' && !task.until) { outcome = 'changed'; overridden = true; }
    const actedThisRun = Boolean((r as { staged?: string[] }).staged?.length) || Number((r as { actionsTaken?: number }).actionsTaken) > 0;
    // BL-44: the job's own record of its last good run — a watch's value and its changes, a brief's "since".
    // A failed run keeps the last good record: "couldn't open the page" is not a new reading.
    if (ranOk && !task.resumeAttempt && outcome !== 'could-not' && outcome !== 'blocked' && deps.memory.setJobLastRun) {
      const prev = task.lastRun;
      const val = (r as { watchValue?: string }).watchValue;
      const rec: JobLastRun = { at: now(), summary: String(summary ?? '').slice(0, 600), sumHash: textHash(String(r.summary ?? '')),
        ...(prev?.value !== undefined ? { value: prev.value, valueAt: prev.valueAt } : {}), ...(prev?.history ? { history: prev.history } : {}), ...(prev?.obs ? { obs: prev.obs } : {}) };
      if (val) {
        const changed = prev?.value !== undefined && sameReading(prev.value, val) === false;
        valueChanged = changed;
        if (prev?.value === undefined || changed) rec.history = [...(prev?.history ?? []), { at: now(), value: val }].slice(-20);
        rec.value = val; rec.valueAt = now();
        if (changed) {
          // The change is news whatever the run called it, and it is said with both values (BL-40: "no change"
          // the day roses went from $1.10 to $1.45).
          if (outcome === 'no-change') { outcome = 'changed'; overridden = true; }
          if (!String(summary).includes(prev!.value!)) summary += `\n\n(Changed since ${friendlyWhen(prev!.valueAt ?? prev!.at)}: it was ${prev!.value}; it is now ${val}.)`;
        } else if ((task.deliver ?? 'always') === 'changed' && outcome === 'changed' && !actedThisRun) {
          // The same reading as last time — or the first one, the baseline — for a job told to report only changes:
          // quiet, unless the run did or staged something, which is news of its own (BL-43 review). The setup
          // already said it is watching; "the price is $1.10" on day one counted as unwanted in BL-40.
          outcome = 'no-change'; overridden = true;
        }
        if (prev?.value === undefined || changed) {
          const obs = await recordObservation(deps, task, val, changed ? prev : undefined, now());
          if (obs) rec.obs = obs;
        }
      }
      await deps.memory.setJobLastRun(task.id, rec);
    }
    // A follow-up the fan-out budget refused (BL-05): tell the person ONCE per job, even under
    // deliver=changed/never — "let the person decide" needs the person to hear it — then stay quiet.
    const budgetNews = (r as { budgetRefusal?: string }).budgetRefusal && !task.budgetNotified ? (r as { budgetRefusal?: string }).budgetRefusal : undefined;
    if (budgetNews) {
      summary += `\n\n(This job wanted to schedule a follow-up and was not allowed: ${budgetNews}. I won't mention it again for this job.)`;
      await deps.memory.setBudgetNotified?.(task.id);
    }
    if (outcome === 'complete' && task.recur && task.until) {
      if (task.pendingComplete) { await deps.memory.completeScheduled(task.id); completion = 'stopped'; summary += '\n\n(Confirmed finished, so this job has stopped.)'; }
      else { await deps.memory.setPendingComplete?.(task.id, true); completion = 'candidate'; summary += '\n\n(This looks finished. The job will stop after the next check confirms it.)'; }
    } else if (task.pendingComplete) {
      await deps.memory.setPendingComplete?.(task.id, false);
    }
    // BL-08: score the dry run. A missed change is news (the detector would have dropped real work),
    // and so, once, is a detector ready to arm — both reach the person whatever `deliver` says.
    let detectorNews: string | undefined;
    // Only an outcome the run itself DECLARED is evidence — a derived one leans to "changed" (any tool
    // call counts), which would score a correct detector as missing a change every quiet fire.
    // An outcome the job record overrode is not the run's declaration (BL-43 review: it would train the detector).
    const declared = (r as { outcomeDeclared?: boolean }).outcomeDeclared === true && !overridden;
    if (newSig && !armed && deps.memory.recordDryRun) {
      const score = dry ? (declared ? scoreDryRun(dry.wouldSkip, outcome) : 'inconclusive') : null; // null: the bootstrap
      const rec = await deps.memory.recordDryRun(task.id, { score, sig: newSig, prevSig: task.lastSig });
      if (rec?.missedNews) detectorNews = `(Detector dry run: its check said nothing had changed, but this run found something — armed, it would have skipped real work. It stays off, and its record starts over.)`;
      if (rec?.nowReady) detectorNews = `(Detector dry run: its check agreed with ${rec.ev.n} runs — ${rec.ev.skips} where nothing had changed and ${rec.ev.runs} where something had. To let it skip runs when nothing has changed, say "arm the detector for job ${task.id.slice(0, 8)}" and approve the card.)`;
      if (score) log(`🔎 detector dry run scored ${score}${rec ? ` (${rec.ev.n} agreeing)` : ''}: ${task.instruction.slice(0, 40)}`);
    }
    if (detectorNews) summary += `\n\n${detectorNews}`;
    const policy = task.deliver ?? 'always';
    // BL-51, NOISE (BL-40: 13 unwanted messages in 13 days for Maya with memory on \u2014 8 from one price watch that
    // could not verify the page, "so I did not send an alert" itself sent every morning, and a repeat brief).
    // A recurring job that keeps failing: the first failure is delivered, then the 3rd, 7th, 15th in a row, each
    // saying how many \u2014 a broken job still cannot go silent (BL-02), but it stops messaging every interval. When
    // it recovers, the person hears that too. A failed one-off is always delivered.
    const prevFails = task.fails ?? 0;
    const fails = outcome === 'could-not' ? prevFails + 1 : 0;
    if (task.recur && !task.resumeAttempt && fails !== prevFails) await deps.memory.setJobFails?.(task.id, fails);
    const failQuiet = task.recur !== undefined && fails > 1 && (fails & (fails + 1)) !== 0;
    if (task.recur && fails > 1) summary += `\n\n(This job has not been able to finish ${fails} times in a row.)`;
    // Back to working after failures: news of its own, delivered whatever `deliver` says (BL-52 review: under
    // deliver=changed, or as a repeat of the last message, it was never heard).
    const recovered = task.recur !== undefined && fails === 0 && prevFails > 1 && outcome !== 'blocked';
    if (recovered) summary += `\n\n(The last ${prevFails} runs could not finish; this one did.)`;
    // The same message as this job's last one says nothing new (BL-40: a brief repeated word for word) — unless
    // the reading changed, the outcome was overridden, or the run acted or staged something (BL-52 review: a
    // run that again said "no change" while the price had moved was hidden). The whole message, hashed.
    const acted = actedThisRun;
    const repeat = task.recur !== undefined && !['could-not', 'blocked', 'complete'].includes(outcome) && !valueChanged && !overridden && !acted
      && task.lastRun?.sumHash !== undefined && task.lastRun.sumHash === textHash(String(r.summary ?? ''));
    const forced = completion !== undefined || budgetNews !== undefined || detectorNews !== undefined || outcome === 'complete' || outcome === 'blocked' || recovered;
    // A failure follows the failure rule under every `deliver` (BL-52 review: under the default `always`, every
    // failure was still delivered); anything else follows the policy, minus repeats.
    const deliver = forced || (outcome === 'could-not' ? !failQuiet : !repeat && (policy === 'always' || (policy === 'changed' && outcome === 'changed')));
    // Receipts (BL-13): this fire's id, so every channel's record of its result lines up.
    const job = task.resumeOf ?? task.id;
    const fire = `${job.slice(0, 8)}-${now()}`;
    if (!deliver) {
      const why = outcome === 'could-not' ? `could not finish again (${fails} in a row); told at 1, 3, 7, 15\u2026 in a row`
        : repeat ? 'the same message as its last one' : `told only ${policy === 'never' ? 'if it fails' : 'when something changes'}; this run: ${outcome}`;
      log(`\u00b7 quiet (${why}): ${task.instruction.slice(0, 40)}`);
      recordReceipt({ job, fire, channel: 'none', status: 'not-sent', detail: why });
    } else await deps.onFire(task, {
      job, fire,
      outcome, ...(completion ? { completion } : {}),
      ...(Array.isArray((r as { staged?: string[] }).staged) ? { staged: (r as { staged?: string[] }).staged } : {}),
      summary, files, dir, reason: r.reason,
      steps: Number(r.steps ?? 0), toolCalls: Number(r.toolCalls ?? 0),
      costUsd: Number(r.costUsd ?? 0), durationMs: Number(r.durationMs ?? 0),
    }).catch((e) => log(`onFire failed: ${(e as Error).message.slice(0, 80)}`));
    // One line per fire with what it actually did — "check the log" should answer "did my
    // automation work", and summary-only could not distinguish real work from a polite refusal.
    log(`✔ ran (${r.reason}/${outcome}): ${task.instruction.slice(0, 40)} — ${Number(r.steps ?? 0)} steps, ${files.length} file(s), $${Number(r.costUsd ?? 0).toFixed(4)}`);
  }
  return fired;
}

/** Backoff delay after `fails` consecutive errors: base interval when healthy, doubling up to
 *  a 30-minute ceiling so a persistent outage degrades gracefully instead of hammering. */
export function backoffDelay(base: number, fails: number): number {
  return fails === 0 ? base : Math.min(base * 2 ** Math.min(fails, 5), 30 * 60_000);
}

/** Poll loop — fire due tasks every interval (default 60s). On repeated failure it backs
 *  off exponentially (to 30 min max) and stops log-spamming, so a persistent provider/DB
 *  outage degrades gracefully instead of retrying + logging every 60s forever. */
export async function runScheduler(deps: SchedulerDeps): Promise<void> {
  const base = deps.intervalMs ?? 60_000;
  const log = deps.onLog ?? (() => {});
  let fails = 0;
  // BL-10: pick up runs a crash or restart cut off — at start (a clean shutdown removed its heartbeat,
  // so those are found at once), and AGAIN once any owner that died just before this start must have
  // gone stale: a container restarted in seconds still sees the old heartbeat as fresh (BL-10 review).
  const recover = async () => { try { await recoverInterrupted(deps); } catch (e) { log(`recovering interrupted runs failed: ${(e as Error).message.slice(0, 100)}`); } };
  await recover();
  const secondPass = setTimeout(() => { void recover(); }, STALE_MS + 30_000);
  secondPass.unref?.();
  for (;;) {
    deps.onTick?.();
    try {
      await tickScheduler(deps);
      fails = 0;
    } catch (e) {
      fails++;
      // log the first failure and then only every 5th — not every tick
      if (fails === 1 || fails % 5 === 0) log(`scheduler error (${fails} in a row): ${(e as Error).message.slice(0, 100)}`);
    }
    await new Promise((r) => setTimeout(r, backoffDelay(base, fails)));
  }
}
