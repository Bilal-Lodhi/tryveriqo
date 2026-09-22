/**
 * Route: POST /api/v1/generate
 * Assessment generation — turns one description into a complete test suite.
 *
 * Pipeline:
 *   1. structural validation of the request body
 *   2. deterministic content pre-filter (empty / greeting / gibberish / abuse)
 *   3. AI intent classification — the semantic gatekeeper
 *   4. assembly of the structured GeneratedTestSuite
 *   5. persistence through the MCP tool surface
 *
 * Requires the operator credential: this endpoint spends money against a paid
 * model, so it is never reachable anonymously.
 *
 * In-flight generations can be cancelled through POST /api/v1/generate/cancel.
 */

import { Hono } from "hono";
import type { GeneratedTestSuite } from "../types.js";
import { ProviderNotConfiguredError, ProviderRequestError } from "../agents/gemini-client.js";
import { persistTestSuite } from "../mcp-client.js";
import { requireOperator, type AppEnv } from "../middleware/auth.js";
import { nowIso } from "../utils/time.js";
import {
  difficultyMixDeviation,
  runContentPreFilter,
  validateGenerateRequest,
  type PreFilterFlag,
} from "../assessment-input.js";
import type { ApiDependencies } from "./dependencies.js";

/** Client-supplied generation id used to cancel an in-flight request. */
const ACTIVE_GENERATIONS = new Map<string, AbortController>();
/** Cancellation by Hono request id, so a client can cancel before it has an id. */
const GENERATION_BY_REQUEST = new Map<string, string>();

