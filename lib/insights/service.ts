/**
 * Insights service (feature 6): the cron-side generation orchestration and the
 * read-side batch lookup. Both routes stay thin and call in here.
 *
 * Cost is held under the $3/month ceiling by decoupling generation from viewing:
 *   - `refreshInsights` (cron only) regenerates ONLY when the collection changed
 *     or the batch is stale, behind a lock and a per-day cap, then caches the
 *     result. Repeated cron runs on an unchanged shelf are a no-op — zero Claude
 *     calls.
 *   - `getInsights` (read path) serves the cached batch and NEVER calls Claude;
 *     it falls back to code-computed stat cards when nothing is cached.
 *
 * Redis keys live in the `vs:` namespace. Everything fails open / degrades: no
 * Redis means the cron is a no-op and the read path serves stat cards.
 */

import { getCollection } from "@/lib/discogs";
import { isRedisConfigured, redis } from "@/lib/redis";
import type { InsightsResponse, Insight } from "@/lib/types";
import {
  allowedActionValues,
  buildAggregate,
  collectionHash,
  statCards,
} from "@/lib/insights/aggregate";
import { generateInsights } from "@/lib/insights/generate";

// Redis keys / TTLs.
const CURRENT_KEY = "vs:insights:current";
const LOCK_KEY = "vs:insights:lock";
const LOCK_TTL_SECONDS = 120; // auto-expires so a crashed run can't wedge the lock
const CAP_TTL_SECONDS = 60 * 60 * 26; // just over a day, so the daily counter cleans itself up

// Regeneration gate defaults (both overridable via env).
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // freshness/variety ceiling
const DEFAULT_DAILY_CAP = 8; // ~$0.011/gen * 8 * 30 stays under the $3 ceiling

/** The cached batch shape. */
interface InsightsBatch {
  generatedAt: number;
  collectionHash: string;
  insights: Insight[];
}

/** Max age before the cron regenerates even on an unchanged shelf. */
function maxAgeMs(): number {
  const raw = Number(process.env.INSIGHTS_MAX_AGE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AGE_MS;
}

/** Per-day generation cap (cost safety-belt). */
function dailyCap(): number {
  const raw = Number(process.env.INSIGHTS_DAILY_CAP);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_DAILY_CAP;
}

function todayUTC(): string {
  const d = new Date();
  return (
    `${d.getUTCFullYear()}-` +
    `${String(d.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getUTCDate()).padStart(2, "0")}`
  );
}

export interface RefreshResult {
  ok: true;
  /** Number of insights generated and cached, when a generation ran. */
  generated?: number;
  /** Why the run was a no-op, when it did not generate. */
  skipped?: string;
}

/**
 * Cron-triggered generation. Regenerates only when the shelf changed or the batch
 * is stale, behind the daily cap and a lock, then caches the result. Any other
 * outcome is a cheap no-op. Requires Redis and an Anthropic key; without either
 * the read path still serves stat cards.
 */
export async function refreshInsights(): Promise<RefreshResult> {
  if (!isRedisConfigured()) return { ok: true, skipped: "redis not configured" };
  if (!process.env.ANTHROPIC_API_KEY) return { ok: true, skipped: "no anthropic key" };

  const { records } = await getCollection();
  if (records.length === 0) return { ok: true, skipped: "no collection cached" };

  const hash = collectionHash(records);

  let current: InsightsBatch | null = null;
  try {
    current = await redis().get<InsightsBatch>(CURRENT_KEY);
  } catch (err) {
    console.error("[insights] current read failed:", err instanceof Error ? err.message : err);
  }

  const stale =
    !current ||
    current.collectionHash !== hash ||
    Date.now() - current.generatedAt > maxAgeMs();
  if (!stale) return { ok: true, skipped: "unchanged and fresh" };

  // Lock so two overlapping runs cannot double-generate. Best-effort; auto-expires.
  let gotLock = false;
  try {
    gotLock = (await redis().set(LOCK_KEY, "1", { nx: true, ex: LOCK_TTL_SECONDS })) === "OK";
  } catch (err) {
    console.error("[insights] lock step failed:", err instanceof Error ? err.message : err);
  }
  if (!gotLock) return { ok: true, skipped: "locked" };

  try {
    // COST SAFETY-BELT: bound generations per day so a bug or retry storm cannot run
    // away with spend. Counted under the lock, so only real generation attempts
    // consume the budget. Choose the cap so CAP * per_generation_cost * 30 stays
    // under the $3 ceiling (~8/day at ~$0.011/gen). The hash/staleness gate keeps
    // real generations far below this; this is only a backstop.
    const capKey = `vs:insights:gencount:${todayUTC()}`;
    const used = await redis().incr(capKey);
    if (used === 1) await redis().expire(capKey, CAP_TTL_SECONDS);
    if (used > dailyCap()) return { ok: true, skipped: "daily cap reached" };

    const aggregate = buildAggregate(records);
    const allowed = allowedActionValues(records);
    const insights = await generateInsights(aggregate, allowed);

    if (insights.length > 0) {
      const batch: InsightsBatch = { generatedAt: Date.now(), collectionHash: hash, insights };
      await redis().set(CURRENT_KEY, batch);
    }
    return { ok: true, generated: insights.length };
  } finally {
    await redis().del(LOCK_KEY).catch(() => undefined); // lock also auto-expires
  }
}

/**
 * Read path: the cached batch, or code-computed stat cards when nothing is cached.
 * Never calls Claude.
 */
export async function getInsights(): Promise<InsightsResponse> {
  if (isRedisConfigured()) {
    try {
      const batch = await redis().get<InsightsBatch>(CURRENT_KEY);
      if (batch && Array.isArray(batch.insights) && batch.insights.length > 0) {
        return { insights: batch.insights, generatedAt: batch.generatedAt };
      }
    } catch (err) {
      console.error("[insights] batch read failed:", err instanceof Error ? err.message : err);
    }
  }

  // Fallback: derive stat cards from the (cached) collection. No Claude call.
  const { records } = await getCollection();
  const aggregate = buildAggregate(records);
  return { insights: statCards(aggregate), generatedAt: Date.now(), fallback: true };
}
