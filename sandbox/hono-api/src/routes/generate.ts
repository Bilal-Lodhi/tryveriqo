/**
 * Route: POST /api/v1/generate
 * Feature 1 — AUTONOMOUS TEST SUITE GENERATOR
 *
 * Accepts a single text prompt and delegates to the Orchestrator Agent
 * backed by Gemini 3 Flash Preview. Returns a fully structured assessment suite
 * with metadata, competencies, problems, and hidden testing matrices.
 *
 * ═══════════════════════════════════════════════════════════════════
 * ARCHITECTURE — Gemini is the SOLE gatekeeper for content filtering.
 *
 *   Every input — from "hello" to "generate a Python test" to keyboard
 *   mashing — flows directly to Gemini's classifyAssessmentIntent.
 *   Gemini determines isInputMeaningful, isAssessmentRelated, domain,
 *   and confidence. This avoids fragile pattern-matching and lets the
 *   LLM apply genuine semantic understanding to every request.
 *
 *   Reference implementation: agentic-reddit-context-guardian
 *   https://github.com/Bilal-Lodhi/agentic-reddit-context-guardian
 * ═══════════════════════════════════════════════════════════════════
 *
 * ═══════════════════════════════════════════════════════════════════
 * ENTERPRISE HARDENING (2026-05-28):
 *   - MCP grounding operations are wrapped in isolated timeout
 *     trackers to prevent a slow MongoDB Atlas connection from
 *     bottlenecking upstream client requests.
 *   - Deep observability telemetry logs at every pipeline milestone.
 *   - JSON parse errors on the request body are caught and returned
 *     as structured 400 responses instead of crashing the event loop.
 * ═══════════════════════════════════════════════════════════════════
 */

import { Hono } from "hono";
import type { GenerateTestSuiteRequest } from "../types.js";
import { GeminiClient } from "../agents/gemini-client.js";
import { loadConfig } from "../config.js";

const generateRouter = new Hono();
const config = loadConfig();
const gemini = new GeminiClient(config);

// ─── In-flight request tracking (for user-initiated cancellation) ──
const ACTIVE_REQUESTS = new Map<string, AbortController>();

// ─── MCP Grounding Constants ──────────────────────────────────────

/** MCP HTTP Adapter base URL (sidecar on port 3001). */
const MCP_BASE = process.env["MCP_URL"] ?? "http://localhost:3001";

/**
 * Maximum time (ms) the route will wait for an MCP grounding operation
 * before aborting and falling back. This prevents a slow MongoDB Atlas
 * connection from holding the upstream client request hostage.
 */
const MCP_GROUNDING_TIMEOUT_MS = 5_000;

// ═══════════════════════════════════════════════════════════════════
// Pipeline Diagnostics — attached to EVERY response so you can
// see exactly what Gemini decided and why.
// ═══════════════════════════════════════════════════════════════════

interface PipelineDiagnostics {
  /** Timestamp when the pipeline started processing */
  startedAt: string;
  /** The raw input after trimming */
  input: string;
  /** ── Gemini Classifier ── */
  geminiClassifier: {
    executed: boolean;
    elapsedMs: number;
    verdict?: {
      isInputMeaningful: boolean;
      isAssessmentRelated: boolean;
      confidence: number;
      detectedDomain: string;
      detectedAssessmentType: string;
      reason: string;
    };
    /** If the classifier call itself failed */
    error?: string;
  };
}

function buildPipelineDiag(
  startedAt: string,
  input: string,
  geminiClassifier: PipelineDiagnostics["geminiClassifier"],
): PipelineDiagnostics {
  return {
    startedAt,
    input,
    geminiClassifier,
  };
}

// ─── POST / ───────────────────────────────────────────────────────

