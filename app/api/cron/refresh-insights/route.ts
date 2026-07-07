import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { refreshInsights } from "@/lib/insights/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Reading the cached collection and one Claude call fits comfortably; give headroom.
export const maxDuration = 60;

/**
 * GET /api/cron/refresh-insights
 *
 * Cron-triggered insight generation (feature 6). Invoked by Vercel Cron, which
 * attaches `Authorization: Bearer <CRON_SECRET>` automatically. Not session-gated
 * in proxy.ts, so it fails closed on the shared secret instead: any request
 * without the correct secret is rejected. Regenerates only when the collection
 * changed or the batch is stale (behind a per-day cap and a lock); an unchanged,
 * fresh shelf is a cheap no-op with no Claude call.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await refreshInsights();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[cron refresh-insights] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Refresh failed" }, { status: 500 });
  }
}
