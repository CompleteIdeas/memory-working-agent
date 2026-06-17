import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manageTools } from '../../src/tools/manage.js';
import { approvalTools } from '../../src/tools/approval.js';
import { listMcpServers } from '../../src/connectors/registry.js';
import type { ToolContext } from '../../src/tools/registry.js';

const ctx: ToolContext = { sandboxDir: '.', interactive: true };
const cfg = {
  models: { fetch: 'azure:m', reason: 'azure:m' },
  awm: {},
  workspace: '.',
  tools: { builtins: ['read_file', 'run_command'] },
  escalation: { maxFetchFailures: 2 },
} as any;

let dir: string;
function tool(name: string) {
  const all = [...manageTools(cfg), ...approvalTools()];
  const t = all.find((x) => x.def.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}
function idFrom(msg: string): string {
  const m = msg.match(/confirmation_id:\s*(\S+)/);
  if (!m) throw new Error(`no confirmation_id in: ${msg}`);
  return m[1];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mwa-manage-'));
  process.env.MWA_CONFIG_PATH = join(dir, 'mwa.config.json');
});
afterEach(() => {
  delete process.env.MWA_CONFIG_PATH;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

describe('runtime tool management', () => {
  it('list_active_tools shows built-ins and (initially) no MCP servers', async () => {
    const out = await tool('list_active_tools').handler({}, ctx);
    expect(out).toContain('read_file');
    expect(out).toContain('MCP servers (0)');
  });

  it('add_mcp_server requires approval (does NOT wire until confirmed), then confirm wires it', async () => {
    const add = tool('add_mcp_server');
    const preview = await add.handler({ name: 'foo', command: 'node', args: ['foo.js'] }, ctx);
    expect(preview).toContain('[APPROVAL REQUIRED]');
    expect(preview).toContain('node foo.js');
    expect(Object.keys(listMcpServers())).not.toContain('foo'); // not wired yet

    const confirmed = await tool('confirm_action').handler({ confirmation_id: idFrom(preview) }, ctx);
    expect(confirmed).toContain('[CONFIRMED add_mcp_server]');
    expect(Object.keys(listMcpServers())).toContain('foo'); // now wired
    expect(listMcpServers().foo.command).toBe('node');
  });

  it('remove_mcp_server removes a wired server', async () => {
    const add = tool('add_mcp_server');
    const preview = await add.handler({ name: 'bar', command: 'npx', args: ['-y', 'x'] }, ctx);
    await tool('confirm_action').handler({ confirmation_id: idFrom(preview) }, ctx);
    expect(Object.keys(listMcpServers())).toContain('bar');

    const r = await tool('remove_mcp_server').handler({ name: 'bar' }, ctx);
    expect(r).toMatch(/Removed MCP server "bar"/);
    expect(Object.keys(listMcpServers())).not.toContain('bar');
  });

  it('remove_mcp_server on an unknown name is a no-op message', async () => {
    const r = await tool('remove_mcp_server').handler({ name: 'nope' }, ctx);
    expect(r).toMatch(/No MCP server named "nope"/);
  });

  it('uninstall_connector disables an enabled curated connector', async () => {
    // enable a curated connector by wiring it under its id, then uninstall it
    const add = tool('add_mcp_server');
    const preview = await add.handler({ name: 'search', command: 'node', args: ['mcp-servers/search.mjs'] }, ctx);
    await tool('confirm_action').handler({ confirmation_id: idFrom(preview) }, ctx);
    expect(Object.keys(listMcpServers())).toContain('search');

    const r = await tool('uninstall_connector').handler({ id: 'search' }, ctx);
    expect(r).toMatch(/Removed/);
    expect(Object.keys(listMcpServers())).not.toContain('search');
  });
});