generateRouter.post("/", async (c) => {
  const startedAt = new Date().toISOString();
  const requestId =
    c.res.headers.get("X-Correlation-Id") ?? crypto.randomUUID();
  console.log(
    `[Generate Route] [${requestId}] Incoming POST /api/v1/generate request`,
  );

  // ── Step 1: Parse & Validate Request Body ──────────────────────
  let body: GenerateTestSuiteRequest;
  try {
    body = await c.req.json<GenerateTestSuiteRequest>();
    console.log(
      `[Generate Route] [${requestId}] Body parsed — promptLen=${body.prompt?.length ?? 0} ` +
        `roleContext="${body.roleContext ?? "undefined"}" problemCount=${body.problemCount ?? "default"}`,
    );
  } catch (parseError) {
    console.error(
      `[Generate Route] [${requestId}] JSON parse failure on request body:`,
      parseError,
    );
    return c.json(
      {
        success: false,
        error:
          "Invalid JSON body — request must be valid JSON with 'prompt' and 'roleContext' fields",
        correlationId: requestId,
      },
      400,
    );
  }

  if (
    !body.prompt ||
    typeof body.prompt !== "string" ||
    body.prompt.trim().length === 0
  ) {
    console.warn(
      `[Generate Route] [${requestId}] Validation failed: missing/empty 'prompt'`,
    );
    return c.json(
      {
        success: false,
        error: "Field 'prompt' is required and must be a non-empty string",
      },
      400,
    );
  }

  if (!body.roleContext || typeof body.roleContext !== "string") {
    console.warn(
      `[Generate Route] [${requestId}] Validation failed: missing 'roleContext'`,
    );
    return c.json(
      {
        success: false,
        error: "Field 'roleContext' is required and must be a string",
      },
      400,
    );
  }

  const problemCount = body.problemCount ?? 5;
  if (problemCount < 1 || problemCount > 25) {
    console.warn(
      `[Generate Route] [${requestId}] Validation failed: problemCount=${problemCount} out of range`,
    );
    return c.json(
      {
        success: false,
        error: "Field 'problemCount' must be between 1 and 25",
      },
      400,
    );
  }

  const difficultyMix = body.difficultyMix ?? {
    beginner: 0.33,
    intermediate: 0.34,
    advanced: 0.33,
  };
  const mixSum =
    difficultyMix.beginner + difficultyMix.intermediate + difficultyMix.advanced;
  if (Math.abs(mixSum - 1.0) > 0.05) {
    console.warn(
      `[Generate Route] [${requestId}] Difficulty mix weights sum to ${mixSum.toFixed(3)} ` +
        `(expected ~1.0). Proceeding anyway.`,
    );
  }

  const trimmedPrompt = body.prompt.trim();

  // ── Step 2: Gemini Classifier (SOLE gatekeeper) ────────────────
  // Every input flows through Gemini — it determines meaning, domain,
  // assessment relevance, and confidence. No pattern-matching pre-filter.
  console.log(
    `[Generate Route] [${requestId}] Step 2 — Running Gemini classifyAssessmentIntent...`,
  );

  let classifierDiag: PipelineDiagnostics["geminiClassifier"] = {
    executed: false,
    elapsedMs: 0,
  };

  // ── Register abort controller for cancellation ───────────────
  // Client sends X-Generation-Request-Id header so both sides share
  // the same ID before the request body is streamed, enabling cancel.
  const generationRequestId =
    c.req.header("X-Generation-Request-Id")?.trim() || crypto.randomUUID();
  const abortController = new AbortController();
  ACTIVE_REQUESTS.set(generationRequestId, abortController);
  console.log(
    `[Generate Route] [${requestId}] Registered abort controller — ` +
      `generationRequestId=${generationRequestId}`,
  );

  try {
    const classifierStartMs = Date.now();
    const verdict = await gemini.classifyAssessmentIntent(
      trimmedPrompt,
      body.roleContext,
      abortController.signal,
    );
    const classifierElapsed = Date.now() - classifierStartMs;

    console.log(
      `[Generate Route] [${requestId}] Gemini classifier returned in ${classifierElapsed}ms — ` +
        `isInputMeaningful=${verdict.isInputMeaningful} ` +
        `isAssessmentRelated=${verdict.isAssessmentRelated} ` +
        `confidence=${verdict.confidence.toFixed(2)} ` +
        `detectedDomain="${verdict.detectedDomain}" ` +
        `detectedAssessmentType="${verdict.detectedAssessmentType}" ` +
        `reason="${verdict.reason}"`,
    );

    classifierDiag = {
      executed: true,
      elapsedMs: classifierElapsed,
      verdict: {
        isInputMeaningful: verdict.isInputMeaningful,
        isAssessmentRelated: verdict.isAssessmentRelated,
        confidence: verdict.confidence,
        detectedDomain: verdict.detectedDomain,
        detectedAssessmentType: verdict.detectedAssessmentType,
        reason: verdict.reason,
      },
    };

    // ── Tiered rejection logic ──
    const classifierErrors: string[] = [];

    if (!verdict.isInputMeaningful) {
      classifierErrors.push("isInputMeaningful=false");
    }
    if (
      verdict.isInputMeaningful &&
      !verdict.isAssessmentRelated
    ) {
      classifierErrors.push("isAssessmentRelated=false");
    }
    if (
      verdict.isInputMeaningful &&
      verdict.isAssessmentRelated &&
      verdict.confidence < 0.75
    ) {
      classifierErrors.push(
        `confidence=${verdict.confidence}<0.75`,
      );
    }
    if (
      verdict.isInputMeaningful &&
      verdict.isAssessmentRelated &&
      (!verdict.detectedDomain ||
        verdict.detectedDomain.trim().length < 3)
    ) {
      classifierErrors.push(
        `detectedDomain="${verdict.detectedDomain || "(empty)"}" (too short/generic)`,
      );
    }

    const classificationRejected = classifierErrors.length > 0;

    if (classificationRejected) {
      const geminiReason = verdict.reason || "";
      const tagline =
        "\n\nAbuse Detected: I am a Test Generation and Assessment AI, ask me to generate tests.";
      const reason = geminiReason + tagline;

      console.warn(
        `[Generate Route] [${requestId}] Gemini classifier REJECTED. Errors: [${classifierErrors.join(", ")}]`,
      );

      return c.json(
        {
          success: false,
          error: reason,
          correlationId: requestId,
          classificationConfidence: verdict.confidence,
          detectedDomain: verdict.detectedDomain || null,
          pipeline: buildPipelineDiag(
            startedAt,
            trimmedPrompt,
            classifierDiag,
          ),
        },
        422,
      );
    }

    console.log(
      `[Generate Route] [${requestId}] Gemini classifier ACCEPTED. ` +
        `Domain="${verdict.detectedDomain}" Type="${verdict.detectedAssessmentType}"`,
    );
  } catch (classifierError) {
    const classifierMsg =
      classifierError instanceof Error
        ? classifierError.message
        : "Classifier failure";
    console.error(
      `[Generate Route] [${requestId}] Gemini classifier FAILED: ${classifierMsg}`,
    );

    classifierDiag = {
      executed: true,
      elapsedMs: 0,
      error: classifierMsg,
    };

    console.warn(
      `[Generate Route] [${requestId}] Classifier degraded — proceeding to generation anyway.`,
    );
  }

  const enrichedPrompt = `${body.prompt}\n\n[Difficulty distribution requested: ${JSON.stringify(difficultyMix)}. Target exactly ${problemCount} problems total.]`;
  console.log(
    `[Generate Route] [${requestId}] Prompt enriched — final length=${enrichedPrompt.length} chars`,
  );

  // ── Step 3: Generate Test Suite ────────────────────────────────
  let mcpCorrelationId = crypto.randomUUID();
  let fingerprint = "";

  try {
    console.log(
      `[Generate Route] [${requestId}] Delegating to GeminiClient.generateTestSuite...`,
    );
    const suiteStartMs = Date.now();

    const suite = await gemini.generateTestSuite(
      enrichedPrompt,
      body.roleContext,
      problemCount,
      abortController.signal,
    );

    const suiteElapsed = Date.now() - suiteStartMs;
    console.log(
      `[Generate Route] [${requestId}] GeminiClient returned suite in ${suiteElapsed}ms — ` +
        `${suite.problems.length} problems, ${suite.competencies.length} competencies`,
    );

    fingerprint = await sha256(body.prompt);
    suite.metadata.promptFingerprint = fingerprint;
    console.log(
      `[Generate Route] [${requestId}] SHA-256 fingerprint computed — ${fingerprint.substring(0, 12)}...`,
    );

    await persistSuiteViaMCP(suite, mcpCorrelationId, requestId);

    const response = {
      success: true,
      suite,
      mcpCorrelationId,
      pipeline: buildPipelineDiag(
        startedAt,
        trimmedPrompt,
        classifierDiag,
      ),
    };

    console.log(
      `[Generate Route] [${requestId}] COMPLETE — 201 Created, correlationId=${mcpCorrelationId}`,
    );
    // Extend response with generationRequestId so the client can cancel
    const responseWithCancel = {
      ...response,
      generationRequestId,
    };
    return c.json(responseWithCancel, 201);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown agent error";
    const stack = error instanceof Error ? error.stack : "";
    console.error(
      `[Generate Route] [${requestId}] FAILURE — ${message}`,
      stack,
    );

    // Check if this was a user-initiated cancellation
    const isCancelled = message.includes("cancelled by user");

    if (isCancelled) {
      return c.json(
        {
          success: false,
          error: "Generation cancelled by user. You can resume later.",
          correlationId: requestId,
          cancelled: true,
          pipeline: buildPipelineDiag(
            startedAt,
            trimmedPrompt,
            classifierDiag,
          ),
        },
        200,
      );
    }

    const isGeminiOverloaded =
      message.includes("Gemini request failed after") ||
      message.includes("timed out after") ||
      message.includes("overloaded") ||
      message.includes("Gemini API error 503") ||
      message.includes("Gemini API error 504") ||
      message.includes("Gemini API error 429");

    const statusCode = isGeminiOverloaded ? 503 : 500;
    const userError = isGeminiOverloaded
      ? "Gemini is currently busy. Please retry in a moment."
      : `Test suite generation failed: ${message}`;

    return c.json(
      {
        success: false,
        error: userError,
        correlationId: requestId,
        retryable: isGeminiOverloaded,
        pipeline: buildPipelineDiag(
          startedAt,
          trimmedPrompt,
          classifierDiag,
        ),
      },
      statusCode,
    );
  } finally {
    ACTIVE_REQUESTS.delete(generationRequestId);
    console.log(
      `[Generate Route] [${requestId}] Removed abort controller — generationRequestId=${generationRequestId}`,
    );
  }
});

