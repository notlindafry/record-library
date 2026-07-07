import { NextResponse, type NextRequest } from "next/server";
import { clientIpFromHeaders, enforceRateLimit, sweepExpired } from "@/lib/ratelimit";
import { getCollection } from "@/lib/discogs";
import type { Record as ShelfRecord, ShelfResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const PREVIEW_DEFAULT = 8;
const PREVIEW_MAX = 60;
const ALL_CAP = 500; // bound the "View all" payload

/** A random sample of `n` records (partial Fisher-Yates; no bias, no full copy sort). */
function sample(records: ShelfRecord[], n: number): ShelfRecord[] {
  const copy = records.slice();
  const k = Math.min(n, copy.length);
  const out: ShelfRecord[] = [];
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
    out.push(copy[i]);
  }
  return out;
}

/**
 * GET /api/shelf — records for the home-view "On the shelf" grid.
 *
 * `?all=1` returns the whole collection (sorted, capped) for the "View all" view;
 * otherwise a small random sample of `?limit=` records for the preview. Any
 * authenticated session may read (the proxy already required one); rate limited
 * by IP, same as the other read routes. Read-only — no writes, no Claude.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  sweepExpired();

  const ip = clientIpFromHeaders(request.headers);
  const rl = await enforceRateLimit(ip, { namespace: "shelf", limit: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  try {
    const { records, partial } = await getCollection();
    const params = request.nextUrl.searchParams;

    let out: ShelfRecord[];
    if (params.get("all") === "1") {
      out = records
        .slice()
        .sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title))
        .slice(0, ALL_CAP);
    } else {
      const raw = Number(params.get("limit"));
      const n = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), PREVIEW_MAX) : PREVIEW_DEFAULT;
      out = sample(records, n);
    }

    const payload: ShelfResponse = { records: out, total: records.length, partial };
    return NextResponse.json(payload);
  } catch (err) {
    console.error("[shelf GET] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not load the shelf." }, { status: 502 });
  }
}
