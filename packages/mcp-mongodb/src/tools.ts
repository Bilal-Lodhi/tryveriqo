/**
 * MCP tool registry — the single definition of every Assessment MongoDB tool.
 *
 * Both the stdio transport (`stdio-server.ts`) and the HTTP transport
 * (`http-server.ts`) build themselves from `createToolHandlers()` and
 * `TOOL_DEFINITIONS`, so the two transports can never expose different tool
 * sets or disagree about a handler's behaviour.
 */

import { MongoStore } from "./mongo-store.js";
import { MCP_TOOLS, type McpToolName } from "./tool-names.js";

/** JSON-schema fragment advertised through MCP `tools/list`. */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolDefinition {
  name: McpToolName;
  description: string;
  inputSchema: ToolInputSchema;
}

export type ToolArguments = Record<string, unknown>;
export type ToolHandler = (args: ToolArguments) => Promise<unknown>;
export type ToolHandlerTable = Record<McpToolName, ToolHandler>;

// ─── Argument coercion helpers ─────────────────────────────────────

class ToolArgumentError extends Error {}

function requireString(args: ToolArguments, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolArgumentError(`Missing required string parameter: ${key}`);
  }
  return value;
}

function requireObject(args: ToolArguments, key: string): Record<string, unknown> {
  const value = args[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolArgumentError(`Missing required object parameter: ${key}`);
  }
  return value as Record<string, unknown>;
}

function requireObjectArray(args: ToolArguments, key: string): Record<string, unknown>[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolArgumentError(`Missing required non-empty array parameter: ${key}`);
  }
  return value as Record<string, unknown>[];
}

/**
 * Reads an optional integer argument, clamped into `[min, max]`.
 *
 * A malformed value is a client error rather than a silent fallback: quietly
 * substituting a default for `eventLimit: "lots"` would hand the caller a page
 * size it did not ask for while implying it got one it did.
 */
function optionalInt(
  args: ToolArguments,
  key: string,
  bounds: { min: number; max: number; fallback: number },
): number {
  const value = args[key];
  if (value === undefined || value === null) return bounds.fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ToolArgumentError(`Parameter '${key}' must be an integer.`);
  }
  if (value < bounds.min || value > bounds.max) {
    throw new ToolArgumentError(
      `Parameter '${key}' must be between ${bounds.min} and ${bounds.max}.`,
    );
  }
  return value;
}

/**
 * Default and maximum page size for a session's telemetry timeline.
 *
 * The default matches the store's own limit. The maximum exists so a reviewer can
 * page further back without a single call returning an unbounded timeline.
 */
export const REVIEW_EVENT_LIMIT_DEFAULT = 500;
export const REVIEW_EVENT_LIMIT_MAX = 5000;

