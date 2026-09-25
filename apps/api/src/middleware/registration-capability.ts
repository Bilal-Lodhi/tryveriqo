/**
 * Candidate registration capabilities.
 *
 * `POST /api/v1/identity/set` mints a candidate-scoped token. Before this
 * module existed it accepted any `candidateId` from any caller, so a caller who
 * knew a candidate id could obtain a token for that candidate and read their
 * own submitted code and integrity report history. That is an authorization
 * boundary, not a cosmetic limitation.
 *
 * A registration capability is the smallest thing that closes it: a
 * high-entropy, short-lived, HMAC-signed grant, minted by the **operator**
 * credential, bound to one `candidateId` and (when the operator supplies one)
 * one `assessmentId`. Registration refuses to issue a candidate token without
 * one, so knowing a candidate id is no longer sufficient — the caller must also
 * hold a grant the operator created for exactly that candidate.
 *
 * What this is: proof that the operator authorised this candidate id, presented
 * by whoever holds the capability. What it is **not**: verified human identity,
 * KYC, biometrics, or proof that the presenter is the person the id names. It
 * proves possession of an operator-issued grant and nothing more, and the
 * documentation says so.
 *
 * Design properties:
 *   - **Stateless.** Signed, not stored, so registration does not depend on the
 *     datastore being reachable and a restart cannot invalidate a live grant.
 *   - **Domain-separated key.** The signing key is derived from
 *     `ASSESSMENT_SESSION_SECRET` with a label, so no new production secret is
 *     required and a capability signature can never be replayed as a candidate
 *     token (or the reverse).
 *   - **Not one-time.** Statelessness and one-time use are mutually exclusive
 *     without a consumed-capability store, and making registration depend on
 *     the datastore would be a reliability regression. The window is bounded by
 *     a short TTL instead, and the documentation states this plainly rather
 *     than implying replay protection that does not exist.
 *   - **Not logged.** Callers must never put a capability in a log line.
 *
 * Format:  rv1.<base64url(payload)>.<base64url(signature)>
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const REGISTRATION_CAPABILITY_VERSION = "rv1";

/**
 * Domain-separation label. Deriving the capability key from the session secret
 * keeps the deployment surface unchanged (no extra required secret) while
 * ensuring the two token families are cryptographically independent: a
 * capability signature is not a valid candidate-token signature and vice versa.
 */
const KEY_DERIVATION_LABEL = "tryveriqo:registration-capability:v1";

/** Bounds on a capability's lifetime, enforced on both issue and verify. */
export const MIN_CAPABILITY_TTL_SECONDS = 30;
export const MAX_CAPABILITY_TTL_SECONDS = 24 * 60 * 60;

/**
 * A capability is a credential, not user input. Anything longer than this is
 * rejected before any signature work is attempted.
 */
export const MAX_CAPABILITY_LENGTH = 4096;

export interface RegistrationCapabilityPayload {
  /** Always "registration"; reserved so a candidate token can never be used here. */
  kind: "registration";
  candidateId: string;
  /** When set, registration must present the same assessmentId. */
  assessmentId: string | null;
  issuedAt: number;
  expiresAt: number;
  /** Unique capability id, for operator-side correlation. Never a secret. */
  capabilityId: string;
}

/** Raised for any malformed, expired or mismatched capability. */
export class RegistrationCapabilityError extends Error {}

function deriveKey(sessionSecret: string): Buffer {
  return createHmac("sha256", sessionSecret).update(KEY_DERIVATION_LABEL).digest();
}

function sign(payloadSegment: string, sessionSecret: string): string {
  return createHmac("sha256", deriveKey(sessionSecret)).update(payloadSegment).digest("base64url");
}

/** Constant-time comparison of two strings (length differences fail fast). */
function safeStringEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface IssueRegistrationCapabilityOptions {
  sessionSecret: string;
  candidateId: string;
  assessmentId?: string | null;
  ttlSeconds: number;
  /** Injected clock, so expiry is testable without sleeping. */
  now?: number;
}

export interface IssuedRegistrationCapability {
  capability: string;
  capabilityId: string;
  expiresAt: string;
}

