/**
 * Candidate integrity routes (reviewer console).
 *
 *   GET /api/v1/candidates/:candidateId/reports — latest integrity report per session
 *
 * Exposes candidate-personal data and is limited to the operator credential.
 */

import { Hono } from "hono";
import { requireOperator, type AppEnv } from "../middleware/auth.js";
import { fetchCandidateReport } from "../mcp-client.js";
import type { ApiDependencies } from "./dependencies.js";

export function candidateRoutes(deps: ApiDependencies): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const { mcp, log } = deps;

  router.get("/:candidateId/reports", requireOperator(), async (c) => {
    const candidateId = c.req.param("candidateId");
    const requestId = c.get("correlationId") ?? crypto.randomUUID();

    const result = await fetchCandidateReport(mcp, candidateId);
    if (!result.ok) {
      log(`[candidates] [${requestId}] Report lookup failed: ${result.error ?? "unknown"}`);
      return c.json({ success: false, error: "The assessment store is unavailable." }, 502);
    }

    return c.json({
      success: true,
      candidateId,
      reports: result.data?.reports ?? [],
    });
  });

  return router;
}
