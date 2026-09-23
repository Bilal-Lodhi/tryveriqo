/**
 * Environment configuration for the tryveriqo API.
 *
 * Configuration is explicit and fails closed: every value comes from the
 * process environment, and `loadConfig()` throws when production is missing a
 * required secret. There is no implicit credential discovery from the
 * filesystem, and no default credential of any kind.
 */

export type Environment = "development" | "test" | "production";

export const APP_VERSION = "0.1.0";
export const SERVICE_NAME = "tryveriqo-api";

export interface AiProviderConfig {
  /** "gemini-api" uses an API key; "vertex" uses Google Cloud ADC. */
  mode: "gemini-api" | "vertex";
  /** API key for the Gemini Developer API (`gemini-api` mode only). */
  apiKey: string;
  /** Google Cloud project (`vertex` mode only). */
  projectId: string;
  /** Google Cloud region (`vertex` mode only). */
  location: string;
  model: string;
  maxOutputTokens: number;
  temperature: number;
  requestTimeoutMs: number;
}

export interface DatabaseConfig {
  uri: string;
  databaseName: string;
}

export interface McpConfig {
  /** Base URL of the MCP HTTP transport, e.g. http://127.0.0.1:3001 */
  endpoint: string;
  /** Shared token presented to the MCP tool surface. */
  authToken: string;
  timeoutMs: number;
}

export interface AuthConfig {
  /** Operator/reviewer bearer token. */
  apiToken: string;
  /** Secret used to sign short-lived candidate session tokens. */
  sessionSecret: string;
  /** Candidate session token lifetime. */
  candidateTokenTtlSeconds: number;
}

export interface CorsConfig {
  /** Explicit origin allow-list. Never `*`. */
  allowedOrigins: string[];
}

export interface IntegrityConfig {
  sessionTtlSeconds: number;
  maxPasteEventsPerSession: number;
  minHumanKeystrokeMs: number;
  plagiarismThreshold: number;
  /** Overall integrity score above which an alert is raised. */
  alertScoreThreshold: number;
}

export interface AppConfig {
  environment: Environment;
  port: number;
  ai: AiProviderConfig;
  database: DatabaseConfig;
  mcp: McpConfig;
  auth: AuthConfig;
  cors: CorsConfig;
  integrity: IntegrityConfig;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readString(name: string, fallback = ""): string {
  const raw = process.env[name];
  return raw === undefined ? fallback : raw.trim();
}

function readEnvironment(): Environment {
  const raw = (process.env["ENVIRONMENT"] ?? process.env["NODE_ENV"] ?? "development").toLowerCase();
  if (raw === "production" || raw === "test" || raw === "development") return raw;
  return "development";
}

function parseCorsOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0 && origin !== "*");
}

/** Default development origins: the local console and API. */
const DEVELOPMENT_ORIGINS = [
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

export class ConfigurationError extends Error {}

export function loadConfig(): AppConfig {
  const environment = readEnvironment();

  const explicitOrigins = parseCorsOrigins(readString("CORS_ALLOWED_ORIGINS"));
  const allowedOrigins =
    explicitOrigins.length > 0
      ? explicitOrigins
      : environment === "production"
        ? []
        : DEVELOPMENT_ORIGINS;

  const aiMode = readString("AI_PROVIDER_MODE") === "vertex" ? "vertex" : "gemini-api";

  const apiToken = readString("ASSESSMENT_API_TOKEN");
  const sessionSecret = readString("ASSESSMENT_SESSION_SECRET");

  if (environment === "production") {
    const missing: string[] = [];
    if (!apiToken) missing.push("ASSESSMENT_API_TOKEN");
    if (!sessionSecret) missing.push("ASSESSMENT_SESSION_SECRET");
    if (allowedOrigins.length === 0) missing.push("CORS_ALLOWED_ORIGINS");
    if (aiMode === "gemini-api" && !readString("GEMINI_API_KEY")) missing.push("GEMINI_API_KEY");
    if (aiMode === "vertex" && !readString("GEMINI_VERTEX_PROJECT")) {
      missing.push("GEMINI_VERTEX_PROJECT");
    }
    if (missing.length > 0) {
      throw new ConfigurationError(
        `Refusing to start in production with incomplete configuration. Missing: ${missing.join(", ")}`,
      );
    }
  }

  return {
    environment,
    port: readInt("PORT", 8080),
    ai: {
      mode: aiMode,
      apiKey: readString("GEMINI_API_KEY"),
      projectId: readString("GEMINI_VERTEX_PROJECT"),
      location: readString("GEMINI_VERTEX_LOCATION", "us-central1") || "us-central1",
      model: readString("AI_MODEL", "gemini-2.5-flash") || "gemini-2.5-flash",
      maxOutputTokens: readInt("AI_MAX_OUTPUT_TOKENS", 65536),
      temperature: readFloat("AI_TEMPERATURE", 0.2),
      requestTimeoutMs: readInt("AI_REQUEST_TIMEOUT_MS", 90_000),
    },
    database: {
      uri: readString("MONGODB_URI", "mongodb://127.0.0.1:27017") || "mongodb://127.0.0.1:27017",
      databaseName: readString("MONGODB_DATABASE", "assessment") || "assessment",
    },
    mcp: {
      endpoint:
        readString("MCP_SERVER_ENDPOINT", "http://127.0.0.1:3001") || "http://127.0.0.1:3001",
      authToken: readString("MCP_AUTH_TOKEN"),
      timeoutMs: readInt("MCP_TIMEOUT_MS", 5_000),
    },
    auth: {
      apiToken,
      sessionSecret,
      candidateTokenTtlSeconds: readInt("CANDIDATE_SESSION_TTL_SECONDS", 7200),
    },
    cors: { allowedOrigins },
    integrity: {
      sessionTtlSeconds: readInt("SESSION_TTL_SECONDS", 7200),
      maxPasteEventsPerSession: readInt("MAX_PASTE_EVENTS", 5),
      minHumanKeystrokeMs: readInt("MIN_HUMAN_KEYSTROKE_MS", 80),
      plagiarismThreshold: readFloat("PLAGIARISM_THRESHOLD", 0.75),
      alertScoreThreshold: readInt("ALERT_SCORE_THRESHOLD", 50),
    },
  };
}
