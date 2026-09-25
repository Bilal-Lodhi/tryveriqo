/**
 * Registration capability tests.
 *
 * The capability is the authorization boundary that stops a caller who merely
 * knows a candidate id from obtaining a token for it, so these tests cover the
 * cryptographic envelope, the bindings, and the failure modes that must all be
 * indistinguishable to an unauthenticated caller.
 *
 * All expiry checks use an injected clock. Nothing here sleeps.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  MAX_CAPABILITY_LENGTH,
  MAX_CAPABILITY_TTL_SECONDS,
  MIN_CAPABILITY_TTL_SECONDS,
  REGISTRATION_CAPABILITY_VERSION,
  RegistrationCapabilityError,
  issueRegistrationCapability,
  verifyRegistrationCapability,
} from "../src/middleware/registration-capability.js";
import { issueCandidateToken } from "../src/middleware/tokens.js";

const SECRET = "test-session-secret-0123456789abcdefghij";
const OTHER_SECRET = "another-session-secret-0123456789abcdefg";
const AT = Date.UTC(2026, 0, 1, 12, 0, 0);
const TTL = 900;

function issue(overrides: Partial<Parameters<typeof issueRegistrationCapability>[0]> = {}) {
  return issueRegistrationCapability({
    sessionSecret: SECRET,
    candidateId: "candidate-1",
    ttlSeconds: TTL,
    now: AT,
    ...overrides,
  });
}

function verify(
  capability: string,
  overrides: Partial<Parameters<typeof verifyRegistrationCapability>[2]> = {},
) {
  return verifyRegistrationCapability(capability, SECRET, {
    candidateId: "candidate-1",
    now: AT + 1000,
    ...overrides,
  });
}

describe("registration capability envelope", () => {
  test("a capability is a three-part versioned token", () => {
    const { capability } = issue();
    const parts = capability.split(".");
    assert.equal(parts.length, 3);
    assert.equal(parts[0], REGISTRATION_CAPABILITY_VERSION);
  });

  test("the capability id is returned for operator correlation", () => {
    const issued = issue();
    assert.ok(issued.capabilityId.length > 0);
    assert.ok(new Date(issued.expiresAt).getTime() > AT);
  });

  test("two capabilities for the same candidate differ", () => {
    assert.notEqual(issue().capability, issue().capability);
  });

  test("the capability does not carry the signing secret", () => {
    const { capability } = issue();
    const payload = Buffer.from(capability.split(".")[1] as string, "base64url").toString("utf8");
    assert.equal(payload.includes(SECRET), false);
  });

  test("the payload declares the registration kind and its bindings", () => {
    const { capability } = issue({ candidateId: "candidate-7", assessmentId: "assessment-9" });
    const payload = JSON.parse(
      Buffer.from(capability.split(".")[1] as string, "base64url").toString("utf8"),
    ) as Record<string, unknown>;

    assert.equal(payload["kind"], "registration");
    assert.equal(payload["candidateId"], "candidate-7");
    assert.equal(payload["assessmentId"], "assessment-9");
    assert.equal(payload["expiresAt"], AT + TTL * 1000);
  });
});

describe("registration capability verification", () => {
  test("a valid capability verifies", () => {
    const { capability, capabilityId } = issue();
    const payload = verify(capability);
    assert.equal(payload.candidateId, "candidate-1");
    assert.equal(payload.capabilityId, capabilityId);
  });

  test("a capability with no assessment binding verifies without one", () => {
    const { capability } = issue();
    assert.equal(verify(capability).assessmentId, null);
  });

  test("an assessment-bound capability verifies when the assessment matches", () => {
    const { capability } = issue({ assessmentId: "assessment-9" });
    const payload = verify(capability, { assessmentId: "assessment-9" });
    assert.equal(payload.assessmentId, "assessment-9");
  });

  test("an assessment-bound capability is refused when the assessment differs", () => {
    const { capability } = issue({ assessmentId: "assessment-9" });
    assert.throws(
      () => verify(capability, { assessmentId: "assessment-other" }),
      RegistrationCapabilityError,
    );
  });

  test("an assessment-bound capability is refused when no assessment is presented", () => {
    const { capability } = issue({ assessmentId: "assessment-9" });
    assert.throws(() => verify(capability), RegistrationCapabilityError);
  });

  test("an unbound capability is not narrowed by a presented assessment", () => {
    // The operator chose not to bind an assessment, so presenting one must not
    // silently make the capability unusable.
    const { capability } = issue();
    assert.equal(verify(capability, { assessmentId: "anything" }).assessmentId, null);
  });
});

describe("registration capability rejection", () => {
  test("a capability for another candidate is refused", () => {
    const { capability } = issue({ candidateId: "candidate-1" });
    assert.throws(() => verify(capability, { candidateId: "candidate-2" }), RegistrationCapabilityError);
  });

  test("a capability signed with another secret is refused", () => {
    const { capability } = issue({ sessionSecret: OTHER_SECRET });
    assert.throws(() => verify(capability), RegistrationCapabilityError);
  });

  test("a tampered payload is refused", () => {
    const { capability } = issue();
    const [version, , signature] = capability.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        kind: "registration",
        candidateId: "candidate-2",
        assessmentId: null,
        issuedAt: AT,
        expiresAt: AT + TTL * 1000,
        capabilityId: "forged",
      }),
    ).toString("base64url");

    assert.throws(
      () => verify(`${version}.${forged}.${signature}`),
      RegistrationCapabilityError,
    );
  });

  test("a tampered signature is refused", () => {
    const { capability } = issue();
    const [version, payload, signature] = capability.split(".");
    const flipped = `${signature!.slice(0, -1)}${signature!.at(-1) === "A" ? "B" : "A"}`;
    assert.throws(() => verify(`${version}.${payload}.${flipped}`), RegistrationCapabilityError);
  });

  test("an expired capability is refused", () => {
    const { capability } = issue();
    // One millisecond past expiry.
    assert.throws(
      () => verify(capability, { now: AT + TTL * 1000 + 1 }),
      RegistrationCapabilityError,
    );
  });

  test("a capability at its exact expiry instant is refused", () => {
    const { capability } = issue();
    assert.throws(() => verify(capability, { now: AT + TTL * 1000 }), RegistrationCapabilityError);
  });

  test("a capability one millisecond before expiry is accepted", () => {
    const { capability } = issue();
    assert.equal(verify(capability, { now: AT + TTL * 1000 - 1 }).candidateId, "candidate-1");
  });

  test("a malformed capability is refused", () => {
    for (const bad of ["", "not-a-capability", "rv1.only-two", "rv1.a.b.c", "xx1.a.b"]) {
      assert.throws(() => verify(bad), RegistrationCapabilityError, `expected refusal for ${bad}`);
    }
  });

  test("a candidate token is not a valid registration capability", () => {
    // Domain separation: the two token families must not be interchangeable.
    const candidateToken = issueCandidateToken({
      secret: SECRET,
      candidateId: "candidate-1",
      displayName: "Ada",
      ttlSeconds: 600,
    }).token;

    assert.throws(() => verify(candidateToken), RegistrationCapabilityError);
  });

  test("an oversized capability is refused before any signature work", () => {
    assert.throws(() => verify("r".repeat(MAX_CAPABILITY_LENGTH + 1)), RegistrationCapabilityError);
  });

  test("an empty session secret refuses to verify anything", () => {
    const { capability } = issue();
    assert.throws(
      () => verifyRegistrationCapability(capability, "", { candidateId: "candidate-1" }),
      RegistrationCapabilityError,
    );
  });

  test("a payload of the wrong kind is refused even when correctly signed", () => {
    // Simulates a future or foreign token family signed with the same key.
    const payload = Buffer.from(
      JSON.stringify({ kind: "candidate", candidateId: "candidate-1", expiresAt: AT + 60_000 }),
    ).toString("base64url");
    const key = createHmac("sha256", SECRET)
      .update("tryveriqo:registration-capability:v1")
      .digest();
    const signature = createHmac("sha256", key).update(payload).digest("base64url");

    assert.throws(
      () => verify(`${REGISTRATION_CAPABILITY_VERSION}.${payload}.${signature}`),
      RegistrationCapabilityError,
    );
  });
});

describe("registration capability issuance bounds", () => {
  test("a missing candidate id is refused", () => {
    assert.throws(() => issue({ candidateId: "   " }), RegistrationCapabilityError);
  });

  test("an empty session secret is refused", () => {
    assert.throws(() => issue({ sessionSecret: "" }), RegistrationCapabilityError);
  });

  test("a lifetime below the minimum is refused", () => {
    assert.throws(
      () => issue({ ttlSeconds: MIN_CAPABILITY_TTL_SECONDS - 1 }),
      RegistrationCapabilityError,
    );
  });

  test("a lifetime above the maximum is refused", () => {
    assert.throws(
      () => issue({ ttlSeconds: MAX_CAPABILITY_TTL_SECONDS + 1 }),
      RegistrationCapabilityError,
    );
  });

  test("a non-finite lifetime is refused", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -60]) {
      assert.throws(() => issue({ ttlSeconds: bad }), RegistrationCapabilityError);
    }
  });

  test("a blank assessment binding is treated as unbound", () => {
    assert.equal(issue({ assessmentId: "   " }).capability.length > 0, true);
    assert.equal(verify(issue({ assessmentId: "" }).capability).assessmentId, null);
  });
});
