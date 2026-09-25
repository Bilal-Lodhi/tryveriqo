/**
 * Minimal in-process rate limiter.
 *
 * Purpose is narrow: bound accidental and hostile request amplification against
 * the expensive endpoints (paid model calls, candidate session minting, and
 * telemetry ingestion). It is not a substitute for an edge rate limiter, and the
 * documentation says so.
 *
 * Two properties this file is careful about, because getting either wrong makes
 * the limiter decorative:
 *
 *   - **The bucket key is not attacker-controlled by default.** `X-Forwarded-For`
 *     and `X-Real-Ip` are just request headers; any direct client can set them.
 *     Keying on them meant rotating one header defeated every limit, including
 *     the one on unauthenticated registration. They are only consulted when the
 *     deployment explicitly declares it sits behind a proxy it controls.
 *   - **The bucket map is bounded absolutely.** The previous sweep ran only above
 *     a threshold and only removed already-expired entries, so a client rotating
 *     keys could grow the map without limit while every bucket was still live.
 */

import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { AppEnv } from "./auth.js";

export interface RateLimitBucket {
  count: number;
  resetAt: number;
}

/** Hard ceiling on retained buckets. Reaching it evicts, never grows. */
export const MAX_RATE_LIMIT_BUCKETS = 10_000;

/**
 * How a bucket key is derived.
 *
 * `address`   — the connecting peer. Correct when there is no proxy in front.
 * `principal` — the authenticated candidate when there is one, otherwise the
 *               address. Used where the natural unit is a candidate rather than
 *               a connection, so candidates behind one NAT do not share a limit.
 */
export type RateLimitKeyBy = "address" | "principal";

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum requests allowed per window, per key. */
  max: number;
  /** Human-readable name used in the error message. */
  name: string;
  /** Defaults to `address`. */
  keyBy?: RateLimitKeyBy;
  /**
   * Trust `X-Forwarded-For` / `X-Real-Ip`. Enable **only** when every request
   * reaches this process through a proxy that overwrites those headers.
   * Otherwise a direct client can set them and evade the limit entirely.
   */
  trustProxyHeaders?: boolean;
}

/**
 * The connecting peer's address.
 *
 * Falls back to a fixed key when there is no socket to inspect — a direct
 * `app.request()` in tests, or a non-Node adapter. A fixed fallback means those
 * callers share one bucket, which is the conservative direction: it limits more,
 * not less.
 */
function socketAddress(c: Context<AppEnv>): string {
  try {
    const info = getConnInfo(c);
    return info.remote.address ?? "unknown";
  } catch {
    return "local";
  }
}

/** Resolves the bucket key for one request. */
export function rateLimitKey(c: Context<AppEnv>, options: RateLimitOptions): string {
  if (options.keyBy === "principal") {
    const auth = c.get("auth");
    if (auth?.role === "candidate" && auth.candidateId) return `candidate:${auth.candidateId}`;
  }

  if (options.trustProxyHeaders) {
    const forwarded = c.req.header("X-Forwarded-For")?.split(",")[0]?.trim();
    if (forwarded && forwarded.length > 0) return forwarded;
    const realIp = c.req.header("X-Real-Ip")?.trim();
    if (realIp && realIp.length > 0) return realIp;
  }

  return socketAddress(c);
}

/**
 * Makes room for one more bucket, without ever exceeding the ceiling.
 *
 * Expired buckets go first. If every bucket is still live — which is what a
 * client rotating keys produces — the soonest-to-expire bucket is dropped, so the
 * map is bounded absolutely rather than only opportunistically.
 *
 * Exported so the bound is directly testable: the alternative is inferring it
 * from behaviour after tens of thousands of requests.
 */
export function evictForSpace(buckets: Map<string, RateLimitBucket>, now: number): void {
  for (const [key, value] of buckets) {
    if (value.resetAt <= now) buckets.delete(key);
  }
  if (buckets.size < MAX_RATE_LIMIT_BUCKETS) return;

  let soonestKey: string | null = null;
  let soonestAt = Number.POSITIVE_INFINITY;
  for (const [key, value] of buckets) {
    if (value.resetAt < soonestAt) {
      soonestAt = value.resetAt;
      soonestKey = key;
    }
  }
  if (soonestKey !== null) buckets.delete(soonestKey);
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const buckets = new Map<string, RateLimitBucket>();

  return async (c, next) => {
    const key = rateLimitKey(c, options);
    const now = Date.now();

    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (buckets.size >= MAX_RATE_LIMIT_BUCKETS) evictForSpace(buckets, now);
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      await next();
      return;
    }

    if (bucket.count >= options.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
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
