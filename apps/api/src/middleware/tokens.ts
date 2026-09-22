/**
 * Candidate session tokens.
 *
 * Candidate tokens are stateless: an HMAC-SHA256 signature over a compact
 * JSON payload, so a restarted or horizontally scaled API can still validate a
 * token that a different process issued. They are deliberately narrow — a
 * candidate token can only act on its own `candidateId`.
 *
 * Format:  v1.<base64url(payload)>.<base64url(signature)>
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const CANDIDATE_TOKEN_VERSION = "v1";

/** Minimum secret length accepted outside development. */
export const MIN_SESSION_SECRET_LENGTH = 32;

export interface CandidateTokenPayload {
  /** Always "candidate"; reserved so operator tokens can never be minted here. */
  kind: "candidate";
  candidateId: string;
  displayName: string;
  issuedAt: number;
  expiresAt: number;
  /** Unique token id, useful for audit correlation. */
  tokenId: string;
}

export class TokenError extends Error {}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payloadSegment: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadSegment).digest("base64url");
}

/** Constant-time comparison of two strings (length differences fail fast). */
export function safeStringEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface IssueCandidateTokenOptions {
  secret: string;
  candidateId: string;
  displayName: string;
  ttlSeconds: number;
}

export interface IssuedCandidateToken {
  token: string;
  expiresAt: string;
}

export function issueCandidateToken(options: IssueCandidateTokenOptions): IssuedCandidateToken {
  const { secret, candidateId, displayName, ttlSeconds } = options;

  if (secret.length === 0) {
    throw new TokenError("Cannot issue a candidate token without a session secret.");
  }
  if (candidateId.trim().length === 0) {
    throw new TokenError("candidateId is required to issue a candidate token.");
  }

  const issuedAt = Date.now();
  // A non-positive TTL means "already expired": the token is still well-formed
  // and correctly signed, but unusable. Callers use this for expiry tests.
  const expiresAt = ttlSeconds > 0 ? issuedAt + ttlSeconds * 1000 : issuedAt - 1;

  const payload: CandidateTokenPayload = {
    kind: "candidate",
    candidateId,
    displayName,
    issuedAt,
    expiresAt,
    tokenId: randomUUID(),
  };

  const payloadSegment = base64url(JSON.stringify(payload));
  return {
    token: `${CANDIDATE_TOKEN_VERSION}.${payloadSegment}.${sign(payloadSegment, secret)}`,
    expiresAt: new Date(payload.expiresAt).toISOString(),
  };
}

/**
 * Verifies a candidate token. Throws `TokenError` for a malformed token, a
 * bad signature, an expired token, or a payload that is not a candidate token.
 */
export function verifyCandidateToken(token: string, secret: string): CandidateTokenPayload {
  if (secret.length === 0) {
    throw new TokenError("No session secret configured.");
  }

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== CANDIDATE_TOKEN_VERSION) {
    throw new TokenError("Malformed session token.");
  }

  const [, payloadSegment, signatureSegment] = parts as [string, string, string];
  const expected = sign(payloadSegment, secret);
  if (!safeStringEquals(signatureSegment, expected)) {
    throw new TokenError("Session token signature is invalid.");
  }

  let payload: CandidateTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as CandidateTokenPayload;
  } catch {
    throw new TokenError("Session token payload is not valid JSON.");
  }

  if (payload.kind !== "candidate" || typeof payload.candidateId !== "string") {
    throw new TokenError("Session token payload has an unexpected shape.");
  }
  if (typeof payload.expiresAt !== "number" || payload.expiresAt <= Date.now()) {
    throw new TokenError("Session token has expired.");
  }

  return payload;
}
