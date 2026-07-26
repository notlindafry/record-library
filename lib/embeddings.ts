/**
 * Per-release embedding vectors (semantic recall).
 *
 * A dense vector per RELEASE, produced from a composed "artist - title (year).
 * genres. styles. descriptor" string, so search can match on MEANING rather than
 * on literal vocabulary overlap: a query for "heartbreak" can reach a descriptor
 * reading "romantic devastation". This is a recall path ALONGSIDE the existing
 * lexical scoring in lib/search.ts, never a replacement — vector similarity is
 * worse than substring matching at exact artist/title/label lookups.
 *
 * Shaped like lib/descriptors.ts:
 *   - Background hydration (see the hydrate-embeddings cron) fills one durable
 *     Redis hash, so the search read path stays cheap and every read fails open.
 *   - The read path is an in-memory map cached by a collection signature.
 *
 * Data model — one Redis hash `vs:release:embedding`:
 *   - Field: release id. Keyed by id, NOT owner+id: the vector describes the
 *     music, so two owners of the same release share one entry (matches how
 *     descriptors and tracklists key).
 *   - Value: { v, dim, vec } (JSON). `v` is the embedding version; bump it when
 *     the model, the dimensionality, or the embedded-text template changes, so
 *     stale vectors regenerate the same way DESCRIPTOR_VERSION works.
 *
 * Vectors are stored ALREADY unit-normalized, so cosine similarity is a plain
 * dot product on the read path (see lib/search.ts). `outputDimensionality`
 * truncation is normalized away here rather than relied upon.
 *
 * Vendor: Google Gemini embeddings, called over REST (embedContent /
 * batchEmbedContents) so the response shape is parsed defensively and no
 * client SDK is added. The API key is server-only (GEMINI_API_KEY), sent in the
 * x-goog-api-key header (never the URL), and never logged or returned to the
 * browser. Fails open everywhere: no key, unconfigured Redis, a missing vector,
 * or a Google error leaves search working exactly as it does today.
 */

import type { Record as ShelfRecord } from "@/lib/types";
import { fetchJson } from "@/lib/http";
import { isRedisConfigured, redis } from "@/lib/redis";

export const EMBEDDINGS_KEY = "vs:release:embedding";

/**
 * Embedding version. Bump when the model, the dimensionality, or the embedded
 * text template changes, so embeddingStatus() marks old vectors pending and the
 * hydrate-embeddings cron regenerates them.
 */
export const EMBEDDING_VERSION = 1;

/**
 * Output dimensionality (via `outputDimensionality`). 768 rather than the 3072
 * default: roughly 4x less storage and latency for no meaningful gain at this
 * collection size.
 */
export const EMBEDDING_DIM = 768;

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-embedding-001";
// Concurrency for the per-item fallback loop when batch embedding is unsupported.
const EMBED_CONCURRENCY = 5;
const EMBED_TIMEOUT_MS = 20_000;

/** Gemini task types. Document vectors and query vectors are embedded differently. */
type TaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

/** The stored shape: the vector plus the version and dimension that produced it. */
interface StoredEmbedding {
  v: number;
  dim: number;
  vec: number[];
}

/** True when the Gemini API key is present (server-side only). */
export function isEmbeddingConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

function embeddingModel(): string {
  return process.env.GEMINI_EMBEDDING_MODEL?.trim() || DEFAULT_MODEL;
}

/**
 * Compose the string that gets embedded for a release. Not the bare descriptor:
 * the artist/title/tags give the vector some grounding so near-miss artist
 * queries degrade gracefully. Bump EMBEDDING_VERSION if this template changes.
 */
export function buildEmbeddingText(record: ShelfRecord, descriptor: string): string {
  const year = record.year ? ` (${record.year})` : "";
  const genres = record.genres.join(", ");
  const styles = record.styles.join(", ");
  return `${record.artist} - ${record.title}${year}. ${genres}. ${styles}. ${descriptor}`
    .replace(/\s+/g, " ")
    .trim();
}

// ---- Vector math ----

/** Unit-normalize a vector, so cosine similarity reduces to a dot product. */
function normalize(vec: number[]): Float32Array {
  let sumSq = 0;
  for (const x of vec) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  const out = new Float32Array(vec.length);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  }
  return out;
}

// ---- Gemini REST (parsed defensively) ----