export function issueRegistrationCapability(
  options: IssueRegistrationCapabilityOptions,
): IssuedRegistrationCapability {
  const { sessionSecret, candidateId, ttlSeconds } = options;

  if (sessionSecret.length === 0) {
    throw new RegistrationCapabilityError(
      "Cannot issue a registration capability without a session secret.",
    );
  }
  if (candidateId.trim().length === 0) {
    throw new RegistrationCapabilityError("candidateId is required to issue a registration capability.");
  }
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < MIN_CAPABILITY_TTL_SECONDS) {
    throw new RegistrationCapabilityError(
      `A registration capability must live at least ${MIN_CAPABILITY_TTL_SECONDS} seconds.`,
    );
  }
  if (ttlSeconds > MAX_CAPABILITY_TTL_SECONDS) {
    throw new RegistrationCapabilityError(
      `A registration capability may live at most ${MAX_CAPABILITY_TTL_SECONDS} seconds.`,
    );
  }

  const issuedAt = options.now ?? Date.now();
  const assessmentId =
    typeof options.assessmentId === "string" && options.assessmentId.trim().length > 0
      ? options.assessmentId.trim()
      : null;

  const payload: RegistrationCapabilityPayload = {
    kind: "registration",
    candidateId,
    assessmentId,
    issuedAt,
    expiresAt: issuedAt + ttlSeconds * 1000,
    capabilityId: randomUUID(),
  };

  const payloadSegment = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    capability: `${REGISTRATION_CAPABILITY_VERSION}.${payloadSegment}.${sign(payloadSegment, sessionSecret)}`,
    capabilityId: payload.capabilityId,
    expiresAt: new Date(payload.expiresAt).toISOString(),
  };
}

export interface VerifyRegistrationCapabilityOptions {
  /** The candidate the caller is asking to register as. */
  candidateId: string;
  /** The assessment the caller presented, if any. */
  assessmentId?: string | null;
  /** Injected clock, so expiry is testable without sleeping. */
  now?: number;
}

/**
 * Verifies a registration capability against the candidate and assessment the
 * caller is trying to register.
 *
 * Throws `RegistrationCapabilityError` for a malformed capability, a bad
 * signature, an expired capability, a payload of the wrong kind, or a candidate
 * or assessment mismatch. Every failure raises the same error type; the route
 * collapses them into one response so the endpoint is not an oracle for which
 * check failed — or for whether a candidate id exists at all.
 */
export function verifyRegistrationCapability(
  capability: string,
  sessionSecret: string,
  options: VerifyRegistrationCapabilityOptions,
): RegistrationCapabilityPayload {
  if (sessionSecret.length === 0) {
    throw new RegistrationCapabilityError("No session secret configured.");
  }
  if (typeof capability !== "string" || capability.length === 0) {
    throw new RegistrationCapabilityError("A registration capability is required.");
  }
  if (capability.length > MAX_CAPABILITY_LENGTH) {
    throw new RegistrationCapabilityError("Registration capability is too long.");
  }

  const parts = capability.split(".");
  if (parts.length !== 3 || parts[0] !== REGISTRATION_CAPABILITY_VERSION) {
    throw new RegistrationCapabilityError("Malformed registration capability.");
  }

  const [, payloadSegment, signatureSegment] = parts as [string, string, string];
  const expectedSignature = sign(payloadSegment, sessionSecret);
  if (!safeStringEquals(signatureSegment, expectedSignature)) {
    throw new RegistrationCapabilityError("Registration capability signature is invalid.");
  }

  let payload: RegistrationCapabilityPayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadSegment, "base64url").toString("utf8"),
    ) as RegistrationCapabilityPayload;
  } catch {
    throw new RegistrationCapabilityError("Registration capability payload is not valid JSON.");
  }

  if (
    payload === null ||
    typeof payload !== "object" ||
    payload.kind !== "registration" ||
    typeof payload.candidateId !== "string" ||
    payload.candidateId.length === 0
  ) {
    throw new RegistrationCapabilityError("Registration capability payload has an unexpected shape.");
  }

  const now = options.now ?? Date.now();
  if (typeof payload.expiresAt !== "number" || !Number.isFinite(payload.expiresAt)) {
    throw new RegistrationCapabilityError("Registration capability has no usable expiry.");
  }
  if (payload.expiresAt <= now) {
    throw new RegistrationCapabilityError("Registration capability has expired.");
  }

  if (payload.candidateId !== options.candidateId) {
    throw new RegistrationCapabilityError("Registration capability is for a different candidate.");
  }

  if (payload.assessmentId !== null && payload.assessmentId !== undefined) {
    const presented = typeof options.assessmentId === "string" ? options.assessmentId.trim() : "";
    if (presented.length === 0) {
      throw new RegistrationCapabilityError(
        "Registration capability is bound to an assessment that was not presented.",
      );
    }
    if (payload.assessmentId !== presented) {
      throw new RegistrationCapabilityError("Registration capability is for a different assessment.");
    }
  }

  return payload;
}
