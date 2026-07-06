/**
 * Rate limiting (rule 3).
 *
 * Two layers, exposed through `enforceRateLimit`:
 *   1. When Upstash is configured, a Redis-backed sliding-window limiter
 *      (`@upstash/ratelimit`) enforces limits GLOBALLY across serverless
 *      instances and cold starts.
 *   2. When Redis is absent OR a Redis call fails, we fall back to the in-memory
 *      fixed-window limiter below. It is best-effort per instance, but it means a
 *      Redis outage degrades protection rather than removing it (fail open WITH a
 *      fallback), and login is never fully unprotected.
 *
 * The in-memory limiter remains the fallback implementation; callers should use
 * the async `enforceRateLimit` rather than `checkRateLimit` directly.
 */

import { Ratelimit } from "@upstash/ratelimit";
import { isRedisConfigured, redis } from "@/lib/redis";

interface Bucket {
  count: number;
  resetAt: number;
}

// One map per limiter key namespace. Keys are `${namespace}:${ip}`.
const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets (for Retry-After). */
  retryAfterSeconds: number;
  remaining: number;
}

export interface RateLimitOptions {
  /** Distinct namespace so login and search limits don't share a counter. */
  namespace: string;
  /** Max requests allowed within the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/**
 * Fixed-window counter. Returns whether this request is allowed and how long to
 * wait if not.
 */
export function checkRateLimit(ip: string, options: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const key = `${options.namespace}:${ip}`;
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    return { allowed: true, retryAfterSeconds: 0, remaining: options.limit - 1 };
  }

  if (existing.count >= options.limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      remaining: 0,
    };
  }

  existing.count += 1;
  return {
    allowed: true,
    retryAfterSeconds: 0,
    remaining: options.limit - existing.count,
  };
}

/**
 * Best-effort eviction of expired buckets so the map doesn't grow unbounded on a
 * long-lived instance. Cheap; called opportunistically from limiter callers.
 */
export function sweepExpired(): void {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Derive a client IP from request headers. On Vercel, x-forwarded-for is set by
 * the platform; the left-most entry is the client. Falls back to a constant so
 * the limiter still functions (globally) when no IP is available.
 */
export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}

// ---- Redis-backed global limiter (@upstash/ratelimit) ----

type Duration = Parameters<typeof Ratelimit.slidingWindow>[1];

// One Ratelimit instance per (namespace, limit, window), constructed lazily and
// reused. @upstash/ratelimit manages its own keys under the `prefix`.
const limiters = new Map<string, Ratelimit>();

function getLimiter(namespace: string, limit: number, windowSeconds: number): Ratelimit {
  const cacheKey = `${namespace}:${limit}:${windowSeconds}`;
  let limiter = limiters.get(cacheKey);
  if (!limiter) {
    limiter = new Ratelimit({
      redis: redis(),
      limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s` as Duration),
      prefix: `vs:rl:${namespace}`,
      analytics: false,
    });
    limiters.set(cacheKey, limiter);
  }
  return limiter;
}

/**
 * Enforce a rate limit, globally when Redis is available and per-instance
 * otherwise. On any Redis error it falls back to the in-memory limiter (fail open
 * WITH a fallback), logging server-side. Drop-in for `checkRateLimit`, but async.
 *
 * The identifier should be a client IP (`clientIpFromHeaders`) or, for
 * authenticated writes, the session subject.
 */
export async function enforceRateLimit(
  identifier: string,
  options: RateLimitOptions,
): Promise<RateLimitResult> {
  if (isRedisConfigured()) {
    try {
      const windowSeconds = Math.max(1, Math.round(options.windowMs / 1000));
      const limiter = getLimiter(options.namespace, options.limit, windowSeconds);
      const res = await limiter.limit(identifier);
      return {
        allowed: res.success,
        retryAfterSeconds: res.success ? 0 : Math.max(1, Math.ceil((res.reset - Date.now()) / 1000)),
        remaining: Math.max(0, res.remaining),
      };
    } catch (err) {
      console.error(
        "[ratelimit] Redis limiter failed; falling back to in-memory:",
        err instanceof Error ? err.message : err,
      );
      // Fall through to the in-memory limiter so protection is degraded, not gone.
    }
  }
  return checkRateLimit(identifier, options);
}
