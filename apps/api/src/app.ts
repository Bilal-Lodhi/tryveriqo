/**
 * Hono application assembly.
 *
 * `buildApp` wires configuration, collaborators, middleware and routes into a
 * Hono instance without starting a listener, which is what the automated test
 * suite drives directly.
 *
 * Middleware order matters and is deliberate:
 *   1. correlation id      — every later response can be traced
 *   2. body-size ceilings  — nothing buffers an unbounded body
 *   3. authenticate        — resolves the caller, never rejects
 *   4. routes              — each route declares the access it requires
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { bodyLimit } from "hono/body-limit";

import { APP_VERSION, SERVICE_NAME, type AppConfig } from "./config.js";
import type { AssessmentAiClient } from "./agents/gemini-client.js";
import type { McpClient } from "./mcp-client.js";
import { SessionRegistry } from "./integrity-session.js";
import { authenticate, type AppEnv } from "./middleware/auth.js";
import { correlationId } from "./middleware/correlation.js";
import { rateLimit } from "./middleware/rate-limit.js";
import type { ApiDependencies } from "./routes/dependencies.js";
import { healthRoutes } from "./routes/health.js";
import { identityRoutes } from "./routes/identity.js";
import { generateRoutes } from "./routes/generate.js";
import { integrityRoutes } from "./routes/integrity.js";
import { sessionRoutes } from "./routes/sessions.js";
import { candidateRoutes } from "./routes/candidates.js";

/**
 * Request-body ceilings.
 *
 * Nothing bounded a request body before this, and `POST /api/v1/identity/set` is
 * **unauthenticated by design**, so any caller on the network could make the
 * process buffer an arbitrarily large body. The ceilings are per-route rather
 * than one global value: registration carries two short strings plus a
 * capability, while ingestion legitimately carries a telemetry batch.
 *
 * `MAX_API_BODY_BYTES` is a backstop for any route added later that parses a
 * body. It is deliberately the largest of the three, so applying it to `/api/*`
 * cannot silently tighten a more specific ceiling.
 */
export const IDENTITY_BODY_BYTES = 16 * 1024;
export const GENERATE_BODY_BYTES = 64 * 1024;
export const MAX_API_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Rejects an oversized body before it is parsed, with the same JSON error shape
 * every other failure uses. `hono/body-limit` checks `Content-Length` when it is
 * present and trustworthy, and otherwise counts the stream, so a missing or
 * forged length cannot bypass the ceiling.
 */
function bodyLimitJson(maxSize: number, name: string): MiddlewareHandler<AppEnv> {
  return bodyLimit({
    maxSize,
    onError: (c) =>
      c.json(
        {
          success: false,
          error: `Request body exceeds the ${name} limit of ${maxSize} bytes.`,
          correlationId: c.get("correlationId") ?? "unknown",
        },
        413,
      ),
  });
}

export interface BuildAppOptions {
  config: AppConfig;
  ai: AssessmentAiClient;
  mcp: McpClient;
  sessions?: SessionRegistry;
  /** Overrides the diagnostics sink; tests use a silent sink by default. */
  log?: (message: string) => void;
  /** Set false to silence Hono's request logger in tests. */
  requestLogging?: boolean;
}

export function buildApp(options: BuildAppOptions): Hono<AppEnv> {
  const { config, ai, mcp } = options;
  const log = options.log ?? console.log;

  const deps: ApiDependencies = {
    config,
    ai,
    mcp,
    sessions: options.sessions ?? new SessionRegistry(),
    log,
  };

  const app = new Hono<AppEnv>();

  // ── 1. Correlation id ─────────────────────────────────────────
  // Registered before any route so it applies to every response.
  app.use("*", correlationId());

  // ── 2. Body-size ceilings ─────────────────────────────────────
  // Before authentication and before any route parses a body. Specific paths
  // first: Hono runs every matching middleware, so the backstop must be the
  // largest ceiling or it would silently tighten the others.
  app.use("/api/v1/identity/*", bodyLimitJson(IDENTITY_BODY_BYTES, "candidate identity"));
  app.use("/api/v1/generate", bodyLimitJson(GENERATE_BODY_BYTES, "assessment generation"));
  app.use("/api/v1/integrity/ingest", bodyLimitJson(MAX_API_BODY_BYTES, "telemetry ingestion"));
  app.use("/api/*", bodyLimitJson(MAX_API_BODY_BYTES, "API request"));

  // ── 3. Authentication (resolve, never reject) ─────────────────
  // Must precede route registration: a Hono middleware applies to the routes
  // registered after it.
  app.use("/api/*", authenticate(config));

  // ── 3. CORS: explicit allow-list only ─────────────────────────
  const allowedOrigins = config.cors.allowedOrigins;
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (allowedOrigins.length === 0) return undefined;
        return allowedOrigins.includes(origin) ? origin : undefined;
      },
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-Generation-Request-Id",
        "X-Correlation-Id",
      ],
      exposeHeaders: ["X-Correlation-Id", "Retry-After"],
      credentials: false,
      maxAge: 86400,
    }),
  );

  // ── 4. Diagnostics ────────────────────────────────────────────
  if (options.requestLogging ?? config.environment !== "test") {
    app.use("*", logger());
  }

  // ── 5. Routes ─────────────────────────────────────────────────
  const health = healthRoutes(config);
  app.route("/", health);
  app.route("/health", health);

  app.use(
    "/api/v1/identity/set",
    rateLimit({ windowMs: 60_000, max: 30, name: "identity registration" }),
  );
  app.use(
    "/api/v1/generate",
    rateLimit({ windowMs: 60_000, max: 20, name: "assessment generation" }),
  );

  app.route("/api/v1/identity", identityRoutes(deps));
  app.route("/api/v1/generate", generateRoutes(deps));
  app.route("/api/v1/integrity", integrityRoutes(deps));
  app.route("/api/v1/sessions", sessionRoutes(deps));
  app.route("/api/v1/candidates", candidateRoutes(deps));

  // ── 6. Terminal handlers ──────────────────────────────────────
  app.notFound((c) =>
    c.json(
      {
        success: false,
        error: `Route not found: ${c.req.method} ${c.req.path}`,
        correlationId: c.get("correlationId") ?? "unknown",
      },
      404,
    ),
  );

  app.onError((error, c) => {
    // Log the failure class, never the payload: request bodies can contain
    // candidate code and personal data.
    log(
      `[${SERVICE_NAME}] [${c.get("correlationId") ?? "unknown"}] Unhandled error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return c.json(
      {
        success: false,
        error: "Internal server error.",
        correlationId: c.get("correlationId") ?? "unknown",
      },
      500,
    );
  });

  return app;
}

export { APP_VERSION };
