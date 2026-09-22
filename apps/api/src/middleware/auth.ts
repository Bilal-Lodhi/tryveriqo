/**
 * Authentication and authorisation boundary for the Assessment API.
 *
 * Threat model (see docs/security/threat-model.md):
 *   - Candidate telemetry, review timelines and integrity reports are
 *     candidate-personal data and must not be readable or writable anonymously.
 *   - Assessment generation spends real money against a paid AI provider, so it
 *     must not be reachable without a credential.
 *
 * Two credential kinds exist, and only two:
 *   - operator token  — a high-entropy shared secret from `ASSESSMENT_API_TOKEN`.
 *                       Unlocks assessment generation and all review/report reads.
 *   - candidate token — a short-lived HMAC-signed token minted by
 *                       `POST /api/v1/identity/set`, scoped to one candidateId.
 *
 * Properties: constant-time comparison, no default credential, fail-closed in
 * production (enforced by `loadConfig` before the server binds), explicit
 * development mode, and no secret material in logs or responses.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { AppConfig } from "../config.js";
import { safeStringEquals, verifyCandidateToken } from "./tokens.js";

export type AuthRole = "anonymous" | "candidate" | "operator";

export interface AuthContext {
  role: AuthRole;
  /** The authenticated candidate, when `role === "candidate"`. */
  candidateId: string | null;
  displayName: string | null;
}

export type AppVariables = {
  auth: AuthContext;
  correlationId: string;
};

export type AppEnv = { Variables: AppVariables };

const ANONYMOUS: AuthContext = { role: "anonymous", candidateId: null, displayName: null };

/** Extracts a bearer token from the Authorization header, if present. */
function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/**
 * Resolves the caller's identity without rejecting anonymous callers.
 * Used directly by the identity route, which must accept an unauthenticated
 * registration request while still exposing `/me` to candidates.
 */
export function authenticate(config: AppConfig): MiddlewareHandler<AppEnv> {
  const { apiToken, sessionSecret } = config.auth;

  return async (c, next) => {
    const presented = bearerToken(c.req.header("Authorization"));

    if (!presented) {
      c.set("auth", ANONYMOUS);
      await next();
      return;
    }

    if (apiToken.length > 0 && safeStringEquals(presented, apiToken)) {
      c.set("auth", { role: "operator", candidateId: null, displayName: null });
      await next();
      return;
    }

    if (sessionSecret.length > 0) {
      try {
        const payload = verifyCandidateToken(presented, sessionSecret);
        c.set("auth", {
          role: "candidate",
          candidateId: payload.candidateId,
          displayName: payload.displayName,
        });
        await next();
        return;
      } catch {
        // Fall through to the anonymous branch: an invalid candidate token must
        // not be distinguishable from a missing one at this layer.
      }
    }

    c.set("auth", ANONYMOUS);
    await next();
  };
}

/** Rejects unauthenticated callers. */
export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth || auth.role === "anonymous") {
      return c.json(
        {
          success: false,
          error: "Authentication required. Supply a bearer token in the Authorization header.",
        },
        401,
      );
    }
    await next();
    return;
  };
}

/**
 * Requires the operator (reviewer/console) credential specifically.
 *
 * Anonymous callers receive 401 (authenticate first); authenticated callers
 * holding the wrong credential kind receive 403, so a candidate can tell that
 * their token was accepted but is insufficient.
 */
export function requireOperator(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth || auth.role === "anonymous") {
      return c.json(
        { success: false, error: "Authentication required. Supply the operator bearer token." },
        401,
      );
    }
    if (auth.role !== "operator") {
      return c.json(
        { success: false, error: "This operation requires the operator credential." },
        403,
      );
    }
    await next();
    return;
  };
}

/**
 * Requires that the caller may act on the given candidate's data: either an
 * operator, or the candidate themselves.
 */
export function requireCandidateAccess(
  getCandidateId: (c: Context<AppEnv>) => string | null,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth || auth.role === "anonymous") {
      return c.json({ success: false, error: "Authentication required." }, 401);
    }
    if (auth.role === "operator") {
      await next();
      return;
    }

    const target = getCandidateId(c);
    if (!target || target !== auth.candidateId) {
      return c.json(
        { success: false, error: "Not authorised to access another candidate's assessment data." },
        403,
      );
    }
    await next();
    return;
  };
}

/** Reads the resolved auth context set by `authenticate`. */
export function authOf(c: Context<AppEnv>): AuthContext {
  return c.get("auth") ?? ANONYMOUS;
}

/**
 * Candidate-access guard for routes whose owning candidate is only discoverable
 * asynchronously (the session record lives in the datastore). Resolves the owner
 * once, refuses anonymous callers with 401, and refuses a mismatch with 403.
 */
export function requireCandidateAccessAsync(
  resolveOwner: (c: Context<AppEnv>) => Promise<string | null>,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth || auth.role === "anonymous") {
      return c.json({ success: false, error: "Authentication required." }, 401);
    }
    if (auth.role === "operator") {
      await next();
      return;
    }

    const owner = await resolveOwner(c);
    if (!owner || owner !== auth.candidateId) {
      return c.json(
        { success: false, error: "Not authorised to access another candidate's assessment data." },
        403,
      );
    }
    await next();
    return;
  };
}

/**
 * Reads a candidate id from a request body, checking the common shapes used by
 * telemetry and session payloads. Returns null when absent.
 */
export async function candidateIdFromBody(c: Context<AppEnv>): Promise<string | null> {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const direct = body["candidateId"];
    if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();

    const events = body["events"];
    if (Array.isArray(events) && events.length > 0) {
      const first = events[0] as Record<string, unknown> | undefined;
      const fromEvent = first?.["candidateId"];
      if (typeof fromEvent === "string" && fromEvent.trim().length > 0) return fromEvent.trim();
    }
    return null;
  } catch {
    return null;
  }
}
