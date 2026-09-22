/**
 * Environment configuration for the Cerberus AI Hono API.
 * Uses dotenv for local development; Cloud Run injects env vars in production.
 *
 * ═══════════════════════════════════════════════════════════════════
 * VERTEX AI ONLY — Enterprise GCP Path
 * ═══════════════════════════════════════════════════════════════════
 *
 * All Gemini model calls go through the @google/genai SDK
 * (Vertex AI backend) with Application Default Credentials (ADC).
 * Requires: GCP_PROJECT_ID, GCP_LOCATION.
 *
 * Local ADC setup: gcloud auth application-default login
 * Cloud Run: ADC is auto-injected via the metadata server.
 */

import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ═══════════════════════════════════════════════════════════════════
// Application Default Credentials (ADC) Auto-Discovery
// ═══════════════════════════════════════════════════════════════════
//
// The Vertex AI SDK looks for credentials at the path set in
// GOOGLE_APPLICATION_CREDENTIALS. If that env var is not set,
// we walk the filesystem looking for the standard ADC file.
// On Cloud Run the metadata server provides auth — this block
// is a no-op in production.

function discoverApplicationDefaultCredentials(): string | null {
  if (process.env["GOOGLE_APPLICATION_CREDENTIALS"]) return null;

  const candidates = [
    // Standard Google Cloud SDK location on Windows
    resolve(process.env["APPDATA"] ?? "", "gcloud", "application_default_credentials.json"),
    // Standard Google Cloud SDK location on Linux/macOS
    resolve(process.env["HOME"] ?? "", ".config", "gcloud", "application_default_credentials.json"),
    // Project root (monorepo layout: hono-api is inside sandbox/)
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "application_default_credentials.json"),
    // Inside hono-api directory itself
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "application_default_credentials.json"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      console.log(`[config] ADC auto-discovered → ${candidate}`);
      return candidate;
    }
  }

  return null;
}

const adcPath = discoverApplicationDefaultCredentials();
if (adcPath) {
  process.env["GOOGLE_APPLICATION_CREDENTIALS"] = adcPath;
}

// ═══════════════════════════════════════════════════════════════════
// Config Types
// ═══════════════════════════════════════════════════════════════════

export interface AppConfig {
  port: number;
  gemini: GeminiConfig;
  mcp: MCPConfig;
  security: SecurityConfig;
}

export interface GeminiConfig {
  /** GCP project ID (required). */
  projectId: string;
  /** GCP region (e.g. "us-central1"). */
  location: string;
  /** Model name (e.g. "gemini-3-flash-preview"). */
  model: string;
  /** Maximum output tokens per response. */
  maxOutputTokens: number;
  /** Temperature (0-2). Lower = more deterministic. */
  temperature: number;
  /** Per-attempt timeout in ms (default 90_000 = 90s). */
  requestTimeoutMs: number;
}

export interface MCPConfig {
  /** MCP server URL (MongoDB track). */
  serverEndpoint: string;
  apiKey: string;
  timeoutMs: number;
}

export interface SecurityConfig {
  /** Session expiry in seconds. */
  sessionTTLSeconds: number;
  /** Max allowed paste events before auto-flagging. */
  maxPasteEventsPerSession: number;
  /** Min keystroke interval considered human (ms). */
  minHumanKeystrokeMs: number;
  /** Semantic similarity threshold for plagiarism. */
  plagiarismThreshold: number;
}

// ═══════════════════════════════════════════════════════════════════
// Config Loader
// ═══════════════════════════════════════════════════════════════════

export function loadConfig(): AppConfig {
  const port = parseInt(process.env["PORT"] ?? "8080", 10);

  const projectId = process.env["GCP_PROJECT_ID"] ?? "";
  const location = process.env["GCP_LOCATION"] ?? "us-central1";

  if (!projectId) {
    console.error(
      "[config] FATAL: GCP_PROJECT_ID is not set. " +
        "Vertex AI requires a Google Cloud project ID. " +
        "Set it in .env or via environment variable."
    );
    process.exitCode = 1;
  } else {
    console.log(
      `[config] Vertex AI → project="${projectId}" location="${location}"`
    );
  }

  const gemini: GeminiConfig = {
    projectId,
    location,
    model: process.env["GEMINI_MODEL"] ?? "gemini-3-flash-preview",
    maxOutputTokens: parseInt(
      process.env["GEMINI_MAX_OUTPUT_TOKENS"] ?? "65536",
      10
    ),
    temperature: parseFloat(process.env["GEMINI_TEMPERATURE"] ?? "0.2"),
    requestTimeoutMs: parseInt(
      process.env["GEMINI_REQUEST_TIMEOUT_MS"] ?? "90000",
      10
    ),
  };

  const mcp: MCPConfig = {
    serverEndpoint:
      process.env["MCP_SERVER_ENDPOINT"] ?? "http://localhost:3001",
    apiKey: process.env["MCP_API_KEY"] ?? "",
    timeoutMs: parseInt(process.env["MCP_TIMEOUT_MS"] ?? "10000", 10),
  };

  const security: SecurityConfig = {
    sessionTTLSeconds: parseInt(
      process.env["SESSION_TTL_SECONDS"] ?? "7200",
      10
    ),
    maxPasteEventsPerSession: parseInt(
      process.env["MAX_PASTE_EVENTS"] ?? "5",
      10
    ),
    minHumanKeystrokeMs: parseInt(
      process.env["MIN_HUMAN_KEYSTROKE_MS"] ?? "80",
      10
    ),
    plagiarismThreshold: parseFloat(
      process.env["PLAGIARISM_THRESHOLD"] ?? "0.75"
    ),
  };

  return { port, gemini, mcp, security };
}