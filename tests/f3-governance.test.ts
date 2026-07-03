import { describe, it, expect } from 'vitest';
import { classifyTool, effectOf, isSensitive, checkTripwires, buildDoneReport } from '../src/tools/governance.js';

describe('F3 governance: classification', () => {
  it('classifies real tools by reach', () => {
    expect(classifyTool('read_file')).toBe('read');
    expect(classifyTool('write_file')).toBe('write-local');
    expect(classifyTool('run_command')).toBe('execute');
    expect(classifyTool('draft_email')).toBe('external');
    expect(classifyTool('http_request')).toBe('external');
    expect(classifyTool('schedule')).toBe('schedule');
  });
  it('unknown tools are treated as external + sensitive (fail-cautious)', () => {
    expect(classifyTool('some_new_self_installed_tool')).toBe('external');
    expect(isSensitive('some_new_self_installed_tool')).toBe(true);
  });
  it('effectOf collapses to read/local/external for the action log', () => {
    expect(effectOf('web_search')).toBe('read');
    expect(effectOf('write_file')).toBe('local');
    expect(effectOf('draft_email')).toBe('external');
  });
  it('reads/control are not sensitive; world-changing ones are', () => {
    expect(isSensitive('read_file')).toBe(false);
    expect(isSensitive('done')).toBe(false);
    expect(isSensitive('write_file')).toBe(true);
    expect(isSensitive('draft_email')).toBe(true);
  });
});

describe('F3 governance: tripwires (watch the trajectory)', () => {
  it('does not trip under the limits', () => {
    expect(checkTripwires([{ tool: 'draft_email' }, { tool: 'write_file' }]).tripped).toBe(false);
  });
  it('trips when too many external actions accumulate', () => {
    const r = checkTripwires(Array.from({ length: 4 }, () => ({ tool: 'draft_email' })));
    expect(r.tripped).toBe(true);
    expect(r.reason).toMatch(/outside your machine/);
  });
  it('trips on too many local changes', () => {
    expect(checkTripwires(Array.from({ length: 13 }, () => ({ tool: 'write_file' }))).tripped).toBe(true);
  });
  it('honors custom limits', () => {
    expect(checkTripwires([{ tool: 'draft_email' }], { maxExternal: 0 }).tripped).toBe(true);
  });
});

describe('F3 governance: done report (Explain)', () => {
  it('groups actions by reach in plain language; ignores reads', () => {
    const report = buildDoneReport([
      { verb: 'drafted reply to Jane', effect: 'external' },
      { verb: 'saved notes.md', effect: 'local' },
      { verb: 'read inbox', effect: 'read' },
    ]);
    expect(report).toContain('Reached outside your machine: drafted reply to Jane');
    expect(report).toContain('Changed things here: saved notes.md');
    expect(report).not.toContain('read inbox');
  });
  it('empty when nothing side-effecting happened', () => {
    expect(buildDoneReport([])).toBe('');
    expect(buildDoneReport([{ tool: 'read_file' }])).toBe('');
  });
});
