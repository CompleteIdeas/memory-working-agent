/**
 * buildRegistry — assemble the brain's tool registry from mwa.config.json:
 * built-in tools (by name) + every MCP server's tools (Phase 2). Returns the
 * registry plus a close() to shut down MCP child processes when the run ends.
 */
import { ToolRegistry } from './registry.js';
import { builtinTools } from './builtins.js';
import { loadMcpServers } from './mcp.js';
import { googleConfigured, googleTools } from '../connectors/google.js';
import type { MwaConfig } from '../config.js';

export async function buildRegistry(config: MwaConfig): Promise<{ registry: ToolRegistry; close: () => Promise<void> }> {
  const registry = new ToolRegistry();
  registry.registerAll(builtinTools(config.tools.builtins ?? []));
  // Gmail/Calendar tools (read + draft) appear once `mwa connect gmail` has run.
  if (googleConfigured()) registry.registerAll(googleTools());
  const mcp = await loadMcpServers(config.tools.mcpServers ?? {});
  registry.registerAll(mcp.tools);
  return { registry, close: mcp.close };
}
