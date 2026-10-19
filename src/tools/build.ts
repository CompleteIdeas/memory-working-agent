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
import { onboardTools } from './onboard.js';
import { memoryTools } from './memory.js';
import { MEMORY_OFF, KNOWLEDGE_TOOLS } from '../memory-off.js';
import { workTools } from './work.js';
import { knowledgeTools } from './knowledge.js';
import { checkTools } from './checks.js';
import { googleConfigured, googleTools } from '../connectors/google.js';
import { gmailImapConfigured, gmailImapTools } from '../connectors/gmail-imap.js';
import { microsoftConfigured, microsoftTools } from '../connectors/microsoft.js';
import { imageGenConfigured, imageGenTools } from '../connectors/imagegen.js';
import type { MwaConfig } from '../config.js';

export async function buildRegistry(
  config: MwaConfig,
  /** The run's memory, when there is one. Optional so every existing caller keeps working;
   *  without it the memory tools are simply absent rather than present-and-broken. */
  memory?: import('../awm.js').MwaMemory | null,
): Promise<{ registry: ToolRegistry; close: () => Promise<void> }> {
  const registry = new ToolRegistry();
  registry.registerAll(builtinTools(config.tools.builtins ?? []));
  // cancel_action / list_pending — the model can decline or look at a staged write, never approve
  // it: a person does, in the app or with the Telegram button (BL-03).
  registry.registerAll(approvalTools());
  // Warm-start tools: scan the user's folders/files into candidate memories +
  // the onboarding interview. The agent refines + verifies before writing.
  registry.registerAll(onboardTools());
  // Self-install tools: browse the curated library + enable curated connectors (safe tier),
  // plus propose_connector (reviews external npm packages; install needs human approval).
  registry.registerAll(installerTools(config));
  // Runtime tool management: list_active_tools + uninstall/remove (safe) + add_mcp_server
  // (approval-gated). Makes the tool/MCP set hot-swappable from chat.
  registry.registerAll(manageTools(config));
  // Memory tools — the agent's reach into the memory it already has: the person it is
  // talking to, the shape of its own store, and recall feedback. MwaMemory implemented
  // these long before anything could call them; see src/tools/memory.ts for why that
  // mattered more than it sounds.
  // MWA_MEMORY=off (src/memory-off.ts): the tools that read or write what memory knows are not offered.
  const known = (ts: ReturnType<typeof memoryTools>) => (MEMORY_OFF ? ts.filter((t) => !KNOWLEDGE_TOOLS.has(t.def.name)) : ts);
  registry.registerAll(known(memoryTools(memory)));
  // Work tools — the agent's own scheduled automations, standing preferences and saved procedures.
  // Same gap as the memory tools one layer out: it could CREATE a recurring task but never see or
  // stop one. See src/tools/work.ts for why the policy writers are the gated ones.
  registry.registerAll(known(workTools(memory)));
  // Knowledge store (opt-in via MWA_KNOWLEDGE_DIR). These were written and exported and
  // then never registered, so `knowledge_write`/`knowledge_list` existed as dead code —
  // the agent could not call either. Registering them is the whole fix.
  registry.registerAll(knowledgeTools(process.env.MWA_KNOWLEDGE_DIR));
  // BL-14c: checks in the person's sandboxed runner — only when they have started one and given MWA its token.
  registry.registerAll(checkTools());
  // Gmail/Calendar tools (read + draft) appear once Gmail is connected; Outlook tools
  // (search_outlook/read_outlook/draft_outlook) once a Microsoft account is connected.
  // Distinct names → both can be connected at once with no collision.
  // Gmail has two connect paths that register the SAME tool names: OAuth (also gives
  // calendar) takes precedence; otherwise the App Password / IMAP path (email only).
  if (googleConfigured()) registry.registerAll(googleTools());
  else if (gmailImapConfigured()) registry.registerAll(gmailImapTools());
  if (microsoftConfigured()) registry.registerAll(microsoftTools());
  // Image generation: a generate_image tool appears once an image model is chosen (Settings).
  if (imageGenConfigured()) registry.registerAll(imageGenTools());
  const mcp = await loadMcpServers(config.tools.mcpServers ?? {});
  registry.registerAll(mcp.tools);
  return { registry, close: mcp.close };
}
