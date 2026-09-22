/**
 * Liveness and capability discovery.
 *
 * Public by design: it exposes process health, the configured AI model name and
 * the API version, and never credentials, connection strings or candidate data.
 */

import { Hono } from "hono";
import { APP_VERSION, SERVICE_NAME, type AppConfig } from "../config.js";
import type { AppEnv } from "../middleware/auth.js";

export function healthRoutes(config: AppConfig): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get("/", (c) =>
    c.json({
      status: "healthy",
      service: SERVICE_NAME,
      version: APP_VERSION,
      environment: config.environment,
      aiProvider: `gemini (${config.ai.mode})`,
      aiModel: config.ai.model,
      database: config.database.databaseName,
      endpoints: {
        identity: "POST /api/v1/identity/set",
        generate: "POST /api/v1/generate",
        telemetry: "POST /api/v1/integrity/ingest",
        sessions: "GET /api/v1/sessions",
        review: "GET /api/v1/sessions/:sessionId/review",
      },
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    }),
  );

  return router;
}
