/**
 * Correlation-id middleware.
 *
 * Attaches a request-scoped id to every response so a log line can be tied to a
 * specific request without ever logging request bodies or credentials.
 */

import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../middleware/auth.js";

export function correlationId(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const inbound = c.req.header("X-Correlation-Id")?.trim();
    const id = inbound && inbound.length <= 128 ? inbound : crypto.randomUUID();
    c.set("correlationId", id);
    await next();
    c.res.headers.set("X-Correlation-Id", id);
  };
}