// ─── POST /cancel ────────────────────────────────────────────────
// Allows the frontend to cancel an in-flight generation request.
// The client receives a generationRequestId field in the streaming
// connection headers, and passes it here to abort the server-side
// Gemini call.

generateRouter.post("/cancel", async (c) => {
  const requestId =
    c.res.headers.get("X-Correlation-Id") ?? crypto.randomUUID();

  let body: { generationRequestId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        success: false,
        error: "Invalid JSON body — request must have a 'generationRequestId' field",
        correlationId: requestId,
      },
      400,
    );
  }

  if (!body.generationRequestId) {
    return c.json(
      {
        success: false,
        error: "Field 'generationRequestId' is required",
        correlationId: requestId,
      },
      400,
    );
  }

  const genRequestId = body.generationRequestId;
  const controller = ACTIVE_REQUESTS.get(genRequestId);

  if (!controller) {
    console.warn(
      `[Generate Route] [${requestId}] Cancel requested for unknown/inactive generation: ${genRequestId}`,
    );
    return c.json(
      {
        success: false,
        error:
          "No active generation found for this request ID. It may have already completed.",
        correlationId: requestId,
      },
      404,
    );
  }

  console.log(
    `[Generate Route] [${requestId}] ABORTING generation ${genRequestId} per user request.`,
  );
  controller.abort();
  ACTIVE_REQUESTS.delete(genRequestId);

  return c.json({
    success: true,
    message: "Generation cancelled. You can resume later.",
    correlationId: requestId,
  });
});

