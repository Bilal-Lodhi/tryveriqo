/**
 * Canonical MCP tool-name contract.
 *
 * This module is the single source of truth for the names of the MCP tools
 * exposed by the Assessment MongoDB server. Both transports (stdio and HTTP)
 * and every API-side caller resolve tool names from `MCP_TOOLS`, so a rename
 * can never silently desynchronise a caller from its handler.
 *
 * `apps/api/test/mcp-contract.test.ts` asserts that the API only ever calls
 * names declared here, and that the registered handler table covers exactly
 * this set.
 */

/** Stable tool names, as seen on the wire (MCP `tools/call` and `POST /tools/:name`). */
export const MCP_TOOLS = Object.freeze({
  STORE_TEST_SUITE: "store_test_suite",
  GET_TEST_SUITE: "get_test_suite",
  CREATE_SESSION: "create_session",
  UPDATE_SESSION_CODE: "update_session_code",
  UPDATE_SESSION_STATUS: "update_session_status",
  DELETE_SESSION: "delete_session",
  INGEST_MICRO_EVENTS: "ingest_micro_events",
  STORE_INTEGRITY_REPORT: "store_integrity_report",
  GET_SESSION_REVIEW: "get_session_review",
  GET_CANDIDATE_REPORT: "get_candidate_report",
  LIST_SESSIONS: "list_sessions",
  HEALTH_CHECK: "health_check",
} as const);

export type McpToolName = (typeof MCP_TOOLS)[keyof typeof MCP_TOOLS];

/** Every declared tool name, in declaration order. */
export const MCP_TOOL_NAMES: readonly McpToolName[] = Object.freeze(
  Object.values(MCP_TOOLS),
);
