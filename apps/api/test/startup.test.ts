/**
 * Startup fail-closed test.
 *
 * Spawns the real entry point as a child process so the assertion covers the
 * actual startup path — configuration loading, the production secret check, and
 * the exit code — rather than a re-implementation of it.
 *
 * Child output is redirected to a file and then read, so the test makes no
 * assumptions about Node's stdio plumbing.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "..", "src", "index.ts");

interface RunResult {
  status: number | null;
  output: string;
}

function runEntryPoint(env: Record<string, string>): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "assessment-startup-"));
  const outputFile = join(dir, "output.log");

  const command = `node --import tsx "${ENTRY}" > "${outputFile}" 2>&1`;

  const result = spawnSync(command, {
    shell: true,
    cwd: join(HERE, ".."),
    env: {
      PATH: process.env["PATH"] ?? "",
      SystemRoot: process.env["SystemRoot"] ?? "",
      TEMP: process.env["TEMP"] ?? "",
      TMP: process.env["TMP"] ?? "",
      ...env,
    },
    timeout: 30_000,
  });

  let output = "";
  try {
    output = readFileSync(outputFile, "utf8");
  } catch {
    output = "";
  }
  rmSync(dir, { recursive: true, force: true });

  return { status: result.status, output };
}

describe("production fails closed", () => {
  test("refuses to start without an operator token", () => {
    const result = runEntryPoint({
      ENVIRONMENT: "production",
      ASSESSMENT_SESSION_SECRET: "a-session-secret-that-is-long-enough-01",
      ASSESSMENT_API_TOKEN: "",
      CORS_ALLOWED_ORIGINS: "https://assessment.example",
      GEMINI_API_KEY: "irrelevant-for-this-check",
    });

    assert.notEqual(result.status, 0, "the process must exit non-zero");
    assert.match(result.output, /ASSESSMENT_API_TOKEN/);
    assert.match(result.output, /Refusing to start in production/);
  });

  test("refuses to start without a session secret", () => {
    const result = runEntryPoint({
      ENVIRONMENT: "production",
      ASSESSMENT_API_TOKEN: "an-operator-token-value",
      ASSESSMENT_SESSION_SECRET: "",
      CORS_ALLOWED_ORIGINS: "https://assessment.example",
      GEMINI_API_KEY: "irrelevant-for-this-check",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.output, /ASSESSMENT_SESSION_SECRET/);
  });

  test("refuses to start without an explicit CORS allow-list", () => {
    const result = runEntryPoint({
      ENVIRONMENT: "production",
      ASSESSMENT_API_TOKEN: "an-operator-token-value",
      ASSESSMENT_SESSION_SECRET: "a-session-secret-that-is-long-enough-01",
      CORS_ALLOWED_ORIGINS: "",
      GEMINI_API_KEY: "irrelevant-for-this-check",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.output, /CORS_ALLOWED_ORIGINS/);
  });

  test("refuses to start without AI credentials", () => {
    const result = runEntryPoint({
      ENVIRONMENT: "production",
      ASSESSMENT_API_TOKEN: "an-operator-token-value",
      ASSESSMENT_SESSION_SECRET: "a-session-secret-that-is-long-enough-01",
      CORS_ALLOWED_ORIGINS: "https://assessment.example",
      GEMINI_API_KEY: "",
      AI_PROVIDER_MODE: "gemini-api",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.output, /GEMINI_API_KEY/);
  });

  test("names every missing production value at once", () => {
    const result = runEntryPoint({ ENVIRONMENT: "production" });
    assert.notEqual(result.status, 0);
    for (const name of [
      "ASSESSMENT_API_TOKEN",
      "ASSESSMENT_SESSION_SECRET",
      "CORS_ALLOWED_ORIGINS",
      "GEMINI_API_KEY",
    ]) {
      assert.match(result.output, new RegExp(name), `the report should name ${name}`);
    }
  });
});

describe("development is explicit but not silent", () => {
  test("generates ephemeral credentials, says so, and serves", () => {
    const result = runEntryPoint({
      ENVIRONMENT: "development",
      PORT: "0",
      // Ask the spawned server to exit cleanly once it has bound.
      ASSESSMENT_SHUTDOWN_AFTER_MS: "500",
      // No credentials supplied at all.
      ASSESSMENT_API_TOKEN: "",
      ASSESSMENT_SESSION_SECRET: "",
    });

    assert.match(result.output, /Development mode/);
    assert.match(result.output, /Development operator token/);
    assert.match(result.output, /ASSESSMENT_SESSION_SECRET was not set/);
    assert.equal(result.status, 0, `the development server should start and exit cleanly: ${result.output}`);
  });
});