/**
 * Pull the `values` array out of one embedding object, tolerating both response
 * shapes the docs disagree on: `{ embedding: { values } }` (single) and the
 * `{ embeddings: [{ values }] }` element shape (batch).
 */
function readValues(obj: unknown): number[] | null {
  if (!obj || typeof obj !== "object") return null;
  const values = (obj as { values?: unknown }).values;
  if (!Array.isArray(values)) return null;
  const nums = values.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  return nums.length ? nums : null;
}

interface EmbedContentResponse {
  embedding?: unknown;
  embeddings?: unknown[];
}

/** Embed a single text via :embedContent. Returns the raw (un-normalized) vector. */
async function embedSingle(text: string, taskType: TaskType): Promise<number[] | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = embeddingModel();
  const url = `${GEMINI_API}/models/${model}:embedContent`;
  const body = JSON.stringify({
    model: `models/${model}`,
    content: { parts: [{ text }] },
    taskType,
    outputDimensionality: EMBEDDING_DIM,
  });

  const { data } = await fetchJson<EmbedContentResponse>(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body,
    timeoutMs: EMBED_TIMEOUT_MS,
  });

  // Single-call docs describe `{ embedding: {...} }`, but some examples log
  // `embeddings` (plural) even for one input — accept either.
  return readValues(data.embedding) ?? (Array.isArray(data.embeddings) ? readValues(data.embeddings[0]) : null);
}

interface BatchEmbedResponse {
  embeddings?: unknown[];
}

/**
 * Embed many texts in one :batchEmbedContents call. Returns raw vectors aligned
 * to `texts`. Throws on a shape or length mismatch so the caller can fall back
 * to the per-item loop.
 */
async function embedBatch(texts: string[], taskType: TaskType): Promise<number[][]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not configured");
  const model = embeddingModel();
  const url = `${GEMINI_API}/models/${model}:batchEmbedContents`;
  const body = JSON.stringify({
    requests: texts.map((text) => ({
      model: `models/${model}`,
      content: { parts: [{ text }] },
      taskType,
      outputDimensionality: EMBEDDING_DIM,
    })),
  });

  const { data } = await fetchJson<BatchEmbedResponse>(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body,
    timeoutMs: EMBED_TIMEOUT_MS,
  });

  const raw = Array.isArray(data.embeddings) ? data.embeddings : null;
  if (!raw || raw.length !== texts.length) {
    throw new Error("batchEmbedContents: unexpected response shape");
  }
  const out: number[][] = [];
  for (const item of raw) {
    const vec = readValues(item);
    if (!vec) throw new Error("batchEmbedContents: missing values in an element");
    out.push(vec);
  }
  return out;
}

// Whether batch embedding is usable. `null` = not yet probed; once a batch call
// fails (e.g. the model only accepts a single input per request) we latch to the
// per-item loop for the rest of the process's life.
let batchSupported: boolean | null = null;

function logEmbedError(context: string, err: unknown): void {
  // Never log the vector, the text, or the key — just the failure.
  console.error(`[embeddings] ${context}:`, err instanceof Error ? err.message : err);
}

/** Run an async mapper over items with a bounded concurrency. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

/**
 * Embed a list of texts, returning raw vectors (un-normalized) aligned to the
 * input, with `null` for any that failed. One runtime check decides the path:
 * try the batch endpoint first; if it errors, latch to a per-item loop with
 * small concurrency (handles the "single input per request" model limit). A
 * single text always uses the single endpoint. Fails open: an unconfigured key
 * yields all-null.
 */
async function rawEmbed(texts: string[], taskType: TaskType): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  if (!isEmbeddingConfigured()) return texts.map(() => null);

  if (texts.length > 1 && batchSupported !== false) {
    try {
      const vecs = await embedBatch(texts, taskType);
      batchSupported = true;
      return vecs;
    } catch (err) {
      logEmbedError("batch embed failed; falling back to per-item", err);
      batchSupported = false;
    }
  }

  return mapLimit(texts, EMBED_CONCURRENCY, (text) =>
    embedSingle(text, taskType).catch((err) => {
      logEmbedError("single embed failed", err);
      return null;
    }),
  );
}

// ---- Public embedding API (document vs query are separate code paths) ----

/**
 * Embed release documents for hydration (taskType RETRIEVAL_DOCUMENT). Returns
 * unit-normalized vectors as plain arrays aligned to `texts`, `null` per text on
 * failure. Ready to hand straight to storeEmbedding.
 */
