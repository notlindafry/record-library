/**
 * Shared Upstash Redis client. Everything in the app that touches Redis goes
 * through this module, so there is one connection and one place that reads the
 * credentials.
 *
 * The REST token is a full credential for the database: it stays in env only, is
 * never logged, and never reaches the client. Callers must guard on
 * `isRedisConfigured()` (or catch construction errors) and fail open, so the app
 * still works when Redis is unconfigured or unreachable.
 */

import { Redis } from "@upstash/redis";

/** True when Upstash credentials are present (UPSTASH_* or the KV_* fallbacks). */
export function isRedisConfigured(): boolean {
  return Boolean(
    (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) ||
      (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN),
  );
}

let client: Redis | null = null;

/**
 * The shared Redis client, constructed once and reused. `Redis.fromEnv()` reads
 * the UPSTASH_* names and falls back to the KV_REST_API_* names. Throws if no
 * credentials are present, so guard with `isRedisConfigured()` first.
 */
export function redis(): Redis {
  if (!client) client = Redis.fromEnv();
  return client;
}
