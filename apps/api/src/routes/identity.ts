/**
 * Candidate identity.
 *
 *   POST /api/v1/identity/set — register a candidate and receive a session token
 *   GET  /api/v1/identity/me  — resolve the caller's identity from that token
 *
 * Registration is intentionally the only unauthenticated write in the API: a
 * candidate must be able to identify themselves before anything else happens.
 * It mints a short-lived, HMAC-signed, candidate-scoped token. No password,
 * account, organisation or billing concept exists.
 */

import { Hono } from "hono";
import type { IdentityPayload, IdentityResponse } from "../types.js";
import { issueCandidateToken, MIN_SESSION_SECRET_LENGTH } from "../middleware/tokens.js";
import { authOf, requireAuth, type AppEnv } from "../middleware/auth.js";
import { nowIso } from "../utils/time.js";
import type { ApiDependencies } from "./dependencies.js";

const MAX_FIELD_LENGTH = 200;

function readRequiredString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_FIELD_LENGTH) return null;
  return trimmed;
}

export function identityRoutes(deps: ApiDependencies): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const { config, log } = deps;

  router.post("/set", async (c) => {
    let body: Record<string, unknown>;
    try {
      const parsed = (await c.req.json()) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return c.json({ success: false, error: "Request body must be a JSON object." }, 400);
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return c.json({ success: false, error: "Request body must be valid JSON." }, 400);
    }

    const displayName = readRequiredString(body, "displayName");
    if (!displayName) {
      return c.json(
        { success: false, error: "Field 'displayName' is required and must be 1-200 characters." },
        400,
      );
    }

    const candidateId = readRequiredString(body, "candidateId");
    if (!candidateId) {
      return c.json(
        { success: false, error: "Field 'candidateId' is required and must be 1-200 characters." },
        400,
      );
    }

    const rawRole = body["role"];
    const role = typeof rawRole === "string" && rawRole.trim().length > 0
      ? rawRole.trim().slice(0, MAX_FIELD_LENGTH)
      : undefined;

    if (config.auth.sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
      // Fail closed rather than mint an unsignable or guessable token. In
      // production the server would not have started at all.
      log("[identity] Refusing to issue a session token: ASSESSMENT_SESSION_SECRET is too short.");
      return c.json(
        {
          success: false,
          error: "Session tokens are not configured on this server.",
        },
        503,
      );
    }

    const identity: IdentityPayload = { displayName, candidateId, ...(role ? { role } : {}) };
    const issued = issueCandidateToken({
      secret: config.auth.sessionSecret,
      candidateId,
      displayName,
      ttlSeconds: config.auth.candidateTokenTtlSeconds,
    });

    log(`[identity] Candidate session issued for candidateId="${candidateId}"`);

    const response: IdentityResponse = {
      success: true,
      identity,
      sessionToken: issued.token,
      expiresAt: issued.expiresAt,
    };
    return c.json(response, 201);
  });

  router.get("/me", requireAuth(), (c) => {
    const auth = authOf(c);
    if (auth.role === "operator") {
      return c.json({
        success: true,
        role: "operator",
        identity: null,
        serverTime: nowIso(),
      });
    }
    return c.json({
      success: true,
      role: "candidate",
      identity: {
        displayName: auth.displayName ?? "",
        candidateId: auth.candidateId ?? "",
      } satisfies IdentityPayload,
      serverTime: nowIso(),
    });
  });

  return router;
}
