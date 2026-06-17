/**
 * Tool management — let the agent (and the user, via chat) see what tooling is wired
 * and add/remove it at runtime. Modular by design: tools/MCP servers are config, so
 * enabling/removing is a config edit that the registry picks up on the next message.
 *
 * Safety model (matches the connector install policy):
 *   - curated connectors  → install_connector (installer.ts), vetted, one call.
 *   - remove anything     → uninstall_connector / remove_mcp_server, no approval (reducing
 *                           capability is always safe).
 *   - add an ARBITRARY MCP server (raw command) → add_mcp_server, wrapped in the two-step
 *                           approval gate: it previews the exact command and only writes it
 *                           to config after confirm_action (chat) OR the Connections UI
 *                           (both paths). Running a third-party server executes code locally.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { RegisteredTool } from './registry.js';
import { requireApproval } from './approval.js';
import {
  listConnectors, enabledConnectorIds, disableConnector, getConnector,
  listMcpServers, removeMcpServer, addMcpServer,
} from '../connectors/registry.js';
import type { MwaConfig } from '../config.js';

function auditManage(event: string, data: Record<string, unknown>): void {
  try {
    const p = process.env.MWA_INSTALL_LOG ?? resolve('./data/installs.jsonl');
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify({ ts: Date.now(), event, ...data }) + '\n');
  } catch { /* best-effort */ }
}

export function manageTools(cfg: MwaConfig): RegisteredTool[] {
  const listActiveTool: RegisteredTool = {
    def: {
      name: 'list_active_tools',
      description: 'Show everything currently wired: built-in tools, connected MCP servers, and enabled connectors — so you can see what to add or remove. Read-only.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    handler: async () => {
      const builtins = cfg.tools.builtins ?? [];
      const servers = listMcpServers();
      const enabledIds = new Set(enabledConnectorIds());
      const connectorRows = listConnectors()
        .filter((c) => enabledIds.has(c.id))
        .map((c) => `  • ${c.name} (id="${c.id}") — ${c.access}`);
      const serverRows = Object.entries(servers).map(([name, spec]) => {
        const known = getConnector(name);
        const cmd = `${spec.command} ${(spec.args ?? []).join(' ')}`.slice(0, 90);
        return `  • ${name}${known ? ' (curated)' : ' (custom)'} — ${cmd}`;
      });
      return [
        `Built-in tools (${builtins.length}): ${builtins.join(', ') || '(none)'}`,
        `MCP servers (${Object.keys(servers).length}):`,
        ...(serverRows.length ? serverRows : ['  (none connected)']),
        `Enabled connectors:`,
        ...(connectorRows.length ? connectorRows : ['  (none)']),
        ``,
        `To add: install_connector (curated) or add_mcp_server (custom, needs approval). To remove: uninstall_connector / remove_mcp_server.`,
      ].join('\n');
    },
  };

  const uninstallConnectorTool: RegisteredTool = {
    def: {
      name: 'uninstall_connector',
      description: 'Turn OFF / remove a connector by its id (from list_active_tools). Reducing capability is always safe — no approval needed. Effective on the next message.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    handler: async (args) => {
      const id = String(args.id ?? '').trim();
      if (!id) return 'Which connector? Give its id (see list_active_tools).';
      if (!new Set(enabledConnectorIds()).has(id)) return `"${id}" isn't currently enabled.`;
      disableConnector(id);
      auditManage('uninstall_connector', { id });
      const known = getConnector(id);
      return `Removed ${known?.name ?? id} — its tools are gone from your next message.`;
    },
  };

  const removeMcpServerTool: RegisteredTool = {
    def: {
      name: 'remove_mcp_server',
      description: 'Remove an MCP server by its config name (from list_active_tools) — works for both curated and custom servers. Safe (reduces capability). Effective on the next message.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    handler: async (args) => {
      const name = String(args.name ?? '').trim();
      if (!name) return 'Which server? Give its name (see list_active_tools).';
      const ok = removeMcpServer(name);
      if (!ok) return `No MCP server named "${name}" is wired.`;
      auditManage('remove_mcp_server', { name });
      return `Removed MCP server "${name}" — its tools are gone from your next message.`;
    },
  };

  // Adding an arbitrary MCP server runs third-party code locally → gated behind the two-step
  // approval. The execute (after confirm) persists it to config; available next message.
  const addMcpServerTool: RegisteredTool = requireApproval(
    {
      def: {
        name: 'add_mcp_server',
        description: 'Add a CUSTOM MCP server by raw command (e.g. command="npx", args=["-y","some-mcp-server"]). For npm packages, prefer propose_connector (it runs a security review). This runs third-party code locally, so it requires explicit approval before it is wired.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'a short name for this server (config key)' },
            command: { type: 'string', description: 'the executable, e.g. node / npx' },
            args: { type: 'array', items: { type: 'string' }, description: 'command arguments' },
          },
          required: ['name', 'command'],
        },
      },
      handler: async (args) => {
        const name = String(args.name ?? '').trim().replace(/[^a-z0-9_-]/gi, '-').slice(0, 40);
        const command = String(args.command ?? '').trim();
        const cmdArgs = Array.isArray(args.args) ? (args.args as unknown[]).map(String) : [];
        if (!name || !command) return '(need a name and a command)';
        addMcpServer(name, { command, args: cmdArgs });
        auditManage('add_mcp_server', { name, command, args: cmdArgs });
        return `Added MCP server "${name}" (${command} ${cmdArgs.join(' ')}). Its tools are available on your next message.`;
      },
    },
    {
      preview: (a) => {
        const name = String(a.name ?? '');
        const command = String(a.command ?? '');
        const cmdArgs = Array.isArray(a.args) ? (a.args as unknown[]).map(String) : [];
        return `Wire a NEW MCP server "${name}" that will run on every message:\n    ${command} ${cmdArgs.join(' ')}\nThis executes third-party code locally. Approve only if you trust it.`;
      },
    },
  );

  return [listActiveTool, uninstallConnectorTool, removeMcpServerTool, addMcpServerTool];
}
