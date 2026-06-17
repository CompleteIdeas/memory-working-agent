/**
 * buildRegistry — assemble the brain's tool registry from mwa.config.json:
 * built-in tools (by name) + every MCP server's tools (Phase 2). Returns the
 * registry plus a close() to shut down MCP child processes when the run ends.
 */
import { ToolRegistry } from './registry.js';
import { builtinTools } from './builtins.js';
import { approvalTools } from './approval.js';
import { manageTools } from './manage.js';
import { loadMcpServers } from './mcp.js';
import { installerTools } from './installer.js';
import { googleConfigured, googleTools } from '../connectors/google.js';
import { microsoftConfigured, microsoftTools } from '../connectors/microsoft.js';
import type { MwaConfig } from '../config.js';

export async function buildRegistry(config: MwaConfig): Promise<{ registry: ToolRegistry; close: () => Promise<void> }> {
  const registry = new ToolRegistry();
  registry.registerAll(builtinTools(config.tools.builtins ?? []));
  // confirm_action / cancel_action / list_pending — the control tools for any
  // write tool wrapped in requireApproval(). Always available so a previewed
  // write can be confirmed or discarded.
  registry.registerAll(approvalTools());
  // Self-install tools: browse the curated library + enable curated connectors (safe tier),
  // plus propose_connector (reviews external npm packages; install needs human approval).
  registry.registerAll(installerTools(config));
  // Runtime tool management: list_active_tools + uninstall/remove (safe) + add_mcp_server
  // (approval-gated). Makes the tool/MCP set hot-swappable from chat.
  registry.registerAll(manageTools(config));
  // Gmail/Calendar tools (read + draft) appear once Gmail is connected; Outlook tools
  // (search_outlook/read_outlook/draft_outlook) once a Microsoft account is connected.
  // Distinct names → both can be connected at once with no collision.
  if (googleConfigured()) registry.registerAll(googleTools());
  if (microsoftConfigured()) registry.registerAll(microsoftTools());
  const mcp = await loadMcpServers(config.tools.mcpServers ?? {});
  registry.registerAll(mcp.tools);
  return { registry, close: mcp.close };
}