// ─── Tool metadata ─────────────────────────────────────────────────

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  {
    name: MCP_TOOLS.STORE_TEST_SUITE,
    description:
      "Persist a complete GeneratedTestSuite (assessment metadata, competencies, problems and hidden testing matrices) so it can be issued to candidates.",
    inputSchema: {
      type: "object",
      properties: {
        suite: { type: "object", description: "The GeneratedTestSuite document" },
      },
      required: ["suite"],
    },
  },
  {
    name: MCP_TOOLS.GET_TEST_SUITE,
    description: "Retrieve a persisted assessment suite by its suiteId.",
    inputSchema: {
      type: "object",
      properties: { suiteId: { type: "string", description: "Suite identifier" } },
      required: ["suiteId"],
    },
  },
  {
    name: MCP_TOOLS.CREATE_SESSION,
    description:
      "Create an assessment session for a candidate. Idempotent: re-creating an existing sessionId returns the existing record.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        candidateId: { type: "string" },
        assessmentId: { type: "string" },
        problemId: { type: "string" },
      },
      required: ["sessionId", "candidateId", "assessmentId"],
    },
  },
  {
    name: MCP_TOOLS.UPDATE_SESSION_CODE,
    description: "Replace the candidate's current code snapshot for a session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        code: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: MCP_TOOLS.UPDATE_SESSION_STATUS,
    description:
      "Move a session through its lifecycle (in_progress, submitted, flagged, evaluated, terminated).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        status: {
          type: "string",
          enum: ["in_progress", "submitted", "flagged", "evaluated", "terminated"],
        },
      },
      required: ["sessionId", "status"],
    },
  },
  {
    name: MCP_TOOLS.DELETE_SESSION,
    description:
      "Permanently delete a session together with its telemetry micro-events and integrity reports.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  {
    name: MCP_TOOLS.INGEST_MICRO_EVENTS,
    description:
      "Batch-ingest candidate telemetry micro-events (keystrokes, paste triggers, tab switches, copy attempts, submissions).",
    inputSchema: {
      type: "object",
      properties: {
        events: { type: "array", items: { type: "object" } },
      },
      required: ["events"],
    },
  },
  {
    name: MCP_TOOLS.STORE_INTEGRITY_REPORT,
    description:
      "Persist an integrity report (suspicion score, flags, plagiarism report and behavioural anomalies) for a session.",
    inputSchema: {
      type: "object",
      properties: { report: { type: "object" } },
      required: ["report"],
    },
  },
  {
    name: MCP_TOOLS.GET_SESSION_REVIEW,
    description:
      "Fetch everything a reviewer needs for one session: the session record, a page of its telemetry events (newest first) and its integrity reports. The response reports eventTotal alongside the page it returned, so a caller can tell a partial timeline from a complete one.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        eventLimit: {
          type: "number",
          description: `Events to return, 1-${REVIEW_EVENT_LIMIT_MAX}. Default ${REVIEW_EVENT_LIMIT_DEFAULT}.`,
        },
        eventOffset: {
          type: "number",
          description: "Events to skip from the newest end. Default 0.",
        },
        includeEventCounts: {
          type: "boolean",
          description:
            "Also return exact per-type event counts. Costs one aggregation; needed when rebuilding session state so counters are totals rather than page-derived.",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: MCP_TOOLS.GET_CANDIDATE_REPORT,
    description: "Aggregate the latest integrity report per session for one candidate.",
    inputSchema: {
      type: "object",
      properties: { candidateId: { type: "string" } },
      required: ["candidateId"],
    },
  },
  {
    name: MCP_TOOLS.LIST_SESSIONS,
    description: "List assessment sessions, newest first.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: MCP_TOOLS.HEALTH_CHECK,
    description: "Report MongoDB connectivity and the database name in use.",
    inputSchema: { type: "object", properties: {} },
  },
]);

/** Definitions indexed by tool name. */
export const TOOL_DEFINITIONS_BY_NAME: Readonly<Record<McpToolName, ToolDefinition>> =
  Object.freeze(
    Object.fromEntries(TOOL_DEFINITIONS.map((definition) => [definition.name, definition])) as Record<
      McpToolName,
      ToolDefinition
    >,
  );

// ─── Handlers ──────────────────────────────────────────────────────

/**
 * Builds the complete tool handler table for a store. The returned object has
 * exactly one entry per declared tool name.
 */
