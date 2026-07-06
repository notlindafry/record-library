import { NextResponse, type NextRequest } from "next/server";
import { refreshCollection } from "@/lib/discogs";
import { isAuthorizedCron } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A two-account paginate with rate-limit pauses can run past the default budget.
export const maxDuration = 60;

/**
 * GET /api/cron/refresh-collection
 *
 * Warms the persistent collection cache (feature 1). Invoked by Vercel Cron, which
 * attaches `Authorization: Bearer <CRON_SECRET>` automatically. Not session-gated
 * in proxy.ts, so it fails closed on the shared secret instead: any request
 * without the correct secret is rejected (feature spec §0.2).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { records, partial } = await refreshCollection();
    return NextResponse.json({ ok: true, count: records.length, partial });
  } catch (err) {
    console.error("[cron refresh-collection] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Refresh failed" }, { status: 502 });
  }
}
