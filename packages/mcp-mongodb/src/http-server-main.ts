/**
 * Process entry point for the Assessment MCP HTTP tool transport.
 *
 * Binds the tool surface, connects the MongoDB store, and shuts down cleanly on
 * SIGTERM so a container restart does not leave an orphaned socket.
 */

import { MongoStore } from "./mongo-store.js";
import { createMcpHttpServer } from "./http-server.js";

const port = Number.parseInt(process.env["MCP_PORT"] ?? "3001", 10);
const host = process.env["MCP_HOST"] ?? "127.0.0.1";
const store = new MongoStore();

async function main(): Promise<void> {
  // Build the server before touching the datastore. Construction is where the
  // production auth-token check lives, so an unprotected tool surface is
  // refused immediately rather than after a connection attempt. That keeps the
  // fail-closed guarantee independent of whether MongoDB happens to be
  // reachable, which is what makes it testable without a database.
  const server = createMcpHttpServer({
    store,
    port: Number.isFinite(port) ? port : 3001,
    host,
    environment: process.env["ENVIRONMENT"],
    authToken: process.env["MCP_AUTH_TOKEN"],
    corsOrigins: (process.env["CORS_ALLOWED_ORIGINS"] ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  });

  await store.connect();
  console.error(
    `[mcp-http] Connected to MongoDB database "${store.databaseNameInUse}"`,
  );

  await server.listen();

  const shutdown = async (): Promise<void> => {
    console.error("[mcp-http] Shutting down");
    await server.close();
    await store.disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((error: unknown) => {
  console.error(
    "[mcp-http] Fatal startup error:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
