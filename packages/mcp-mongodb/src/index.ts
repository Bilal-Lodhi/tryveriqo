/**
 * Public surface of the Assessment MongoDB MCP tool package.
 *
 * `apps/api` imports the tool-name contract from here so that callers and
 * handlers are provably linked at build time and in tests.
 */

export { MCP_TOOLS, MCP_TOOL_NAMES, type McpToolName } from "./tool-names.js";
export {
  COLLECTIONS,
  DEFAULT_DATABASE_NAME,
  type CollectionName,
  type CollectionValue,
} from "./collections.js";
export { MongoStore, type MongoConfig, type MongoStoreOptions, type DbLike } from "./mongo-store.js";
export {
  createToolHandlers,
  dispatchTool,
  registeredToolNames,
  TOOL_DEFINITIONS,
  TOOL_DEFINITIONS_BY_NAME,
  ToolArgumentError,
  type ToolArguments,
  type ToolDefinition,
  type ToolHandler,
  type ToolHandlerTable,
} from "./tools.js";
export {
  BodyTooLargeError,
  MAX_MCP_BODY_BYTES,
  createMcpHttpServer,
  type McpHttpServer,
  type McpHttpServerOptions,
} from "./http-server.js";
