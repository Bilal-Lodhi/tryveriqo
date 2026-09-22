/**
 * Lightweight Identity Route — Hackathon Demo
 *
 * Provides ephemeral "identity" without authentication:
 *   POST /api/v1/identity/set   — Register a display name + candidate ID
 *   GET  /api/v1/identity/me    — Retrieve current identity
 *
 * The "session token" is a UUID stored server-side in a simple Map.
 * In production, replace with Firebase Auth or Google Cloud Identity Platform.
 */

import { Hono } from "hono";
import type { IdentityPayload, IdentityResponse } from "../types.js";

// ─── In-memory identity store (per-process, resets on restart) ─────

const identityStore = new Map<string, IdentityPayload>();

// ─── Router ─────────────────────────────────────────────────────────

const identityRouter = new Hono();

/**
 * POST /api/v1/identity/set
 * Body: { displayName: string, candidateId: string, role?: string }
 * Returns an ephemeral session token.
 */
identityRouter.post("/set", async (c) => {
  const body = await c.req.json();

  const displayName = (body["displayName"] as string)?.trim();
  const candidateId = (body["candidateId"] as string)?.trim();

  if (!displayName || displayName.length === 0) {
    return c.json(
      { success: false, error: "displayName is required" },
      400
    );
  }
  if (!candidateId || candidateId.length === 0) {
    return c.json(
      { success: false, error: "candidateId is required" },
      400
    );
  }

  const identity: IdentityPayload = {
    displayName,
    candidateId,
    role: (body["role"] as string | undefined)?.trim() || undefined,
  };

  const sessionToken = crypto.randomUUID();
  identityStore.set(sessionToken, identity);

  const response: IdentityResponse = {
    success: true,
    identity,
    sessionToken,
  };

  console.log(
    `[identity] Registered → "${displayName}" (${candidateId}) token=${sessionToken.slice(0, 8)}...`
  );

  return c.json(response, 201);
});

/**
 * GET /api/v1/identity/me
 * Header: X-Session-Token: <token>
 * Returns the identity payload if the token is valid.
 */
identityRouter.get("/me", (c) => {
  const token = c.req.header("X-Session-Token");

  if (!token) {
    return c.json(
      { success: false, error: "X-Session-Token header is required" },
      401
    );
  }

  const identity = identityStore.get(token);
  if (!identity) {
    return c.json(
      { success: false, error: "Invalid or expired session token" },
      401
    );
  }

  return c.json({
    success: true,
    identity,
  });
});

export { identityRouter };