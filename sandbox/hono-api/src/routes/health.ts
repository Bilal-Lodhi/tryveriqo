/**
 * Health check and capability discovery endpoint.
 * Provides OpenAPI-aligned metadata for the agent ecosystem.
 */

import { Hono } from "hono";

const healthRouter = new Hono();

healthRouter.get("/", (c) => {
  return c.json({
    status: "healthy",
    service: "gorilla-agent-ecosystem",
    version: "1.0.0",
    platform: "Google Cloud Run",
    modelProvider: "Gemini 3 Flash Preview (Vertex AI / Gemini API)",
    mcpTrack: "MongoDB",
    features: {
      autonomousTestGeneration: "/api/v1/generate",
      intentGuardian: "/api/v1/guardian/ingest",
      analyticalReview: "/api/v1/sessions/:sessionId/review",
    },
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

export { healthRouter };