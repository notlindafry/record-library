import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { getCollection } from "@/lib/discogs";
import { descriptorStatus, getDescriptorIndex } from "@/lib/descriptors";
import {
  EMBEDDING_DIM,
  EMBEDDING_VERSION,
  buildEmbeddingText,
  embedDocuments,
  embeddingStatus,
  storeEmbedding,
} from "@/lib/embeddings";
import type { Record as ShelfRecord } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A bounded number of embedding calls per run, paced to finish within the
// function budget; the next run continues where this one stopped.
export const maxDuration = 60;

// Releases embedded per run. Bound the batch so the calls (batched or looped)
// plus their Redis writes finish inside maxDuration.
const BATCH_SIZE = 100;

/**
 * GET /api/cron/hydrate-embeddings
 *
 * Backfills per-release embedding vectors into Redis a bounded batch at a time,
 * mirroring hydrate-descriptors. Guarded by the cron secret. Idempotent and
 * resumable: it embeds only ids without a current-version vector, so repeated
 * runs (cron or manual) march through the collection and then just pick up new
 * records or an EMBEDDING_VERSION bump.
 *
 * Dependency guard: only embeds a release that already has a CURRENT-version
 * descriptor. Embedding a release whose descriptor is stale or missing would
 * waste the call and store a vector that needs regenerating, so those ids are
 * skipped and left for a later run (after the descriptor cron advances).
 *
 * Fails open: with no GEMINI_API_KEY there is nothing to generate, so it no-ops
 * and search keeps running on its lexical behavior. A Google failure on the
 * batch is transient, so those ids are simply left for the next run.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ ok: true, skipped: "GEMINI_API_KEY not configured" });
  }

  try {
    const { records } = await getCollection();

    // Distinct release ids (an embedding is keyed by id — two owners of the same
    // release share one entry), each with a representative record.
    const byId = new Map<string, ShelfRecord>();
    for (const r of records) if (!byId.has(r.id)) byId.set(r.id, r);

    // Dependency guard + text source: eligible ids are those with a current
    // descriptor; the composed embedded text needs that descriptor's text.
    const [currentDescriptors, descriptorText, existing] = await Promise.all([
      descriptorStatus(),
      getDescriptorIndex(records),
      embeddingStatus(),
    ]);

    const eligible = [...byId.keys()].filter((id) => currentDescriptors.has(id));
    const pending = eligible.filter((id) => !existing.has(id));

    // Build aligned (id, text) pairs for this batch. Skip any id whose descriptor
    // text is somehow absent (leave it pending) so texts and ids stay in lockstep.
    const work: { id: string; text: string }[] = [];
    for (const id of pending.slice(0, BATCH_SIZE)) {
      const record = byId.get(id);
      const descriptor = descriptorText.get(id);
      if (!record || !descriptor) continue;
      work.push({ id, text: buildEmbeddingText(record, descriptor) });
    }

    let done = 0;
    if (work.length > 0) {
      const vectors = await embedDocuments(work.map((w) => w.text));
      for (let i = 0; i < work.length; i++) {
        const vec = vectors[i];
        if (!vec) continue; // transient Google failure — leave this id pending
        await storeEmbedding(work[i].id, { v: EMBEDDING_VERSION, dim: EMBEDDING_DIM, vec });
        done += 1;
      }
    }

    return NextResponse.json({
      ok: true,
      hydratedThisRun: done,
      remaining: Math.max(0, pending.length - done),
      total: eligible.length,
    });
  } catch (err) {
    console.error("[cron hydrate-embeddings] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Hydration failed" }, { status: 502 });
  }
}
