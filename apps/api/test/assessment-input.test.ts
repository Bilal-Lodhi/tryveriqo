/**
 * Assessment generation request validation and content pre-filter tests.
 *
 * These are pure-function tests: no server, no provider, no database.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PROBLEM_COUNT,
  difficultyMixDeviation,
  isGreetingOnly,
  runContentPreFilter,
  validateGenerateRequest,
} from "../src/assessment-input.js";

describe("validateGenerateRequest", () => {
  test("accepts a well-formed request and trims text fields", () => {
    const result = validateGenerateRequest({
      prompt: "  Generate a Python data-structures assessment.  ",
      roleContext: "  backend ",
      problemCount: 4,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.prompt, "Generate a Python data-structures assessment.");
    assert.equal(result.value.roleContext, "backend");
    assert.equal(result.value.problemCount, 4);
  });

  test("defaults problemCount when omitted", () => {
    const result = validateGenerateRequest({ prompt: "A valid prompt", roleContext: "backend" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.problemCount, 5);
  });

  test("rejects a missing or blank prompt", () => {
    assert.equal(validateGenerateRequest({ roleContext: "backend" }).ok, false);
    assert.equal(validateGenerateRequest({ prompt: "   ", roleContext: "backend" }).ok, false);
    assert.equal(validateGenerateRequest({ prompt: 42, roleContext: "backend" }).ok, false);
  });

  test("rejects a missing roleContext", () => {
    assert.equal(validateGenerateRequest({ prompt: "A valid prompt" }).ok, false);
    assert.equal(validateGenerateRequest({ prompt: "A valid prompt", roleContext: "" }).ok, false);
  });

  test("rejects a problemCount outside the accepted range", () => {
    const base = { prompt: "A valid prompt", roleContext: "backend" };
    assert.equal(validateGenerateRequest({ ...base, problemCount: 0 }).ok, false);
    assert.equal(validateGenerateRequest({ ...base, problemCount: MAX_PROBLEM_COUNT + 1 }).ok, false);
    assert.equal(validateGenerateRequest({ ...base, problemCount: 2.5 }).ok, false);
    assert.equal(validateGenerateRequest({ ...base, problemCount: "twelve" }).ok, false);
  });

  test("rejects a malformed difficultyMix", () => {
    assert.equal(
      validateGenerateRequest({
        prompt: "A valid prompt",
        roleContext: "backend",
        difficultyMix: { beginner: 0.5 },
      }).ok,
      false,
    );
  });

  test("rejects non-object bodies", () => {
    assert.equal(validateGenerateRequest(null).ok, false);
    assert.equal(validateGenerateRequest([]).ok, false);
    assert.equal(validateGenerateRequest("prompt").ok, false);
  });

  test("reports difficulty weight deviation without rejecting", () => {
    assert.ok(difficultyMixDeviation({ beginner: 0.5, intermediate: 0.5, advanced: 0.5 }) > 0.05);
    assert.ok(difficultyMixDeviation({ beginner: 0.34, intermediate: 0.33, advanced: 0.33 }) < 0.01);
  });
});

describe("content pre-filter", () => {
  test("passes a genuine assessment request", () => {
    const result = runContentPreFilter(
      "Create a coding assessment for mid-level TypeScript engineers covering async patterns.",
    );
    assert.equal(result.passed, true);
    assert.deepEqual(result.flags, []);
  });

  test("accepts single-word technical prompts and pasted code", () => {
    // A conservative filter must not reject legitimate short or code-shaped input.
    for (const input of ["kubernetes", "React", "function foo(){return 42;}"]) {
      assert.equal(runContentPreFilter(input).passed, true, `expected "${input}" to pass`);
    }
  });

  test("rejects empty input", () => {
    const result = runContentPreFilter("   ");
    assert.equal(result.passed, false);
    assert.deepEqual(result.flags, ["EMPTY_INPUT"]);
  });

  test("rejects input that is too short to be a request", () => {
    const result = runContentPreFilter("ab");
    assert.equal(result.passed, false);
    assert.deepEqual(result.flags, ["TOO_SHORT"]);
  });

  test("rejects greetings", () => {
    for (const greeting of ["hi", "hello", "hey there", "good morning", "what's up"]) {
      const result = runContentPreFilter(greeting);
      assert.equal(result.passed, false, `expected "${greeting}" to be rejected`);
      assert.deepEqual(result.flags, ["GREETING_ONLY"]);
    }
  });

  test("detects greetings directly", () => {
    assert.equal(isGreetingOnly("Hi!"), true);
    assert.equal(isGreetingOnly("Create an assessment"), false);
  });

  test("rejects profanity", () => {
    const result = runContentPreFilter("generate a fucking test suite for me");
    assert.equal(result.passed, false);
    assert.deepEqual(result.flags, ["PROFANITY"]);
  });

  test("rejects unambiguous keyboard mashing", () => {
    for (const mashing of [
      "aaaaaaaaaa",
      "qwertyuiop",
      "12345678901234567890",
      "!!!!!!!!!!!!!!!!",
    ]) {
      const result = runContentPreFilter(mashing);
      assert.equal(result.passed, false, `expected "${mashing}" to be rejected`);
      assert.deepEqual(result.flags, ["GIBBERISH"]);
    }
  });

  test("does not classify legitimate words or prose as mashing", () => {
    // A false rejection here would block a genuine assessment request, so the
    // filter must stay high-precision and defer ambiguous input to the model.
    for (const input of [
      "internationalization",
      "kubernetes",
      "synchronization",
      "troubleshooting",
      "microservices",
      "asdkjfhaskjdfhaksjdfh",
      "Create an assessment for a data engineer covering streaming pipelines.",
    ]) {
      const result = runContentPreFilter(input);
      assert.equal(result.passed, true, `expected "${input}" to pass, got ${JSON.stringify(result)}`);
    }
  });

  test("does not flag legitimate long technical prose", () => {
    const prose =
      "Design an advanced assessment covering distributed systems consistency, " +
      "idempotency and exactly-once delivery semantics for senior backend engineers.";
    assert.equal(runContentPreFilter(prose).passed, true);
  });
});
