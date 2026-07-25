import { NextResponse, type NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { isAuthorizedCron } from "@/lib/cron";
import { getCollection } from "@/lib/discogs";
import {
  MOOD_CHUNK_SIZE,
  MOOD_VERSION,
  classifyReleaseChunk,
  loadArtistTags,
  moodStatus,
  storeMoods,
} from "@/lib/moods";
import type { Record as ShelfRecord } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A few Claude calls per run, paced to finish within the function budget; the
// next run continues where this one stopped.
export const maxDuration = 60;

// One Claude call per MOOD_CHUNK_SIZE releases. Bound the per-run batch so a
// handful of chunks (plus their Redis writes) finish inside maxDuration.
const BATCH_SIZE = 300;

/**
 * GET /api/cron/hydrate-moods
 *
 * Backfills per-release moods into Redis a bounded batch at a time, mirroring
 * hydrate-descriptors. Guarded by the cron secret. Idempotent and resumable: it
 * classifies only ids without a current-version entry, so repeated runs (cron or
 * manual) march through the collection and then just pick up new records or a
 * MOOD_VERSION bump.
 *
 * This is what keeps mood filtering fast: the read path (getMoodIndex) reads
 * these stored moods instead of classifying the whole collection on the request.
 *
 * Fails open: with no ANTHROPIC_API_KEY there is nothing to generate, so it
 * no-ops and mood filtering keeps running on the style/tag heuristic. A Claude
 * failure on a chunk is transient, so those ids are left for the next run.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ ok: true, skipped: "ANTHROPIC_API_KEY not configured" });
  }

  try {
    const { records } = await getCollection();

    // Distinct release ids (moods are keyed by id — two owners of the same release
    // share one entry), each with a representative record for classification.
    const byId = new Map<string, ShelfRecord>();
    for (const r of records) if (!byId.has(r.id)) byId.set(r.id, r);
    const ids = [...byId.keys()];

    const current = await moodStatus();
    const pending = ids.filter((id) => !current.has(id));
    const batch = pending.slice(0, BATCH_SIZE).map((id) => byId.get(id)!);

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const tagsByKey = await loadArtistTags();

    let done = 0;
    for (let i = 0; i < batch.length; i += MOOD_CHUNK_SIZE) {
      const chunk = batch.slice(i, i + MOOD_CHUNK_SIZE);
      try {
        const classified = await classifyReleaseChunk(client, chunk, tagsByKey);
        for (const [id, moods] of classified) {
          await storeMoods(id, { v: MOOD_VERSION, moods });
          done += 1;
        }
      } catch (err) {
        // Transient (rate limit / 5xx / network) — leave this chunk's ids pending.
        console.error("[cron hydrate-moods] chunk failed:", err instanceof Error ? err.message : err);
      }
    }

    return NextResponse.json({
      ok: true,
      hydratedThisRun: done,
      remaining: Math.max(0, pending.length - done),
      total: ids.length,
    });
  } catch (err) {
    console.error("[cron hydrate-moods] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Hydration failed" }, { status: 502 });
  }
}
