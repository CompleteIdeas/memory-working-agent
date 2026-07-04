/**
 * Onboarding tools — the "hands" the agent uses to warm-start a cold store from
 * the user's own folders/files. The agent (the brain) refines the candidates,
 * asks follow-ups, and writes the good ones via `remember`. Nothing here writes.
 */
import type { RegisteredTool } from './registry.js';
import { scanSources, INTERVIEW_QUESTIONS } from '../onboard.js';

const onboardScanTool: RegisteredTool = {
  def: {
    name: 'onboard_scan',
    description:
      'Warm-start: scan local folders/files the user points at (docs, PDF, Word, CSV, text) and return CANDIDATE memories to seed a cold store. Deterministic — real file contents, not guesses. Nothing is saved. YOUR job: refine each candidate into an atomic memory, ask the user a follow-up if unsure, then save the good ones with remember. Only reads folders the user has granted access to.',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array', items: { type: 'string' },
          description: 'File or folder paths to learn from (inside a granted folder).',
        },
      },
      required: ['paths'],
    },
  },
  handler: async (args, ctx) => {
    const paths = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : [];
    if (!paths.length) return '(give me at least one file or folder path to learn from)';
    const { candidates, filesScanned, truncated } = await scanSources(ctx.sandboxDir, paths);
    if (!candidates.length) {
      return `Scanned ${filesScanned} file(s) but found nothing readable to learn from. Check the path is inside a folder I can access, or point me at specific docs.`;
    }
    return [
      `Scanned ${filesScanned} file(s) → ${candidates.length} CANDIDATE memories${truncated ? ' (capped)' : ''} (not saved).`,
      'Refine each into an atomic memory, ask the user to confirm anything you inferred, then save the good ones with remember (canonical).',
      '',
      JSON.stringify({ candidates }, null, 2),
    ].join('\n');
  },
};

const onboardQuestionsTool: RegisteredTool = {
  def: {
    name: 'onboard_questions',
    description:
      'Warm-start: return the onboarding interview questions. Ask the user ONE at a time, starting with the goal ("what should I get good at?"), and ask follow-ups for clarity. Turn each answer into a durable memory.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  handler: async () => INTERVIEW_QUESTIONS.map((q: string, i: number) => `${i + 1}. ${q}`).join('\n'),
};

export function onboardTools(): RegisteredTool[] {
  return [onboardScanTool, onboardQuestionsTool];
}
