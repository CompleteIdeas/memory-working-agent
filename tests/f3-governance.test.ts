import { describe, it, expect } from 'vitest';
import { classifyTool, effectOf, isSensitive, checkTripwires, buildDoneReport, plainVerb } from '../src/tools/governance.js';

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

// Usability review 2026-10-26: the receipt and the offer are in plain words (SR-F13, SR-F19).
describe('plain-language receipts and capability offers', () => {
  it('names actions as a person would', () => {
    expect(plainVerb('write_file')).toBe('saved a file');
    expect(plainVerb('browser_open')).toBe('opened a web page');
    expect(plainVerb('policy_save')).toBe('saved your preference');
    expect(plainVerb('propose_event')).toBe('added a draft calendar event');
    expect(plainVerb('web__open_page')).toBe('web open page'); // an unknown (MCP) tool keeps its name, spaced out
  });
  it('says a repeated action once, with a count', () => {
    const r = buildDoneReport([{ verb: 'opened a web page', effect: 'external' }, { verb: 'opened a web page', effect: 'external' }, { verb: 'saved a file', effect: 'local' }]);
    expect(r).toBe('What I did:\n· Reached outside your machine: opened a web page (2 times)\n· Changed things here: saved a file');
  });
  it('tells the agent to offer a missing connection instead of working around it', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/YET, BUT COULD: [^\n]*do not quietly work around it\. Ask first with ask_user/);
    const { connectTools } = await import('../src/tools/connect.js');
    const desc = connectTools().find((t) => t.def.name === 'connect_account')!.def.description;
    expect(desc).toMatch(/OFFER it first with ask_user/);
    expect(desc).toMatch(/only after they say yes/);
  });
});
