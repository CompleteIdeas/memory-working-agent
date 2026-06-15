/**
 * buildRegistry — assemble the brain's tool registry from mwa.config.json:
 * built-in tools (by name) + every MCP server's tools (Phase 2). Returns the
 * registry plus a close() to shut down MCP child processes when the run ends.
 */
import { ToolRegistry } from './registry.js';
import { builtinTools } from './builtins.js';
import { loadMcpServers } from './mcp.js';
import { googleConfigured, googleTools } from '../connectors/google.js';
import { microsoftConfigured, microsoftTools } from '../connectors/microsoft.js';
import type { MwaConfig } from '../config.js';

export async function buildRegistry(config: MwaConfig): Promise<{ registry: ToolRegistry; close: () => Promise<void> }> {
  const registry = new ToolRegistry();
  registry.registerAll(builtinTools(config.tools.builtins ?? []));
  // Gmail/Calendar tools (read + draft) appear once Gmail is connected; Outlook tools
  // (search_outlook/read_outlook/draft_outlook) once a Microsoft account is connected.
  // Distinct names → both can be connected at once with no collision.
  if (googleConfigured()) registry.registerAll(googleTools());
  if (microsoftConfigured()) registry.registerAll(microsoftTools());
  const mcp = await loadMcpServers(config.tools.mcpServers ?? {});
  registry.registerAll(mcp.tools);
  return { registry, close: mcp.close };
}
