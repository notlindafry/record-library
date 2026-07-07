import { NextResponse, type NextRequest } from "next/server";
import { clientIpFromHeaders, enforceRateLimit, sweepExpired } from "@/lib/ratelimit";
import { getInsights } from "@/lib/insights/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Read-only: serves the cached batch, or a code-computed fallback. Never calls Claude.
export const maxDuration = 30;

/**
 * GET /api/insights — the cached insights batch for the home-view carousel
 * (feature 6). Any authenticated session may read (the proxy already required
 * one). Read-only and display-only, so no RBAC-on-write or CSRF concern. Degrades
 * gracefully: no cached batch → code-computed stat cards, no Claude call.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  sweepExpired();

  const ip = clientIpFromHeaders(request.headers);
  const rl = await enforceRateLimit(ip, { namespace: "insights", limit: 30, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  try {
    const payload = await getInsights();
    return NextResponse.json(payload);
  } catch (err) {
    console.error("[insights GET] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not load insights." }, { status: 502 });
  }
}
