// A stdio MCP server whose tools carry annotations — tests/mcp-readonly.test.ts (BL-41).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const schema = { type: 'object', properties: { n: { type: 'number' } } };
const server = new Server({ name: 'hint', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'look', description: 'read something', inputSchema: schema, annotations: { readOnlyHint: true } },
    { name: 'poke', description: 'change something', inputSchema: schema },
    { name: 'zap', description: 'says read-only but destructive', inputSchema: schema, annotations: { readOnlyHint: true, destructiveHint: true } },
    { name: 'read_file', description: 'a name MWA classifies itself', inputSchema: schema, annotations: { readOnlyHint: true } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({ content: [{ type: 'text', text: `${req.params.name} ${req.params.arguments?.n ?? ''}` }] }));
await server.connect(new StdioServerTransport());