// ─── MCP Persistence Helper ────────────────────────────────────────

async function persistSuiteViaMCP(
  suite: unknown,
  correlationId: string,
  requestId: string,
): Promise<void> {
  console.log(
    `[MCP Grounding] [${requestId}] Syncing tool payloads → correlationId=${correlationId}`,
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.warn(
      `[MCP Grounding] [${requestId}] ABORTING after ${MCP_GROUNDING_TIMEOUT_MS}ms — ` +
        `MCP/MongoDB unresponsive. Suite was already returned to client.`,
    );
    controller.abort();
  }, MCP_GROUNDING_TIMEOUT_MS);

  try {
    const mcpStartMs = Date.now();
    const mcpRes = await fetch(`${MCP_BASE}/tools/store_test_suite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        suite,
        correlationId,
        persistedAt: new Date().toISOString(),
      }),
      signal: controller.signal,
    });
    const mcpElapsed = Date.now() - mcpStartMs;

    if (!mcpRes.ok) {
      const errBody = await mcpRes.text().catch(() => "<unreadable>");
      console.error(
        `[MCP Grounding] [${requestId}] Persist failed — HTTP ${mcpRes.status} ` +
          `after ${mcpElapsed}ms: ${errBody.substring(0, 300)}`,
      );
      return;
    }

    const mcpResult = (await mcpRes.json().catch(() => ({}))) as {
      success?: boolean;
      documentId?: string;
    };

    console.log(
      `[MCP Grounding] [${requestId}] Persist SUCCESS in ${mcpElapsed}ms — ` +
        `documentId=${mcpResult.documentId ?? "unknown"}, success=${mcpResult.success ?? false}`,
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      console.error(
        `[MCP Grounding] [${requestId}] Persist TIMED OUT after ${MCP_GROUNDING_TIMEOUT_MS}ms.`,
      );
    } else {
      console.error(
        `[MCP Grounding] [${requestId}] Persist error:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Utility: SHA-256 fingerprint ──────────────────────────────────

async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export { generateRouter };