export function generateRoutes(deps: ApiDependencies): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const { ai, mcp, log } = deps;

  router.post("/", requireOperator(), async (c) => {
    const requestId = c.get("correlationId") ?? crypto.randomUUID();

    // ── 1. Validate the request body ─────────────────────────────
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(
        { success: false, error: "Request body must be valid JSON.", correlationId: requestId },
        400,
      );
    }

    const validation = validateGenerateRequest(raw);
    if (!validation.ok) {
      return c.json({ success: false, error: validation.error, correlationId: requestId }, 400);
    }

    const { prompt, roleContext, problemCount, difficultyMix } = validation.value;

    const deviation = difficultyMixDeviation(difficultyMix);
    if (deviation > 0.05) {
      log(
        `[generate] [${requestId}] difficultyMix weights deviate by ${deviation.toFixed(3)} from 1.0; proceeding.`,
      );
    }

    // ── 2. Deterministic pre-filter ──────────────────────────────
    const preFilter = runContentPreFilter(prompt);
    if (!preFilter.passed) {
      log(`[generate] [${requestId}] Pre-filter rejected input: ${preFilter.flags.join(",")}`);
      return c.json(
        {
          success: false,
          error: preFilter.reason,
          correlationId: requestId,
          preFilterFlags: preFilter.flags satisfies PreFilterFlag[],
        },
        422,
      );
    }

    // ── 3. AI intent classification ──────────────────────────────
    const generationRequestId =
      c.req.header("X-Generation-Request-Id")?.trim() || crypto.randomUUID();
    const controller = new AbortController();
    ACTIVE_GENERATIONS.set(generationRequestId, controller);
    GENERATION_BY_REQUEST.set(requestId, generationRequestId);

    try {
      let classifierExecuted = false;
      let classifierDegraded = false;

      try {
        const verdict = await ai.classifyAssessmentIntent(prompt, roleContext, controller.signal);
        classifierExecuted = true;

        const problems: string[] = [];
        if (!verdict.isAppropriate) {
          problems.push(`content not appropriate${verdict.contentFlags.length > 0 ? ` (${verdict.contentFlags.join(", ")})` : ""}`);
        }
        if (!verdict.isInputMeaningful) problems.push("input is not meaningful");
        if (verdict.isInputMeaningful && !verdict.isAssessmentRelated) {
          problems.push("request is not about generating an assessment");
        }
        if (verdict.isInputMeaningful && verdict.isAssessmentRelated && verdict.confidence < 0.75) {
          problems.push(`classifier confidence ${verdict.confidence.toFixed(2)} is below 0.75`);
        }
        if (
          verdict.isInputMeaningful &&
          verdict.isAssessmentRelated &&
          verdict.detectedDomain.trim().length < 3
        ) {
          problems.push("no usable subject domain was detected");
        }

        if (problems.length > 0) {
          log(`[generate] [${requestId}] Classifier rejected: ${problems.join("; ")}`);
          return c.json(
            {
              success: false,
              error: `This is not a usable assessment request: ${problems.join("; ")}.`,
              correlationId: requestId,
              classifier: {
                confidence: verdict.confidence,
                detectedDomain: verdict.detectedDomain || null,
                detectedAssessmentType: verdict.detectedAssessmentType || null,
                reason: verdict.reason,
              },
            },
            422,
          );
        }
      } catch (error) {
        if (error instanceof ProviderRequestError && error.message.includes("cancelled")) {
          throw error;
        }
        // A classifier outage must not block generation: the semantic check is
        // a guard rail, not a hard dependency.
        classifierDegraded = true;
        log(
          `[generate] [${requestId}] Classifier unavailable (${
            error instanceof Error ? error.message : String(error)
          }); continuing to generation.`,
        );
      }

      // ── 4. Generate the suite ──────────────────────────────────
      const enrichedPrompt = [
        prompt,
        `[Requested difficulty distribution: ${JSON.stringify(difficultyMix)}.`,
        `Target exactly ${problemCount} problems.]`,
      ].join(" ");

      const suite = await ai.generateTestSuite(
        enrichedPrompt,
        roleContext,
        problemCount,
        controller.signal,
      );

      suite.metadata.promptFingerprint = await sha256(prompt);
      if (!suite.metadata.generatedAt) suite.metadata.generatedAt = nowIso();

      // ── 5. Persist ─────────────────────────────────────────────
      const mcpCorrelationId = crypto.randomUUID();
      const persisted = await persistTestSuite(mcp, suite);
      if (!persisted.ok) {
        log(
          `[generate] [${requestId}] Persistence warning: ${persisted.error ?? "unknown error"}. ` +
            "The suite was still returned to the caller.",
        );
      }

      log(
        `[generate] [${requestId}] Complete — ${suite.problems.length} problems, ` +
          `persisted=${persisted.ok}`,
      );

      return c.json(
        {
          success: true,
          suite,
          mcpCorrelationId,
          generationRequestId,
          persisted: persisted.ok,
          classifier: { executed: classifierExecuted, degraded: classifierDegraded },
        },
        201,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown generation error";

      if (message.includes("cancelled")) {
        return c.json(
          {
            success: false,
            error: "Generation cancelled at the client's request.",
            correlationId: requestId,
            cancelled: true,
          },
          200,
        );
      }

      if (error instanceof ProviderNotConfiguredError) {
        log(`[generate] [${requestId}] Provider not configured.`);
        return c.json(
          {
            success: false,
            error: "The assessment AI provider is not configured on this server.",
            correlationId: requestId,
          },
          503,
        );
      }

      const retryable = error instanceof ProviderRequestError ? error.retryable : false;
      log(`[generate] [${requestId}] Failure: ${message}`);
      return c.json(
        {
          success: false,
          error: retryable
            ? "The assessment provider is temporarily unavailable. Retry shortly."
            : "Assessment generation failed.",
          correlationId: requestId,
          retryable,
        },
        retryable ? 503 : 500,
      );
    } finally {
      ACTIVE_GENERATIONS.delete(generationRequestId);
      GENERATION_BY_REQUEST.delete(requestId);
    }
  });

  // ── Cancel an in-flight generation ────────────────────────────
  router.post("/cancel", requireOperator(), async (c) => {
    const requestId = c.get("correlationId") ?? crypto.randomUUID();

    let body: Record<string, unknown>;
    try {
      const parsed = (await c.req.json()) as unknown;
      body = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return c.json(
        { success: false, error: "Request body must be valid JSON.", correlationId: requestId },
        400,
      );
    }

    const generationRequestId = body["generationRequestId"];
    if (typeof generationRequestId !== "string" || generationRequestId.trim().length === 0) {
      return c.json(
        { success: false, error: "Field 'generationRequestId' is required.", correlationId: requestId },
        400,
      );
    }

    const controller = ACTIVE_GENERATIONS.get(generationRequestId);
    if (!controller) {
      return c.json(
        {
          success: false,
          error: "No in-flight generation matches that request id. It may already have finished.",
          correlationId: requestId,
        },
        404,
      );
    }

    controller.abort();
    ACTIVE_GENERATIONS.delete(generationRequestId);
    log(`[generate] [${requestId}] Aborted in-flight generation ${generationRequestId}`);
    return c.json({ success: true, message: "Generation cancelled.", correlationId: requestId });
  });

  return router;
}

async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export type { GeneratedTestSuite };
