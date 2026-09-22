/**
 * Minimal in-process rate limiter.
 *
 * Purpose is narrow: bound accidental and hostile request amplification against
 * the two expensive endpoints (paid model calls, and candidate session minting).
 * It is not a substitute for an edge rate limiter, and the documentation says so.
 */

import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./auth.js";

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum requests allowed per window, per key. */
  max: number;
  /** Human-readable name used in the error message. */
  name: string;
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const buckets = new Map<string, Bucket>();

  return async (c, next) => {
    const forwarded = c.req.header("X-Forwarded-For")?.split(",")[0]?.trim();
    const key = forwarded && forwarded.length > 0 ? forwarded : (c.req.header("X-Real-Ip") ?? "local");
    const now = Date.now();

    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      // Opportunistic sweep so a long-lived process cannot grow unbounded.
      if (buckets.size > 10_000) {
        for (const [candidateKey, value] of buckets) {
          if (value.resetAt <= now) buckets.delete(candidateKey);
        }
      }
      await next();
      return;
    }

    if (bucket.count >= options.max) {
      const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
      c.header("Retry-After", String(retryAfterSeconds));
      return c.json(
        {
          success: false,
          error: `Too many ${options.name} requests. Retry in ${retryAfterSeconds}s.`,
        },
        429,
      );
    }

    bucket.count += 1;
    await next();
    return;
  };
}
