/**
 * Candidate identity.
 *
 *   POST /api/v1/identity/capability — operator mints a registration capability
 *   POST /api/v1/identity/set        — register a candidate, receive a session token
 *   GET  /api/v1/identity/me         — resolve the caller's identity from that token
 *
 * Registration is the only unauthenticated write in the API: a candidate must be
 * able to identify themselves before anything else happens. It mints a
 * short-lived, HMAC-signed, candidate-scoped token. No password, account,
 * organisation or billing concept exists.
 *
 * What changed and why: registration used to accept any `candidateId` from any
 * caller, so knowing a candidate id was enough to obtain a token for it — and
 * therefore to read that candidate's own submitted code and integrity report
 * history. Registration now requires an operator-issued **registration
 * capability** bound to the candidate id (and, when the operator supplies one,
 * to an assessment). Knowing a candidate id is no longer sufficient.
 *
 * A capability proves that the operator authorised this candidate id. It is not
 * verified human identity, and it does not prove the presenter is the person the
 * id names.
 */

import { Hono } from "hono";
import type { IdentityPayload, IdentityResponse } from "../types.js";
import { issueCandidateToken, MIN_SESSION_SECRET_LENGTH } from "../middleware/tokens.js";
import {
  MAX_CAPABILITY_LENGTH,
  RegistrationCapabilityError,
  issueRegistrationCapability,
  verifyRegistrationCapability,
} from "../middleware/registration-capability.js";
import { authOf, requireAuth, requireOperator, type AppEnv } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { nowIso } from "../utils/time.js";
import type { ApiDependencies } from "./dependencies.js";

const MAX_FIELD_LENGTH = 200;

/**
 * One response for every capability failure — missing, malformed, wrong
 * signature, expired, wrong candidate, wrong assessment. Distinguishing them
 * would tell an unauthenticated caller which check failed, and whether a
 * candidate id exists at all.
 */
const CAPABILITY_REFUSED =
  "A valid registration capability is required to register this candidate. " +
  "Ask the assessment operator for one.";

function readRequiredString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_FIELD_LENGTH) return null;
  return trimmed;
}

function readOptionalString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_FIELD_LENGTH) return null;
  return trimmed;
}

async function readJsonObject(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await c.req.json()) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function identityRoutes(deps: ApiDependencies): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const { config, log } = deps;

  // ── POST /capability ───────────────────────────────────────────
  // Operator-only. A capability is a credential: it is returned to the operator
  // and never logged.
  router.post(
    "/capability",
    // Authentication first: an unauthenticated caller must not be able to spend
    // the operator's rate budget.
    requireOperator(),
    rateLimit({ windowMs: 60_000, max: 60, name: "registration capability issuance" }),
    async (c) => {
      const requestId = c.get("correlationId") ?? crypto.randomUUID();

      const body = await readJsonObject(c);
      if (!body) {
        return c.json({ success: false, error: "Request body must be a JSON object." }, 400);
      }

      const candidateId = readRequiredString(body, "candidateId");
      if (!candidateId) {
        return c.json(
          { success: false, error: "Field 'candidateId' is required and must be 1-200 characters." },
          400,
        );
      }

      const rawAssessmentId = body["assessmentId"];
      if (rawAssessmentId !== undefined && rawAssessmentId !== null && typeof rawAssessmentId !== "string") {
        return c.json({ success: false, error: "Field 'assessmentId' must be a string." }, 400);
      }
      const assessmentId = readOptionalString(body, "assessmentId");
      if (typeof rawAssessmentId === "string" && rawAssessmentId.trim().length > 0 && !assessmentId) {
        return c.json(
          { success: false, error: "Field 'assessmentId' must be 1-200 characters." },
          400,
        );
      }

      if (config.auth.sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
        log("[identity] Refusing to issue a registration capability: session secret is too short.");
        return c.json(
          { success: false, error: "Registration capabilities are not configured on this server." },
          503,
        );
      }

      const rawTtl = body["ttlSeconds"];
      const ttlSeconds =
        typeof rawTtl === "number" && Number.isFinite(rawTtl)
          ? rawTtl
          : config.auth.registrationCapabilityTtlSeconds;

      let issued;
      try {
        issued = issueRegistrationCapability({
          sessionSecret: config.auth.sessionSecret,
          candidateId,
          assessmentId,
          ttlSeconds,
        });
      } catch (error) {
        const message =
          error instanceof RegistrationCapabilityError
            ? error.message
            : "The registration capability could not be issued.";
        return c.json({ success: false, error: message }, 400);
      }

      // The capability value is deliberately absent from this log line.
      log(
        `[identity] [${requestId}] Registration capability ${issued.capabilityId} issued for ` +
          `candidateId="${candidateId}"` +
          `${assessmentId ? ` assessmentId="${assessmentId}"` : ""} expiresAt=${issued.expiresAt}`,
      );

      return c.json(
        {
          success: true,
          capability: issued.capability,
          capabilityId: issued.capabilityId,
          candidateId,
          assessmentId: assessmentId ?? null,
          expiresAt: issued.expiresAt,
        },
        201,
      );
    },
  );

  // ── POST /set ──────────────────────────────────────────────────
  router.post("/set", async (c) => {
    const requestId = c.get("correlationId") ?? crypto.randomUUID();

    const body = await readJsonObject(c);
    if (!body) {
      return c.json({ success: false, error: "Request body must be a JSON object." }, 400);
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

    const assessmentId = readOptionalString(body, "assessmentId");

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

    if (config.auth.registrationMode === "capability") {
      const rawCapability = body["registrationCapability"];

      // A capability is a credential, not user input: bound before any
      // signature work so an oversized value cannot be used as cheap work.
      if (typeof rawCapability !== "string" || rawCapability.length > MAX_CAPABILITY_LENGTH) {
        log(
          `[identity] [${requestId}] Registration refused for candidateId="${candidateId}": ` +
            `${typeof rawCapability === "string" ? "capability too long" : "no capability presented"}.`,
        );
        return c.json({ success: false, error: CAPABILITY_REFUSED }, 403);
      }

      try {
        verifyRegistrationCapability(rawCapability, config.auth.sessionSecret, {
          candidateId,
          assessmentId,
        });
      } catch (error) {
        // Log the failure class for operators; never the capability value.
        log(
          `[identity] [${requestId}] Registration refused for candidateId="${candidateId}": ` +
            `${error instanceof RegistrationCapabilityError ? error.message : "capability rejected"}`,
        );
        return c.json({ success: false, error: CAPABILITY_REFUSED }, 403);
      }
    } else {
      // Development-only path, refused outright in production by loadConfig().
      log(
        `[identity] [${requestId}] Registering candidateId="${candidateId}" without a capability ` +
          "because CANDIDATE_REGISTRATION_MODE=open. This mode is not permitted in production.",
      );
    }

    const identity: IdentityPayload = { displayName, candidateId, ...(role ? { role } : {}) };
    const issued = issueCandidateToken({
      secret: config.auth.sessionSecret,
      candidateId,
      displayName,
      ttlSeconds: config.auth.candidateTokenTtlSeconds,
    });

    log(`[identity] [${requestId}] Candidate session issued for candidateId="${candidateId}"`);

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
