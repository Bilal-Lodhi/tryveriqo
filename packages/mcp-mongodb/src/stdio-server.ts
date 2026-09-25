/**
 * stdio transport for the Assessment MongoDB MCP tools.
 *
 * Used when the tool server is consumed directly by an MCP-capable client
 * (MCP Inspector, an agent runtime, or a desktop client) rather than by the
 * tryveriqo API over HTTP.
 *
 *   npx @modelcontextprotocol/inspector node packages/mcp-mongodb/dist/stdio-server.js
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolRequest,
  type ListResourcesRequest,
  type ListToolsRequest,
  type ReadResourceRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { MongoStore } from "./mongo-store.js";
import { createToolHandlers, TOOL_DEFINITIONS, dispatchTool } from "./tools.js";

const store = new MongoStore();

const server = new Server(
  { name: "tryveriqo-mcp-mongodb", version: "0.2.0" },
  { capabilities: { tools: {}, resources: {}, logging: {} } },
);

const handlers = createToolHandlers(store);

server.setRequestHandler(ListToolsRequestSchema, async (_request: ListToolsRequest) => ({
  tools: TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const { name, arguments: args } = request.params;
  const { payload } = await dispatchTool(
    handlers,
    name,
    (args ?? {}) as Record<string, unknown>,
  );
  const result = payload as { success?: boolean };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    ...(result.success === false ? { isError: true } : {}),
  };
});

// ─── Resources ─────────────────────────────────────────────────────

const RESOURCES = [
  {
    uri: "mongo://health",
    name: "MongoDB connectivity",
    description: "Current MongoDB connectivity status for the Assessment store",
    mimeType: "application/json",
  },
];

server.setRequestHandler(ListResourcesRequestSchema, async (_request: ListResourcesRequest) => ({
  resources: RESOURCES,
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request: ReadResourceRequest) => {
  const { uri } = request.params;
  if (uri !== "mongo://health") {
    throw new Error(`Unknown resource: ${uri}`);
  }
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({
          connected: store.isConnected(),
          healthy: await store.ping(),
          database: store.databaseNameInUse,
          timestamp: new Date().toISOString(),
        }),
      },
    ],
  };
});

// ─── Bootstrap ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  await store.connect();
  console.error(`[mcp-stdio] Connected to MongoDB database "${store.databaseNameInUse}"`);
  await server.connect(new StdioServerTransport());
  console.error("[mcp-stdio] Assessment MCP server running on stdio");
}

async function shutdown(): Promise<void> {
  console.error("[mcp-stdio] Shutting down");
  await store.disconnect();
  await server.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

main().catch((error: unknown) => {
  console.error("[mcp-stdio] Fatal startup error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
