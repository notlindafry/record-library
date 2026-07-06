/**
 * Guard for cron-triggered internal routes (collection refresh, and future
 * background jobs). Only Vercel Cron — or you, holding the secret — may invoke
 * them; a normal visitor never should.
 *
 * Vercel automatically attaches `Authorization: Bearer <CRON_SECRET>` to every
 * scheduled request when `CRON_SECRET` is set on the project, so the only setup
 * is adding that one env var in Vercel. The comparison is constant-time to avoid
 * leaking the secret through timing.
 */

import type { NextRequest } from "next/server";
import { constantTimeEqual } from "@/lib/auth";

/** True when the cron shared secret is configured. */
export function isCronConfigured(): boolean {
  return Boolean(process.env.CRON_SECRET);
}

/** True when the request carries the correct `Authorization: Bearer <secret>`. */
export function isAuthorizedCron(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed: no secret configured, no access
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return constantTimeEqual(header.slice(prefix.length), secret);
}
