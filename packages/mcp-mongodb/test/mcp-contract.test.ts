/**
 * MCP caller/handler contract test.
 *
 * The MCP tool surface has two transports and, historically, two hand-maintained
 * tool tables that had already drifted apart. This test proves the invariant
 * that replaced them:
 *
 *   1. the handler table covers exactly the declared tool names — no more, no
 *      fewer;
 *   2. every tool the API calls is declared in the shared contract, verified by
 *      scanning the API source for tool references;
 *   3. every declared tool has a definition advertised over MCP `tools/list`;
 *   4. both transports are built from the same handler table.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MCP_TOOLS,
  MCP_TOOL_NAMES,
  TOOL_DEFINITIONS,
  TOOL_DEFINITIONS_BY_NAME,
  MongoStore,
  createToolHandlers,
  registeredToolNames,
} from "@assessment/mcp-mongodb";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(HERE, "..", "..", "..", "apps", "api", "src");

function collectTsFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

describe("handler coverage", () => {
  test("the handler table covers exactly the declared tool names", () => {
    const store = new MongoStore({ uri: "mongodb://127.0.0.1:27017", databaseName: "unused" });
    const handlers = createToolHandlers(store);
    const registered = registeredToolNames(handlers).sort();
    const declared = [...MCP_TOOL_NAMES].sort();

    assert.deepEqual(registered, declared);
  });

  test("every declared tool has exactly one advertised definition", () => {
    assert.equal(TOOL_DEFINITIONS.length, MCP_TOOL_NAMES.length);
    for (const name of MCP_TOOL_NAMES) {
      const definition = TOOL_DEFINITIONS_BY_NAME[name];
      assert.ok(definition, `missing definition for ${name}`);
      assert.equal(definition.name, name);
      assert.ok(definition.description.length > 0, `${name} must describe itself`);
      assert.equal(definition.inputSchema.type, "object");
    }
    const names = TOOL_DEFINITIONS.map((definition) => definition.name);
    assert.equal(new Set(names).size, names.length, "tool names must be unique");
  });

  test("definition objects are keyed by their own name", () => {
    for (const [key, definition] of Object.entries(TOOL_DEFINITIONS_BY_NAME)) {
      assert.equal(key, definition.name);
    }
  });
});

describe("cross-module contract", () => {
  test("the API references only declared tool names", () => {
    const files = collectTsFiles(API_SRC);
    const declared = new Set<string>(MCP_TOOL_NAMES);
    const referenced = new Set<string>();
    const rawToolStrings: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");

      // Every `MCP_TOOLS.X` reference must resolve to a declared tool.
      for (const match of source.matchAll(/MCP_TOOLS\.([A-Z_]+)/g)) {
        const member = match[1] as keyof typeof MCP_TOOLS;
        assert.ok(
          member in MCP_TOOLS,
          `${file} references MCP_TOOLS.${member}, which is not declared`,
        );
        referenced.add(MCP_TOOLS[member]);
      }

      // The API must never hard-code a tool name as a string literal, which is
      // exactly how the two transports drifted apart before.
      for (const match of source.matchAll(
        /["'`](\/tools\/)?([a-z_]+_(?:suite|session|events|report|code|status))["'`]/g,
      )) {
        rawToolStrings.push(`${file}: ${match[0]}`);
      }
    }

    assert.ok(referenced.size > 0, "the API should reference at least one tool");
    for (const name of referenced) {
      assert.ok(declared.has(name), `the API calls ${name}, which is not declared`);
    }
    assert.deepEqual(
      rawToolStrings,
      [],
      "tool names must come from the shared contract, not from string literals",
    );
  });

  test("both transports are built from the shared handler table", () => {
    for (const transport of ["http-server.ts", "stdio-server.ts"]) {
      const source = readFileSync(join(HERE, "..", "src", transport), "utf8");
      assert.match(
        source,
        /createToolHandlers/,
        `${transport} must build its handlers from createToolHandlers`,
      );
      assert.doesNotMatch(
        source,
        /const TOOLS\s*=|const tools:\s*Record<string,\s*ToolHandler>\s*=\s*\{/,
        `${transport} must not maintain its own tool table`,
      );
    }
  });

  test("the declared tool names match the expected assessment vocabulary", () => {
    assert.deepEqual(
      [...MCP_TOOL_NAMES].sort(),
      [
        "create_session",
        "delete_session",
        "get_candidate_report",
        "get_session_review",
        "get_test_suite",
        "health_check",
        "ingest_micro_events",
        "list_sessions",
        "store_integrity_report",
        "store_test_suite",
        "update_session_code",
        "update_session_status",
      ],
    );
  });

  test("no retired product identifier appears in the MCP runtime source", () => {
    for (const file of collectTsFiles(join(HERE, "..", "src"))) {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(source, /gorilla|cerberus|employee|exfiltration/i, `${file} is not Assessment-native`);
    }
  });
});
