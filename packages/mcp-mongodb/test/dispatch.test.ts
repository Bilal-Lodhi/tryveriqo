/**
 * Tool dispatch tests.
 *
 * The handler table is a plain object literal, so a bare `handlers[name]` lookup
 * walks the prototype chain: `constructor`, `toString`, `hasOwnProperty` and
 * friends resolve to `Object.prototype` members and are truthy. Before this was
 * fixed, `POST /tools/constructor` therefore passed the "is this a real tool?"
 * check and returned `200` with a payload fabricated from the caller's arguments,
 * instead of the `404` the transport is supposed to give.
 *
 * The pre-existing test used the invented name `no_such_tool`, which does not
 * collide with the prototype and so passed regardless.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MCP_TOOLS,
  MCP_TOOL_NAMES,
  ToolArgumentError,
  createToolHandlers,
  dispatchTool,
  registeredToolNames,
  type ToolArguments,
} from "@assessment/mcp-mongodb";
import { MongoStore } from "@assessment/mcp-mongodb";

/** A handler table with one real tool, so a dispatch can succeed. */
function handlersWithRealTool() {
  return {
    [MCP_TOOLS.LIST_SESSIONS]: async () => ({ success: true, data: [] }),
  } as ReturnType<typeof createToolHandlers>;
}

const INHERITED_NAMES = [
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__proto__",
  "__defineGetter__",
  "__lookupGetter__",
];

describe("dispatch rejects every undeclared tool name", () => {
  test("an invented name is refused", async () => {
    const result = await dispatchTool(handlersWithRealTool(), "no_such_tool", {});
    assert.equal(result.status, 404);
  });

  test("inherited Object.prototype members are refused", async () => {
    // Each of these is a truthy property of a plain object literal.
    for (const name of INHERITED_NAMES) {
      const result = await dispatchTool(handlersWithRealTool(), name, { probe: "value" });
      assert.equal(result.status, 404, `expected 404 for '${name}', got ${result.status}`);
      assert.match(String((result.payload as Record<string, unknown>)["error"]), /Unknown tool/);
    }
  });

  test("a refused name never produces a success payload", async () => {
    for (const name of INHERITED_NAMES) {
      const result = await dispatchTool(handlersWithRealTool(), name, {});
      const payload = result.payload as Record<string, unknown>;
      assert.equal(payload["success"], false, `'${name}' must not report success`);
      assert.notEqual(result.status, 200, `'${name}' must not return 200`);
    }
  });

  test("a refused name reports the real tool list, not prototype keys", async () => {
    const result = await dispatchTool(handlersWithRealTool(), "constructor", {});
    const available = (result.payload as Record<string, unknown>)["availableTools"] as string[];

    assert.ok(Array.isArray(available));
    assert.deepEqual(available, [MCP_TOOLS.LIST_SESSIONS]);
    for (const name of INHERITED_NAMES) {
      assert.equal(available.includes(name), false, `'${name}' must not be advertised`);
    }
  });

  test("every declared tool is still dispatchable", async () => {
    const store = new MongoStore({
      uri: "mongodb://127.0.0.1:27017",
      databaseName: "unused",
    });
    const handlers = createToolHandlers(store);

    // Only assert that dispatch reaches a handler rather than 404ing: the store
    // is not connected, so a real call may fail for other reasons.
    for (const name of MCP_TOOL_NAMES) {
      const result = await dispatchTool(handlers, name, {});
      assert.notEqual(result.status, 404, `declared tool '${name}' must be dispatchable`);
    }
  });

  test("the declared tool list contains no inherited member names", () => {
    for (const name of INHERITED_NAMES) {
      assert.equal(
        (MCP_TOOL_NAMES as readonly string[]).includes(name),
        false,
        `'${name}' must not be a declared tool`,
      );
    }
  });

  test("registered names are the table's own keys", () => {
    const handlers = handlersWithRealTool();
    const registered = registeredToolNames(handlers);
    assert.deepEqual(registered, [MCP_TOOLS.LIST_SESSIONS]);
    for (const name of INHERITED_NAMES) {
      assert.equal(registered.includes(name as never), false);
    }
  });
});

describe("dispatch error semantics are unchanged", () => {
  test("a handler error becomes a 500 with a stable payload", async () => {
    const handlers = {
      [MCP_TOOLS.LIST_SESSIONS]: async () => {
        throw new Error("store exploded");
      },
    } as unknown as ReturnType<typeof createToolHandlers>;

    const result = await dispatchTool(handlers, MCP_TOOLS.LIST_SESSIONS, {});
    assert.equal(result.status, 500);
    assert.equal((result.payload as Record<string, unknown>)["success"], false);
  });

  test("a tool argument error becomes a 400", async () => {
    const handlers = {
      [MCP_TOOLS.LIST_SESSIONS]: async () => {
        throw new ToolArgumentError("bad argument");
      },
    } as unknown as ReturnType<typeof createToolHandlers>;

    const result = await dispatchTool(handlers, MCP_TOOLS.LIST_SESSIONS, {});
    assert.equal(result.status, 400);
  });

  test("a successful call returns its handler payload", async () => {
    const result = await dispatchTool(handlersWithRealTool(), MCP_TOOLS.LIST_SESSIONS, {});
    assert.equal(result.status, 200);
    assert.equal((result.payload as Record<string, unknown>)["success"], true);
  });

  test("an empty handler table refuses every name", async () => {
    const empty = {} as ReturnType<typeof createToolHandlers>;
    for (const name of [...INHERITED_NAMES, "no_such_tool", ""]) {
      const result = await dispatchTool(empty, name, {} as ToolArguments);
      assert.equal(result.status, 404, `expected 404 for '${name}'`);
    }
  });
});
