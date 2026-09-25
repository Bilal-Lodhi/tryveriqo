/**
 * Configuration census.
 *
 * A regression test for a defect class that has now occurred three times in this
 * repository: a setting that `loadConfig()` parses, that the documentation
 * describes, and that **nothing reads**. `SESSION_TTL_SECONDS` (a documented
 * session staleness horizon that did not exist), `PLAGIARISM_THRESHOLD` (a
 * documented similarity threshold with no effect) and `config.database.uri` (a
 * Mongo URI the API never used) were all the same mistake.
 *
 * The census enumerates every field `loadConfig()` produces and asserts each one
 * is read somewhere in the API source outside `config.ts` itself. A field only
 * referenced by its own tests is still dead config.
 *
 * ## How "consumed" is decided, and its limits
 *
 * Two indirection patterns are common here and a naive `config.a.b` search misses
 * both:
 *
 *   - a narrowed view — `this.ai = config.ai`, then `this.ai.apiKey`
 *   - whole-object passing — `shouldAnalyze(session, config.integrity)`
 *
 * So a field counts as consumed if either its full dotted path appears, **or** an
 * ancestor object is passed as a whole value *and* the field's own name is read as
 * a property somewhere. That resolves both patterns without hard-coding them.
 *
 * The heuristic can produce a false negative — a field name that happens to appear
 * as a property for an unrelated reason — so it is a floor, not a proof. It is
 * deliberately conservative in the other direction: it fails loudly rather than
 * silently passing. If a genuinely consumed field is ever reported, add it to
 * `DOCUMENTED_EXCEPTIONS` **with a reason** rather than loosening the check.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(HERE, "..", "src");

/**
 * Fields that are intentionally part of `AppConfig` without being read elsewhere.
 *
 * Empty, and it should stay that way: a field nothing consumes is a claim the
 * code does not honour. Add an entry only with a written reason, and prefer
 * removing the field.
 */
const DOCUMENTED_EXCEPTIONS: readonly string[] = [];

/** Every TypeScript file under `apps/api/src`, except the config loader. */
function sourceOutsideConfig(): string {
  const chunks: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts") && entry !== "config.ts") {
        chunks.push(readFileSync(full, "utf8"));
      }
    }
  };

  walk(API_SRC);
  return chunks.join("\n");
}

/** Leaf field paths of a config object, e.g. `ai.model`, `database.databaseName`. */
function leafPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  const paths: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    paths.push(...leafPaths(child, prefix ? `${prefix}.${key}` : key));
  }
  return paths;
}

function escapeForRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when the source reads this config field, through either indirection. */
function isConsumed(path: string, source: string): boolean {
  if (source.includes(`config.${path}`)) return true;

  const segments = path.split(".");
  const [head, ...rest] = segments as [string, ...string[]];

  // An ancestor passed as a whole value, with the field read as a property.
  for (let depth = 1; depth <= rest.length; depth += 1) {
    const ancestor = [head, ...rest.slice(0, depth - 1)].join(".");
    // `config.<ancestor>` NOT followed by another property access.
    const wholeObject = new RegExp(`config\\.${escapeForRegex(ancestor)}(?![\\w.])`);
    if (!wholeObject.test(source)) continue;

    const fieldName = rest[depth - 1] as string;
    if (new RegExp(`\\.${escapeForRegex(fieldName)}\\b`).test(source)) return true;
  }

  return false;
}

describe("config census", () => {
  test("every field loadConfig() produces is read outside config.ts", () => {
    const previous = process.env["ENVIRONMENT"];
    process.env["ENVIRONMENT"] = "test";

    let config;
    try {
      config = loadConfig();
    } finally {
      if (previous === undefined) delete process.env["ENVIRONMENT"];
      else process.env["ENVIRONMENT"] = previous;
    }

    const source = sourceOutsideConfig();
    const paths = leafPaths(config);
    assert.ok(paths.length > 20, `expected a substantial config, got ${paths.length} fields`);

    const unconsumed = paths
      .filter((path) => !DOCUMENTED_EXCEPTIONS.includes(path))
      .filter((path) => !isConsumed(path, source));

    assert.deepEqual(
      unconsumed,
      [],
      `config fields nothing reads (dead config): ${unconsumed.join(", ")}. ` +
        "Either consume the field, remove it, or add it to DOCUMENTED_EXCEPTIONS with a reason.",
    );
  });

  test("the census detects a field nothing reads", () => {
    // The census is only worth having if it can fail. A field that exists on the
    // object but appears nowhere in source must be reported.
    const source = sourceOutsideConfig();

    assert.equal(isConsumed("ai.model", source), true, "a consumed field must pass");
    assert.equal(
      isConsumed("database.uri", source),
      false,
      "a field nothing reads must be reported — this is the defect the census exists for",
    );
    assert.equal(isConsumed("integrity.plagiarismThreshold", source), true);
    assert.equal(isConsumed("nonsense.field", source), false);
  });

  test("MONGODB_URI is not read by the API config layer", () => {
    // The MCP process owns the connection and reads MONGODB_URI itself. If the
    // API ever starts reading it, that is a deliberate architectural change and
    // this test should be updated with it — not silently allowed.
    //
    // Matched against the *read patterns*, not the bare string, because
    // `config.ts` legitimately mentions MONGODB_URI in a comment explaining why
    // it is absent.
    const configSource = readFileSync(join(API_SRC, "config.ts"), "utf8");

    for (const pattern of [
      /readString\(\s*["']MONGODB_URI["']/,
      /process\.env\[\s*["']MONGODB_URI["']\s*\]/,
      /process\.env\.MONGODB_URI\b/,
    ]) {
      assert.equal(
        pattern.test(configSource),
        false,
        `the API config layer must not read MONGODB_URI (matched ${pattern}); the MCP process owns it`,
      );
    }
  });

  test("the database config carries only what the API actually uses", () => {
    const previous = process.env["ENVIRONMENT"];
    process.env["ENVIRONMENT"] = "test";
    let config;
    try {
      config = loadConfig();
    } finally {
      if (previous === undefined) delete process.env["ENVIRONMENT"];
      else process.env["ENVIRONMENT"] = previous;
    }

    assert.deepEqual(
      Object.keys(config.database),
      ["databaseName"],
      "databaseName is reported by /health; the API has no other database setting",
    );
  });
});