export async function embedDocuments(texts: string[]): Promise<(number[] | null)[]> {
  const raw = await rawEmbed(texts, "RETRIEVAL_DOCUMENT");
  return raw.map((vec) => (vec ? Array.from(normalize(vec)) : null));
}

/**
 * Embed a search query (taskType RETRIEVAL_QUERY). Returns a unit-normalized
 * vector, or null when unconfigured / on any Google error — so search falls back
 * to the lexical path with no error surfaced. Callers pass the SANITIZED query.
 */
export async function embedQuery(text: string): Promise<Float32Array | null> {
  if (!text.trim() || !isEmbeddingConfigured()) return null;
  const raw = (await rawEmbed([text], "RETRIEVAL_QUERY"))[0];
  return raw ? normalize(raw) : null;
}

// ---- Store + status ----

/** Store a release's embedding. Keyed by release id (shared across owners). */
export async function storeEmbedding(id: string, entry: StoredEmbedding): Promise<void> {
  await redis().hset(EMBEDDINGS_KEY, { [id]: entry });
}

/**
 * Release ids that already have a CURRENT-version, correctly-dimensioned vector,
 * so the cron can compute what is pending or stale. Older versions or wrong
 * dimensions are treated as pending (regenerated). Fails open to empty.
 */
export async function embeddingStatus(): Promise<Set<string>> {
  const out = new Set<string>();
  if (!isRedisConfigured()) return out;
  try {
    const map = await redis().hgetall<Record<string, StoredEmbedding>>(EMBEDDINGS_KEY);
    if (!map) return out;
    for (const [id, value] of Object.entries(map)) {
      const entry = typeof value === "string" ? (JSON.parse(value) as StoredEmbedding) : value;
      if (
        entry &&
        typeof entry === "object" &&
        entry.v === EMBEDDING_VERSION &&
        entry.dim === EMBEDDING_DIM &&
        Array.isArray(entry.vec) &&
        entry.vec.length === EMBEDDING_DIM
      ) {
        out.add(id);
      }
    }
  } catch {
    // Fail open: treat everything as pending rather than blocking the backfill.
  }
  return out;
}

// ---- Read cache (recomputes when the collection changes) ----

let cache: { sig: string; index: Map<string, Float32Array> } | null = null;

/** Cheap order-insensitive-enough signature over release ids (as lib/descriptors.ts). */
function signature(records: ShelfRecord[]): string {
  let hash = 0;
  const seen = new Set<string>();
  let count = 0;
  for (const r of records) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    count += 1;
    const k = r.id;
    for (let i = 0; i < k.length; i++) hash = (hash * 31 + k.charCodeAt(i)) | 0;
  }
  return `${count}:${hash}`;
}

/**
 * Unit-normalized vectors keyed by release id, read once from Redis with a single
 * `hgetall` and cached in memory by a collection signature (mirrors
 * getDescriptorIndex). Only current-version, correctly-dimensioned entries are
 * included. Returns an empty map when Redis is unconfigured or on any read error
 * (search then runs on the lexical path). Only successful reads are cached, so a
 * transient error retries next time.
 */
export async function getEmbeddingIndex(records: ShelfRecord[]): Promise<Map<string, Float32Array>> {
  const sig = signature(records);
  if (cache && cache.sig === sig) return cache.index;
  if (!isRedisConfigured()) return new Map();

  const index = new Map<string, Float32Array>();
  try {
    const map = await redis().hgetall<Record<string, StoredEmbedding>>(EMBEDDINGS_KEY);
    if (map) {
      for (const [id, value] of Object.entries(map)) {
        const entry = typeof value === "string" ? (JSON.parse(value) as StoredEmbedding) : value;
        if (
          entry &&
          typeof entry === "object" &&
          entry.v === EMBEDDING_VERSION &&
          entry.dim === EMBEDDING_DIM &&
          Array.isArray(entry.vec) &&
          entry.vec.length === EMBEDDING_DIM
        ) {
          // Stored already-normalized; wrap without re-normalizing.
          index.set(id, Float32Array.from(entry.vec));
        }
      }
    }
  } catch (err) {
    logEmbedError("embedding index read failed", err);
    return new Map();
  }

  cache = { sig, index };
  return index;
}

/** Test/ops hook. */
export function clearEmbeddingCache(): void {
  cache = null;
}
