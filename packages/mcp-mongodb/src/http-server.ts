/**
 * HTTP transport for the Assessment MongoDB MCP tools.
 *
 * Exists so the API process can reach the tool layer over loopback without
 * spawning a stdio child. It is a thin transport: every route delegates to the
 * shared handler table in `tools.ts`, so it can never drift from the stdio
 * server's behaviour or tool set.
 *
 * Security: the tool surface is a datastore administration surface, not a
 * candidate-facing API. When `MCP_AUTH_TOKEN` is configured, every request
 * must present it; `ENVIRONMENT=production` refuses to start without a token.
 * CORS is an explicit allow-list and is never `*`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { MongoStore } from "./mongo-store.js";
import { MCP_TOOL_NAMES } from "./tool-names.js";
import {
  createToolHandlers,
  dispatchTool,
  registeredToolNames,
  type ToolArguments,
  type ToolHandlerTable,
} from "./tools.js";

export interface McpHttpServerOptions {
  store: MongoStore;
  port: number;
  /**
   * Interface to bind. Defaults to loopback, which is right when the API and
   * this transport share a container. Set to `0.0.0.0` only when the transport
   * runs as its own container and must accept the API's connections.
   */
  host?: string;
  /** When set, callers must present this token. */
  authToken?: string;
  /** `production` requires `authToken` to be present. */
  environment?: string;
  /** Explicit CORS allow-list. Empty means no CORS headers are emitted. */
  corsOrigins?: string[];
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function presentedToken(req: IncomingMessage): string {
  const header = req.headers["authorization"];
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const apiKey = req.headers["x-mcp-token"];
  if (typeof apiKey === "string") return apiKey.trim();
  return "";
}

async function readJsonBody(req: IncomingMessage): Promise<ToolArguments> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ToolArguments)
      : {};
  } catch {
    throw new Error("Invalid JSON body");
  }
}

export interface McpHttpServer {
  readonly port: number;
  readonly tools: readonly string[];
  listen(): Promise<number>;
  close(): Promise<void>;
}

export function createMcpHttpServer(options: McpHttpServerOptions): McpHttpServer {
  const { store, port } = options;
  const host = options.host ?? "127.0.0.1";
  const environment = options.environment ?? process.env["ENVIRONMENT"] ?? "development";
  const authToken = options.authToken ?? process.env["MCP_AUTH_TOKEN"] ?? "";
  const corsOrigins = options.corsOrigins ?? [];

  if (environment === "production" && authToken.length === 0) {
    throw new Error(
      "MCP_AUTH_TOKEN must be set when ENVIRONMENT=production — refusing to start an unprotected tool surface.",
    );
  }

  const handlers: ToolHandlerTable = createToolHandlers(store);
  const toolNames = MCP_TOOL_NAMES;

  function applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers["origin"];
    if (typeof origin === "string" && corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-MCP-Token");
      res.setHeader("Access-Control-Max-Age", "86400");
    }
  }

  function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(payload));
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      console.error("[mcp-http] Unhandled error:", error instanceof Error ? error.message : error);
      if (!res.headersSent) sendJson(res, 500, { success: false, error: "Internal MCP error" });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applyCors(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    // Liveness probe. Deliberately unauthenticated so container orchestration
    // can observe process health without holding a credential. It reports no
    // data beyond connectivity.
    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, {
        status: (await store.ping()) ? "healthy" : "degraded",
        service: "assessment-mcp-mongodb",
        database: store.databaseNameInUse,
        toolCount: toolNames.length,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (authToken.length > 0 && !constantTimeEquals(presentedToken(req), authToken)) {
      sendJson(res, 401, { success: false, error: "Unauthorized" });
      return;
    }

    if (req.method === "GET" && path === "/tools") {
      sendJson(res, 200, { success: true, tools: registeredToolNames(handlers) });
      return;
    }

    if (req.method === "POST" && path.startsWith("/tools/")) {
      const toolName = decodeURIComponent(path.slice("/tools/".length));
      let args: ToolArguments;
      try {
        args = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, {
          success: false,
          error: error instanceof Error ? error.message : "Invalid JSON body",
        });
        return;
      }

      const { status, payload } = await dispatchTool(handlers, toolName, args);
      sendJson(res, status, { ...(payload as Record<string, unknown>), correlationId: randomUUID() });
      return;
    }

    sendJson(res, 404, {
      success: false,
      error: `Not found: ${req.method} ${path}`,
      endpoints: {
        "GET /health": "Process and MongoDB connectivity probe",
        "GET /tools": "List registered MCP tools",
        "POST /tools/:toolName": "Invoke an MCP tool",
      },
    });
  }

  return {
    port,
    tools: toolNames,
    listen(): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const address = server.address();
          const bound = typeof address === "object" && address ? address.port : port;
          console.error(`[mcp-http] Listening on http://${host}:${bound}`);
          console.error(`[mcp-http] Tools: ${toolNames.join(", ")}`);
          resolve(bound);
        });
      });
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
