/**
 * MCP client bridge (Phase 2) — "add tooling" becomes config, not code.
 *
 * For each server in mwa.config.json `tools.mcpServers`, spawn it (stdio), list its
 * tools, and register each as a RegisteredTool whose handler proxies tool calls to
 * the MCP server. The registry is the same one built-ins use, so the brain sees a
 * unified tool list. Tools are namespaced `<server>__<tool>` to avoid collisions
 * (same convention as Claude Code's `mcp__server__tool`).
 *
 * Uses the official @modelcontextprotocol/sdk so transport/handshake/lifecycle are
 * handled cross-platform (the Windows-stdio risk the Decision Process flagged).
 * A server that fails to connect is logged and skipped — never aborts the run.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { RegisteredTool } from './registry.js';

export interface McpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHandle {
  tools: RegisteredTool[];
  close: () => Promise<void>;
}

const CAP = 4000;

export async function loadMcpServers(servers: Record<string, McpServerSpec> = {}): Promise<McpHandle> {
  const clients: Client[] = [];
  const tools: RegisteredTool[] = [];

  for (const [name, spec] of Object.entries(servers)) {
    try {
      const transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args ?? [],
        ...(spec.env ? { env: { ...process.env as Record<string, string>, ...spec.env } } : {}),
      });
      const client = new Client({ name: 'mwa', version: '0.0.1' }, { capabilities: {} });
      await client.connect(transport);
      const listed = await client.listTools();
      for (const t of listed.tools) {
        tools.push({
          def: {
            name: `${name}__${t.name}`,
            description: (t.description ?? `${name} ${t.name}`).slice(0, 400),
            parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
          },
          handler: async (args) => {
            const res = (await client.callTool({ name: t.name, arguments: args })) as {
              content?: Array<{ type?: string; text?: string }>;
              isError?: boolean;
            };
            const text = Array.isArray(res.content)
              ? res.content.map((c) => c.text ?? (c.type ? `[${c.type}]` : '')).join('\n')
              : JSON.stringify(res);
            return (res.isError ? `(mcp error) ${text}` : text).slice(0, CAP);
          },
        });
      }
      clients.push(client);
      console.error(`[mcp] ${name}: connected, ${listed.tools.length} tool(s)`);
    } catch (e) {
      console.error(`[mcp] ${name}: failed — ${(e as Error).message.slice(0, 160)}`);
    }
  }

  return {
    tools,
    close: async () => {
      for (const c of clients) { try { await c.close(); } catch { /* */ } }
    },
  };
}