export function createToolHandlers(store: MongoStore): ToolHandlerTable {
  return {
    async [MCP_TOOLS.STORE_TEST_SUITE](args) {
      const suite = requireObject(args, "suite");
      const documentId = await store.storeTestSuite(suite);
      return { success: true, mongoDocumentId: documentId };
    },

    async [MCP_TOOLS.GET_TEST_SUITE](args) {
      const suite = await store.getTestSuite(requireString(args, "suiteId"));
      return { success: true, data: suite };
    },

    async [MCP_TOOLS.CREATE_SESSION](args) {
      const documentId = await store.createSession({
        sessionId: requireString(args, "sessionId"),
        candidateId: requireString(args, "candidateId"),
        assessmentId: requireString(args, "assessmentId"),
        ...(typeof args["problemId"] === "string" ? { problemId: args["problemId"] } : {}),
      });
      return { success: true, mongoDocumentId: documentId };
    },

    async [MCP_TOOLS.UPDATE_SESSION_CODE](args) {
      const sessionId = requireString(args, "sessionId");
      const code = typeof args["code"] === "string" ? args["code"] : "";
      const updated = await store.updateSession(sessionId, { submittedCode: code });
      return { success: true, updated };
    },

    async [MCP_TOOLS.UPDATE_SESSION_STATUS](args) {
      const sessionId = requireString(args, "sessionId");
      const status = requireString(args, "status");
      const updated = await store.updateSession(sessionId, { status });
      return { success: true, updated };
    },

    async [MCP_TOOLS.DELETE_SESSION](args) {
      const deleted = await store.deleteSession(requireString(args, "sessionId"));
      return { success: true, deleted };
    },

    async [MCP_TOOLS.INGEST_MICRO_EVENTS](args) {
      const events = requireObjectArray(args, "events");
      const processedCount = await store.ingestMicroEvents(events);
      return { success: true, processedCount };
    },

    async [MCP_TOOLS.STORE_INTEGRITY_REPORT](args) {
      const report = requireObject(args, "report");
      const documentId = await store.storeIntegrityReport(report);
      return { success: true, mongoDocumentId: documentId };
    },

    async [MCP_TOOLS.GET_SESSION_REVIEW](args) {
      const sessionId = requireString(args, "sessionId");
      const limit = optionalInt(args, "eventLimit", {
        min: 1,
        max: REVIEW_EVENT_LIMIT_MAX,
        fallback: REVIEW_EVENT_LIMIT_DEFAULT,
      });
      const offset = optionalInt(args, "eventOffset", {
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        fallback: 0,
      });
      const includeEventCounts = args["includeEventCounts"] === true;

      const [session, events, integrityReports, eventTotal] = await Promise.all([
        store.getSession(sessionId),
        store.getSessionEvents(sessionId, { limit, skip: offset }),
        store.getIntegrityReports(sessionId),
        store.countSessionEvents(sessionId),
      ]);

      // Exact per-type counts, only when asked for. The cohort list calls this
      // tool once per session and does not need them; recovery does, because
      // accumulating counters from a page undercounts a long session and makes
      // the analysis thresholds less likely to trip.
      const eventCounts = includeEventCounts
        ? await store.countSessionEventsByType(sessionId)
        : undefined;

      // The page is newest-first, so a reviewer who is shown only this page is
      // missing the OLDEST events. Reporting the true total and where the next
      // page starts is what stops a partial timeline from reading as a complete
      // one.
      const eventsReturned = events.length;
      const consumed = offset + eventsReturned;

      return {
        success: true,
        session,
        events,
        integrityReports,
        eventTotal,
        eventsReturned,
        eventsTruncated: consumed < eventTotal,
        nextEventOffset: consumed < eventTotal ? consumed : null,
        ...(eventCounts === undefined ? {} : { eventCounts }),
      };
    },

    async [MCP_TOOLS.GET_CANDIDATE_REPORT](args) {
      const reports = await store.getCandidateReport(requireString(args, "candidateId"));
      return { success: true, reports };
    },

    async [MCP_TOOLS.LIST_SESSIONS]() {
      const data = await store.listSessions();
      return { success: true, data };
    },

    async [MCP_TOOLS.HEALTH_CHECK]() {
      const healthy = await store.ping();
      return {
        success: healthy,
        connected: store.isConnected(),
        healthy,
        database: store.databaseNameInUse,
        timestamp: new Date().toISOString(),
      };
    },
  };
}

/** Tool names for which a handler is registered. */
export function registeredToolNames(handlers: ToolHandlerTable): McpToolName[] {
  return Object.keys(handlers) as McpToolName[];
}

/**
 * Invokes one tool by name, converting thrown errors into a stable
 * `{ success: false, error }` payload rather than an exception at the
 * transport edge.
 *
 * Lookup is restricted to the table's **own** properties. The handler table is a
 * plain object literal, so a bare `handlers[toolName]` walks the prototype chain
 * and resolves `constructor`, `toString`, `hasOwnProperty`, `__proto__` and
 * friends to `Object.prototype` members. Those are truthy, so an undeclared name
 * passed the "is this a real tool?" check and was invoked as though it were one,
 * returning `200` with a payload fabricated from the caller's arguments instead
 * of the `404` the transport owes. A test that used only the invented name
 * `no_such_tool` could never catch it, because that name does not collide with
 * the prototype.
 */
export async function dispatchTool(
  handlers: ToolHandlerTable,
  toolName: string,
  args: ToolArguments,
): Promise<{ status: number; payload: unknown }> {
  const handler = Object.hasOwn(handlers, toolName)
    ? (handlers as Record<string, ToolHandler | undefined>)[toolName]
    : undefined;

  if (!handler) {
    return {
      status: 404,
      payload: {
        success: false,
        error: `Unknown tool: ${toolName}`,
        availableTools: registeredToolNames(handlers),
      },
    };
  }

  try {
    const result = await handler(args);
    return { status: 200, payload: { ...(result as Record<string, unknown>) } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal MCP tool error";
    const status = error instanceof ToolArgumentError ? 400 : 500;
    return { status, payload: { success: false, error: message } };
  }
}

export { ToolArgumentError };
