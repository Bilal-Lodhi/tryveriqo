/**
 * Assessment API entry point.
 *
 * Fails closed: configuration is validated (and in production, secrets are
 * required) before the listener binds. No default credential exists, and
 * development mode is the only mode in which the API can run without operator
 * and session secrets.
 */

import { serve } from "@hono/node-server";
import { APP_VERSION, SERVICE_NAME, ConfigurationError, loadConfig } from "./config.js";
import { buildApp } from "./app.js";
import { GeminiAssessmentClient } from "./agents/gemini-client.js";
import { createMcpClient } from "./mcp-client.js";
import { SessionRegistry } from "./integrity-session.js";
import { MIN_SESSION_SECRET_LENGTH } from "./middleware/tokens.js";
import { randomBytes } from "node:crypto";

export interface StartedServer {
  port: number;
  close(): Promise<void>;
}

/**
 * Loads configuration, builds the application and starts listening.
 * Exported so integration tests can start a real server on an ephemeral port.
 */
export function startServer(overrides?: { port?: number; quiet?: boolean }): StartedServer {
  const config = loadConfig();
  const quiet = overrides?.quiet ?? false;
  const log = quiet ? (): void => undefined : console.log;

  if (config.environment === "production" && config.auth.sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new ConfigurationError(
      `ASSESSMENT_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters in production.`,
    );
  }

  if (config.environment !== "production") {
    if (config.auth.apiToken.length === 0) {
      const devToken = randomBytes(24).toString("base64url");
      config.auth.apiToken = devToken;
      log(
        "[security] Development mode: ASSESSMENT_API_TOKEN was not set, so a random token was generated " +
          "for this process only. This token grants full operator access and is printed once, below. " +
          "Set ASSESSMENT_API_TOKEN in .env to use a stable value.",
      );
      log(`[security] Development operator token: ${devToken}`);
    }
    if (config.auth.sessionSecret.length === 0) {
      config.auth.sessionSecret = randomBytes(32).toString("base64url");
      log(
        "[security] Development mode: ASSESSMENT_SESSION_SECRET was not set, so a random secret was " +
          "generated for this process only. Candidate session tokens will not survive a restart.",
      );
    }
    if (config.cors.allowedOrigins.length === 0) {
      log("[security] Development mode: no CORS origins configured; cross-origin browser calls are refused.");
    }
  }

  const port = overrides?.port ?? config.port;
  const ai = new GeminiAssessmentClient(config, log);
  const mcp = createMcpClient(config);

  if (!ai.isConfigured() && !quiet) {
    log(
      "[ai] No AI provider credential detected. Assessment generation will return HTTP 503 until " +
        "GEMINI_API_KEY is set (or AI_PROVIDER_MODE=vertex with GEMINI_VERTEX_PROJECT). " +
        "Telemetry ingestion and review do not require a model.",
    );
  }

  const app = buildApp({
    config,
    ai,
    mcp,
    sessions: new SessionRegistry(),
    log,
  });

  const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });

  log(
    `[${SERVICE_NAME}] v${APP_VERSION} listening on http://0.0.0.0:${port} ` +
      `(environment=${config.environment}, ai=${config.ai.mode}/${config.ai.model})`,
  );

  // Test affordance: allows a spawned server to shut itself down cleanly so a
  // startup assertion can observe a real listening server and a clean exit.
  const shutdownAfterMs = Number.parseInt(process.env["ASSESSMENT_SHUTDOWN_AFTER_MS"] ?? "", 10);
  if (Number.isFinite(shutdownAfterMs) && shutdownAfterMs > 0) {
    setTimeout(() => {
      server.close(() => process.exit(0));
    }, shutdownAfterMs);
  }

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const isMainModule =
  process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("index.ts");

if (isMainModule) {
  try {
    startServer();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error(`[${SERVICE_NAME}] Configuration error: ${error.message}`);
    } else {
      console.error(
        `[${SERVICE_NAME}] Fatal startup error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    process.exitCode = 1;
  }
}
