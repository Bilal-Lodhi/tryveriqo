/**
 * HTTP client for the Assessment MCP tool surface.
 *
 * Every call names its tool through the shared `MCP_TOOLS` contract, so a
 * renamed tool fails a build or a test rather than failing silently at runtime.
 * Calls are timeout-isolated and non-fatal by default: telemetry persistence
 * must never take down an ingestion request.
 */

import { MCP_TOOLS, type McpToolName } from "@assessment/mcp-mongodb";
import type { AppConfig } from "./config.js";

export interface McpCallResult<T> {
  ok: boolean;
  data: T | null;
  error?: string;
}

export interface McpClient {
  call<T>(tool: McpToolName, args: Record<string, unknown>): Promise<McpCallResult<T>>;
}

export interface McpHttpClientOptions {
  endpoint: string;
  authToken?: string;
  timeoutMs?: number;
}

export class McpHttpClient implements McpClient {
  private readonly endpoint: string;
  private readonly authToken: string;
  private readonly timeoutMs: number;

  constructor(options: McpHttpClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.authToken = options.authToken ?? "";
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async call<T>(tool: McpToolName, args: Record<string, unknown>): Promise<McpCallResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.authToken.length > 0) {
        headers["Authorization"] = `Bearer ${this.authToken}`;
      }

      const response = await fetch(`${this.endpoint}/tools/${tool}`, {
        method: "POST",
        headers,
        body: JSON.stringify(args),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        return {
          ok: false,
          data: null,
          error: `MCP tool ${tool} failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        };
      }

      return { ok: true, data: (await response.json()) as T };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false,
        data: null,
        error: aborted
          ? `MCP tool ${tool} timed out after ${this.timeoutMs}ms`
          : `MCP tool ${tool} unreachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Builds the MCP client from application configuration. */
export function createMcpClient(config: AppConfig): McpClient {
  return new McpHttpClient({
    endpoint: config.mcp.endpoint,
    authToken: config.mcp.authToken,
    timeoutMs: config.mcp.timeoutMs,
  });
}

/** Thrown internally when a persistence call is required to succeed. */
export class McpPersistenceError extends Error {}

// ─── Typed persistence helpers ─────────────────────────────────────
//
// These are the only places that know which tool backs which operation, so the
// route layer never hard-codes a tool string.

export async function persistTestSuite(
  mcp: McpClient,
  suite: unknown,
): Promise<McpCallResult<{ documentId?: string }>> {
  return mcp.call<{ documentId?: string }>(MCP_TOOLS.STORE_TEST_SUITE, { suite });
}

export async function fetchTestSuite(
  mcp: McpClient,
  suiteId: string,
): Promise<McpCallResult<{ data: unknown }>> {
  return mcp.call<{ data: unknown }>(MCP_TOOLS.GET_TEST_SUITE, { suiteId });
}

export async function createSession(
  mcp: McpClient,
  session: {
    sessionId: string;
    candidateId: string;
    assessmentId: string;
    problemId?: string;
  },
): Promise<McpCallResult<{ mongoDocumentId?: string }>> {
  return mcp.call<{ mongoDocumentId?: string }>(MCP_TOOLS.CREATE_SESSION, { ...session });
}

export async function updateSessionCode(
  mcp: McpClient,
  sessionId: string,
  code: string,
): Promise<McpCallResult<{ updated?: boolean }>> {
  return mcp.call<{ updated?: boolean }>(MCP_TOOLS.UPDATE_SESSION_CODE, { sessionId, code });
}

export async function updateSessionStatus(
  mcp: McpClient,
  sessionId: string,
  status: string,
): Promise<McpCallResult<{ updated?: boolean }>> {
  return mcp.call<{ updated?: boolean }>(MCP_TOOLS.UPDATE_SESSION_STATUS, { sessionId, status });
}

export async function deleteSession(
  mcp: McpClient,
  sessionId: string,
): Promise<McpCallResult<{ deleted?: boolean }>> {
  return mcp.call<{ deleted?: boolean }>(MCP_TOOLS.DELETE_SESSION, { sessionId });
}

export async function ingestMicroEvents(
  mcp: McpClient,
  events: unknown[],
): Promise<McpCallResult<{ processedCount?: number }>> {
  return mcp.call<{ processedCount?: number }>(MCP_TOOLS.INGEST_MICRO_EVENTS, { events });
}

export async function storeIntegrityReport(
  mcp: McpClient,
  report: unknown,
): Promise<McpCallResult<{ documentId?: string }>> {
  return mcp.call<{ documentId?: string }>(MCP_TOOLS.STORE_INTEGRITY_REPORT, { report });
}

export interface SessionReviewData {
  session: {
    sessionId: string;
    candidateId: string;
    assessmentId: string;
    status?: string;
    submittedCode?: string;
  } | null;
  events: Array<{
    sessionId?: string;
    eventType: string;
    timestamp: string;
    payload?: Record<string, unknown>;
  }>;
  integrityReports: Array<Record<string, unknown>>;
  /** Total telemetry events stored for the session, regardless of paging. */
  eventTotal?: number;
  /** Events actually returned in this page. */
  eventsReturned?: number;
  /** True when the returned page is not the whole record. */
  eventsTruncated?: boolean;
  /** Offset to pass as `eventOffset` to fetch the next older page, or null. */
  nextEventOffset?: number | null;
}

export interface SessionReviewOptions {
  /** Events to return. Bounded by the tool surface. */
  eventLimit?: number;
  /** Events to skip from the newest end. */
  eventOffset?: number;
}

export async function fetchSessionReview(
  mcp: McpClient,
  sessionId: string,
  options: SessionReviewOptions = {},
): Promise<McpCallResult<SessionReviewData>> {
  return mcp.call<SessionReviewData>(MCP_TOOLS.GET_SESSION_REVIEW, {
    sessionId,
    ...(options.eventLimit === undefined ? {} : { eventLimit: options.eventLimit }),
    ...(options.eventOffset === undefined ? {} : { eventOffset: options.eventOffset }),
  });
}

export async function listSessions(
  mcp: McpClient,
): Promise<
  McpCallResult<{
    data?: Array<{
      sessionId: string;
      candidateId: string;
      assessmentId: string;
      status: string;
      createdAt?: string;
      updatedAt?: string;
    }>;
  }>
> {
  return mcp.call(MCP_TOOLS.LIST_SESSIONS, {});
}

export async function fetchCandidateReport(
  mcp: McpClient,
  candidateId: string,
): Promise<McpCallResult<{ reports?: Array<Record<string, unknown>> }>> {
  return mcp.call<{ reports?: Array<Record<string, unknown>> }>(MCP_TOOLS.GET_CANDIDATE_REPORT, {
    candidateId,
  });
}
