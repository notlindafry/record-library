/**
 * Natural-language, vibe-aware search over the merged catalogue.
 *
 * Two-step pipeline (same shape as recipefinder), with a keyword fallback when
 * no ANTHROPIC_API_KEY is set:
 *   1. Understand — Claude turns the sentence into a record QuerySpec. It is
 *      given the styles and owners present and the vibe-to-style map, and is
 *      told to translate feeling words into styles and loose genre words onto
 *      real Discogs genres/styles. We do NOT send the rows.
 *   2. Prefilter — a fast local pass filters and scores candidates against the
 *      spec, with owner as a hard filter alongside genre/style/mood.
 *   3. Rerank — Claude reranks the top candidates and writes a one-line reason.
 *
 * Everything runs server-side. The Anthropic key never reaches the browser.
 */

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { QuerySpec, Record as ShelfRecord, SearchResult } from "@/lib/types";
import { MOODS, expandMoodsToStyles, presentGenres, presentOwners, presentStyles } from "@/lib/vocab";
import { getMoodIndex, type MoodIndex } from "@/lib/moods";
import { normArtist } from "@/lib/lastfm";
import { isRedisConfigured, redis } from "@/lib/redis";
import { songSearch } from "@/lib/tracks";
import { getDescriptorIndex } from "@/lib/descriptors";
import { embedQuery, getEmbeddingIndex } from "@/lib/embeddings";

const MAX_QUERY_LEN = 300;
// Weight of a Last.fm sonic match: a strong match (~1.0) scores ~2.5, edging just
// past a single shared Discogs style (2). A starting point, like VIBE_TO_STYLE.
const SIMILAR_WEIGHT = 2.5;
// Records handed to the rerank step. Cut from 60 to 30 now that semantic recall
// tightens prefilter precision: a smaller, better candidate set keeps the
// rerank token cost down. If 30 measurably degrades results, tune the semantic
// weighting rather than raising this back up.
const CANDIDATE_LIMIT = 30;
const RESULT_LIMIT = 30; // results returned to the client
const STYLE_HINT_LIMIT = 400; // cap on styles sent to the understand step
// Weight of a query keyword found in a record's descriptor. Just below a literal
// title keyword (which adds 1) so a real title hit still outranks a purely
// thematic one at equal strength, while a descriptor-only match still pushes the
// score above zero so the record survives to the candidate set.
const DESCRIPTOR_WEIGHT = 0.9;
// A record whose style is implied by a query mood (via VIBE_TO_STYLE, e.g. Disco
// for "happy"). Below a genre hit (1.5): a mood-implied style is a softer signal
// than an explicit genre, but still enough to carry the record into the candidate
// set. This is the deterministic recall path that works with no API key.
const MOOD_STYLE_WEIGHT = 1.25;
// A record the mood index actually tagged with a query mood — a judged "this feels
// happy", stronger than a merely style-implied match.
const MOOD_INDEX_WEIGHT = 1.5;
// Weight of a semantic (embedding) match. A strong match (~1.0) scores ~2.5,
// landing just past a single shared Discogs style (2) but below an artist-name
// hit (3): meaning-level relevance is strong recall but should not outrank a
// literal artist match. A starting point, like VIBE_TO_STYLE and SIMILAR_WEIGHT.
const SEMANTIC_WEIGHT = 2.5;
// Cosine floor below which a semantic match scores nothing — noise otherwise.
// Vectors are unit-normalized, so cosine is a plain dot product in [-1, 1].
const SEMANTIC_FLOOR = 0.35;
const QSPEC_VERSION = 2; // bump when the understand-step prompt changes
const QSPEC_TTL_SECONDS = 3 * 24 * 60 * 60; // ~3 days; version+model in the key protect correctness

function model(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5";
}

export function aiSearchEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** Clamp and sanitise the incoming query (rule 4). */
export function sanitizeQuery(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LEN);
}

function emptySpec(): QuerySpec {
  return { genres: [], styles: [], moods: [], owners: [], artists: [], keywords: [], excludeStyles: [] };
}

function norm(value: string): string {
  return value.toLowerCase().trim();
}

// ---- Step 1a: understand via Claude ----

/** Tolerantly pull a JSON object out of a model response. */
function extractJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Fall back to the first balanced-looking {...} span.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function buildUnderstandSystem(records: ShelfRecord[]): string {
  const genres = presentGenres(records);
  const styles = presentStyles(records).slice(0, STYLE_HINT_LIMIT);
  const owners = presentOwners(records);

  return [
    "You translate a natural-language request about a vinyl record collection into a structured search spec.",
    "The collection is tagged with Discogs genres and styles. 'Mood' is derived at query time — never stored.",
    "",
    "Rules:",
    "- Map feeling/vibe words (e.g. 'angry', 'chill', 'music for a rainy night') to entries in MOODS when they fit.",
    "- Map loose genre words onto real GENRES or STYLES present in the collection. Prefer STYLES for specificity.",
    "- Only use genre/style/owner/mood values from the provided lists. Do not invent tags.",
    "- If the request names a collection owner, put the matching OWNER label in `owners`.",
    "- Put artist names in `artists` and any remaining free-text terms (album titles, words) in `keywords`.",
    "- Keep salient topic/subject words in `keywords` even when they ALSO map to a mood, genre, or style, and even when they map to none. Subject matter is searchable via per-record descriptors, so these words matter. E.g. 'mad at the government' -> moods: [\"angry\"], keywords: [\"government\"]; 'songs about heartbreak' -> keywords: [\"heartbreak\"]; 'music for a rainy drive' -> keywords: [\"rain\"].",
    "- Use `excludeStyles` for explicit negations (e.g. 'but no metal').",
    "- Leave arrays empty when nothing applies. Do not guess wildly; an empty spec is fine for a vague query.",
    "",
    "Respond with ONLY a JSON object (no prose, no markdown) with these array-of-string keys:",
    "genres, styles, moods, owners, artists, keywords, excludeStyles.",
    "",
    `GENRES: ${genres.join(", ") || "(none)"}`,
    `STYLES: ${styles.join(", ") || "(none)"}`,
    `OWNERS: ${owners.join(", ") || "(none)"}`,
    `MOODS: ${MOODS.join(", ")}`,
  ].join("\n");
}

/**
 * Cache key for a parsed QuerySpec. The prompt version and model live in the key
 * so a prompt change or model swap never serves a stale parse; the query is
 * normalized (lowercased — it is already trimmed, whitespace-collapsed, and
 * capped by `sanitizeQuery`) and hashed, so raw query strings are not stored as
 * keys.
 */
function qspecKey(query: string): string {
  const hash = createHash("sha256").update(query.toLowerCase()).digest("hex").slice(0, 32);
  return `vs:qspec:v${QSPEC_VERSION}:${model()}:${hash}`;
}

/**
 * Understand step with a Redis read-through cache (feature 3). On a hit we skip
 * the Claude parse entirely; on a miss we parse and cache. Fails open: any Redis
 * error runs the live parse. Only the server writes entries, and only after its
 * own parse, so there is no client-controlled path into the cache.
 */
async function understandCached(
  client: Anthropic,
  query: string,
  records: ShelfRecord[],
): Promise<QuerySpec> {
  const key = qspecKey(query);

  if (isRedisConfigured()) {
    try {
      const cached = await redis().get<QuerySpec>(key);
      if (cached) return normalizeSpec(cached);
    } catch (err) {
      console.error("[search] qspec cache read failed:", err instanceof Error ? err.message : err);
    }
  }

  const spec = await understandWithClaude(client, query, records);

  if (isRedisConfigured()) {
    // Fire-and-forget: don't make the response wait on the cache write.
    redis()
      .set(key, spec, { ex: QSPEC_TTL_SECONDS })
      .catch((err) =>
        console.error("[search] qspec cache write failed:", err instanceof Error ? err.message : err),
      );
  }

  return spec;
}

async function understandWithClaude(
  client: Anthropic,
  query: string,
  records: ShelfRecord[],
): Promise<QuerySpec> {
  const response = await client.messages.create({
    model: model(),
    max_tokens: 700,
    system: buildUnderstandSystem(records),
    messages: [{ role: "user", content: query }],
  });

  const text = firstText(response);
  if (!text) return emptySpec();
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object") return emptySpec();
  return normalizeSpec(parsed as Partial<QuerySpec>);
}

function firstText(response: Anthropic.Message): string | null {
  for (const block of response.content) {
    if (block.type === "text") return block.text;
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
}

function normalizeSpec(raw: Partial<QuerySpec>): QuerySpec {
  return {
    genres: asStringArray(raw.genres),
    styles: asStringArray(raw.styles),
    moods: asStringArray(raw.moods),
    owners: asStringArray(raw.owners),
    artists: asStringArray(raw.artists),
    keywords: asStringArray(raw.keywords),
    excludeStyles: asStringArray(raw.excludeStyles),
  };
}

// ---- Step 1b: keyword fallback (no API key) ----

function understandWithKeywords(query: string, records: ShelfRecord[]): QuerySpec {
  const lower = norm(query);
  const tokens = lower.split(/[^a-z0-9&/+-]+/i).filter((t) => t.length >= 2);
  const tokenSet = new Set(tokens);

  const genreSet = new Map(presentGenres(records).map((g) => [norm(g), g]));
  const styleSet = new Map(presentStyles(records).map((s) => [norm(s), s]));
  const ownerSet = new Map(presentOwners(records).map((o) => [norm(o), o]));

  const spec = emptySpec();

  // Multi-word genre/style names: substring match against the whole query.
  for (const [key, value] of genreSet) if (lower.includes(key)) spec.genres.push(value);
  for (const [key, value] of styleSet) if (lower.includes(key)) spec.styles.push(value);
  for (const [key, value] of ownerSet) if (tokenSet.has(key) || lower.includes(key)) spec.owners.push(value);
  for (const mood of MOODS) if (tokenSet.has(mood)) spec.moods.push(mood);

  // Everything else becomes a keyword to match against artist/title/label.
  spec.keywords = tokens;
  return spec;
}

// ---- Step 2: local prefilter + scoring ----

interface Scored {
  record: ShelfRecord;
  score: number;
}

function scoreRecords(
  spec: QuerySpec,
  records: ShelfRecord[],
  moodIndex?: MoodIndex | null,
  descriptors?: Map<string, string> | null,
  facetMoods: string[] = [],
  semantic?: Map<string, number> | null,
): Scored[] {
  const genres = new Set(spec.genres.map(norm));
  const owners = new Set(spec.owners.map(norm));
  const artists = spec.artists.map(norm).filter(Boolean);
  const keywords = spec.keywords.map(norm).filter(Boolean);
  const excludeStyles = new Set((spec.excludeStyles ?? []).map(norm));
  const explicitStyles = spec.styles.map(norm);

  const selectedMoods = Array.from(new Set(spec.moods.map(norm)));
  // Two kinds of mood. Moods the user explicitly picked from the Mood facet are a
  // deliberate HARD filter (AND) against the mood index. Moods merely inferred
  // from free text ("happy", "evening mellow") are SOFT: they broaden, not
  // restrict — otherwise a single vibe word silently discards most of the shelf.
  const hardMoodSet = new Set(facetMoods.map(norm));
  const hardMoods = selectedMoods.filter((m) => hardMoodSet.has(m));
  const softMoods = selectedMoods.filter((m) => !hardMoodSet.has(m));
  const hasHardMood = hardMoods.length > 0 && !!moodIndex;

  // Deterministic recall path: expand soft moods to the styles they imply
  // (VIBE_TO_STYLE, restricted to styles actually present), so a vibe query scores
  // records with the right style even when the mood index never tagged them — and
  // even when there is no API key or hydrated data at all.
  const moodStyles = new Set(softMoods.length ? expandMoodsToStyles(softMoods, records).map(norm) : []);

  // Semantic recall is a content constraint too: a record can qualify on its
  // embedding match ALONE, even when the understand step produced no keywords,
  // genres, or styles (a pure-vibe query). Without this the pure-browse branch
  // below would flatten every score to 0 and vector-only matches would never
  // surface. This is the single easiest thing to get wrong in this change.
  const hasSemantic = !!semantic && semantic.size > 0;

  // Genre / style / artist / keyword / soft-mood / semantic are scored as an OR
  // pool; only explicitly-picked mood facets act as a hard AND filter.
  const hasContentConstraint =
    genres.size > 0 ||
    explicitStyles.length > 0 ||
    artists.length > 0 ||
    keywords.length > 0 ||
    softMoods.length > 0 ||
    hasSemantic;
  const hasAnyConstraint = hasContentConstraint || hasHardMood;

  const scored: Scored[] = [];

  for (const record of records) {
    // Hard filter: owner.
    if (owners.size > 0 && !owners.has(norm(record.owner))) continue;

    const recStyles = record.styles.map(norm);
    // Hard filter: excluded styles.
    if (excludeStyles.size > 0 && recStyles.some((s) => excludeStyles.has(s))) continue;

    // Hard filter: mood FACETS (AND) — the record must be tagged with every
    // explicitly-selected mood.
    const recMoods = moodIndex ? moodIndex.get(record) : null;
    if (hasHardMood && !hardMoods.every((m) => recMoods!.has(m))) continue;

    if (!hasAnyConstraint) {
      // Pure browse (e.g. owner-only or empty query): keep everything, flat score.
      scored.push({ record, score: 0 });
      continue;
    }

    let score = 0;
    const recGenres = record.genres.map(norm);
    const haystack = `${norm(record.artist)} ${norm(record.title)} ${norm(record.label)}`;

    for (const g of recGenres) if (genres.has(g)) score += 1.5;
    for (const s of recStyles) if (explicitStyles.includes(s)) score += 2;
    for (const a of artists) if (haystack.includes(a)) score += 3;
    for (const k of keywords) if (haystack.includes(k)) score += 1;
    // Subject-matter match: a query keyword found in the record's descriptor.
    // This is what lets a record qualify on theme alone (e.g. Propagandhi for
    // "mad at the government"), surviving the prefilter to reach the rerank step.
    if (descriptors) {
      const descriptor = descriptors.get(record.id)?.toLowerCase();
      if (descriptor) for (const k of keywords) if (descriptor.includes(k)) score += DESCRIPTOR_WEIGHT;
    }
    // Semantic match: cosine of the query and this record's embedding, already
    // floored at SEMANTIC_FLOOR by the caller. This is what lets a record qualify
    // on MEANING when its wording never appears lexically. Additive, so a record
    // that also hits lexically outscores one that hits only semantically.
    if (semantic) {
      const cosine = semantic.get(record.id);
      if (cosine) score += SEMANTIC_WEIGHT * cosine;
    }
    // Soft-mood recall: score a record whose style is implied by the vibe, and
    // more so when the mood index actually judged the record to carry that mood.
    if (softMoods.length) {
      for (const s of recStyles) if (moodStyles.has(s)) score += MOOD_STYLE_WEIGHT;
      if (recMoods) for (const m of softMoods) if (recMoods.has(m)) score += MOOD_INDEX_WEIGHT;
    }
    // A passed hard-mood facet is a positive signal too, so mood-only facet
    // browses surface above pure genre noise.
    if (hasHardMood) score += hardMoods.length * MOOD_INDEX_WEIGHT;

    if (score > 0) scored.push({ record, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tie-break: newer first, then title.
    const ay = a.record.year ?? 0;
    const by = b.record.year ?? 0;
    if (by !== ay) return by - ay;
    return a.record.title.localeCompare(b.record.title);
  });

  return scored;
}

// ---- Step 3: rerank via Claude ----

interface RerankItem {
  id: string;
  reason: string;
}

async function rerankWithClaude(
  client: Anthropic,
  query: string,
  candidates: ShelfRecord[],
  descriptors?: Map<string, string> | null,
): Promise<SearchResult[] | null> {
  // Give the model a compact view — never the whole collection.
  const compact = candidates.map((r) => {
    const base = {
      id: r.id,
      artist: r.artist,
      title: r.title,
      year: r.year,
      genres: r.genres,
      styles: r.styles,
      owner: r.owner,
    };
    const descriptor = descriptors?.get(r.id);
    return descriptor ? { ...base, descriptor } : base;
  });

  const system = [
    "You are re-ranking vinyl records for a natural-language request.",
    "From the CANDIDATES, return the best matches most-relevant first.",
    "For each, write a short one-line reason (max ~16 words) tying it to the request — mention genre/style/mood/owner where relevant.",
    "Some candidates include a `descriptor`: a short vibe/subject summary of the release. Use it to judge fit and to write the one-line reason (name the actual theme when it matches), but treat it as a search aid, not an authoritative fact — do not quote it as a claim about the artist.",
    "Only include records that genuinely fit. Do not invent ids. Return at most 30.",
    "",
    'Respond with ONLY a JSON object (no prose, no markdown): {"results": [{"id": "<id>", "reason": "<one line>"}]}.',
  ].join("\n");

  const user = `REQUEST: ${query}\n\nCANDIDATES (JSON):\n${JSON.stringify(compact)}`;

  const response = await client.messages.create({
    model: model(),
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: user }],
  });

  const text = firstText(response);
  if (!text) return null;

  const parsed = extractJsonObject(text) as { results?: RerankItem[] } | null;
  const items: RerankItem[] = parsed && Array.isArray(parsed.results) ? parsed.results : [];

  const byId = new Map(candidates.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const item of items) {
    if (!item || typeof item.id !== "string") continue;
    if (seen.has(item.id)) continue;
    const record = byId.get(item.id);
    if (!record) continue;
    seen.add(item.id);
    results.push({ record, reason: sanitizeReason(item.reason) });
    if (results.length >= RESULT_LIMIT) break;
  }
  return results;
}

function sanitizeReason(reason: unknown): string {
  if (typeof reason !== "string") return "";
  return reason.replace(/\s+/g, " ").trim().slice(0, 160);
}

// ---- Local reason (fallback / when rerank unavailable) ----

function localReason(record: ShelfRecord, spec: QuerySpec): string {
  const tags = [...record.styles.slice(0, 2), ...record.genres.slice(0, 1)];
  const bits: string[] = [];
  if (tags.length) bits.push(tags.join(" · "));
  if (spec.owners.length) bits.push(record.owner);
  return bits.join(" — ") || `${record.genres[0] ?? "Record"} from ${record.owner}`;
}

// ---- Orchestration ----

export interface SearchOptions {
  /** Restrict to these owner labels (from the owner facet), applied as a hard filter. */
  owners?: string[];
  /** Restrict to these genres (facet). */
  genres?: string[];
  /** Restrict to these styles (facet). */
  styles?: string[];
  /** Restrict to these moods (facet). */
  moods?: string[];
}

/** Merge explicit facet selections into a spec derived from the query. */
function mergeFacets(spec: QuerySpec, options: SearchOptions): QuerySpec {
  const uniq = (a: string[], b: string[]) => Array.from(new Set([...a, ...b]));
  return {
    ...spec,
    owners: uniq(spec.owners, options.owners ?? []),
    genres: uniq(spec.genres, options.genres ?? []),
    styles: uniq(spec.styles, options.styles ?? []),
    moods: uniq(spec.moods, options.moods ?? []),
  };
}

export interface SearchOutcome {
  results: SearchResult[];
  spec: QuerySpec;
  reranked: boolean;
  /** True when results came from the deterministic song-title match (feature 5). */
  songMatch?: boolean;
}

// ---- Song lookup routing (feature 5) ----

/**
 * Detect an explicit "which record is <song> on" style query and pull out the
 * song term; null for ordinary vibe/genre queries so they stay on the normal
 * pipeline. Deliberately conservative — the user opts in via phrasing (a
 * song:/track: prefix, quotes, or a "which record … is X on" question) so plain
 * keyword searches are never hijacked.
 */
function extractSongTerm(query: string): string | null {
  const q = query.trim();
  const tidy = (s: string): string | null => {
    const cleaned = s.replace(/["“”']/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
    return cleaned || null;
  };

  let m = q.match(/^(?:song|track)\s*[:=]\s*(.+)$/i);
  if (m) return tidy(m[1]);

  m = q.match(/^["“'](.+)["”']$/);
  if (m) return tidy(m[1]);

  m = q.match(/\b(?:song|track)\s+(?:called|named|titled)\s+(.+)$/i);
  if (m) return tidy(m[1]);

  m = q.match(
    /\b(?:which|what)\b.*?\b(?:record|album|lp|release|vinyl)s?\b.*?\b(?:is|are|has|have|contains?|features?|includes?|got|with)\b\s+(.+?)(?:\s+on\b.*)?[?.!]*$/i,
  );
  if (m) return tidy(m[1]);

  return null;
}

/**
 * Cosine of the query vector against every distinct record's embedding, keeping
 * only matches at or above SEMANTIC_FLOOR. Vectors are unit-normalized, so cosine
 * is a plain dot product. Empty when there is no query vector or no index —
 * semantic recall then contributes nothing and search stays fully lexical.
 */
function semanticScores(
  queryVec: Float32Array | null,
  index: Map<string, Float32Array>,
  records: ShelfRecord[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (!queryVec || index.size === 0) return out;
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    const vec = index.get(record.id);
    if (!vec || vec.length !== queryVec.length) continue;
    let dot = 0;
    for (let i = 0; i < queryVec.length; i++) dot += queryVec[i] * vec[i];
    if (dot >= SEMANTIC_FLOOR) out.set(record.id, dot);
  }
  return out;
}

export async function searchRecords(
  rawQuery: string,
  records: ShelfRecord[],
  options: SearchOptions = {},
): Promise<SearchOutcome> {
  const query = sanitizeQuery(rawQuery);
  const hasFacets = Boolean(
    options.owners?.length || options.genres?.length || options.styles?.length || options.moods?.length,
  );

  // Song lookup (feature 5): an explicit "which record is X on" query matches
  // hydrated track titles deterministically — exact and free — before the vibe
  // pipeline. Falls through to normal search when nothing matches (e.g. not yet
  // hydrated), so the box still does something.
  if (query && !hasFacets) {
    const songTerm = extractSongTerm(query);
    if (songTerm) {
      const songResults = await songSearch(songTerm, records);
      if (songResults.length > 0) {
        return {
          results: songResults,
          spec: { ...emptySpec(), keywords: [songTerm] },
          reranked: false,
          songMatch: true,
        };
      }
    }
  }

  // Understand.
  let spec: QuerySpec;
  let client: Anthropic | null = null;
  if (aiSearchEnabled() && query) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    try {
      spec = await understandCached(client, query, records);
    } catch {
      spec = understandWithKeywords(query, records);
      client = null; // fall through to non-AI path for reasons
    }
  } else {
    spec = query ? understandWithKeywords(query, records) : emptySpec();
  }

  spec = mergeFacets(spec, options);

  // Nothing to search on at all → return an empty, deterministic result.
  if (!query && !hasFacets) {
    return { results: [], spec, reranked: false };
  }

  // For a natural-language query, load three read-path inputs in parallel:
  //   - the descriptor index (lexical subject-matter matching + the rerank read),
  //   - the embedding index and the embedded query vector (semantic recall).
  // Every read fails open: a missing descriptor index, an unconfigured/erroring
  // Gemini, or an unconfigured Redis each degrades to the prior behavior, and
  // search still runs on tags and titles. Errors are logged server-side; nothing
  // about a provider ever reaches the client.
  let descriptors: Map<string, string> = new Map();
  let semantic: Map<string, number> | null = null;
  if (query) {
    const [descResult, embeddingIndex, queryVec] = await Promise.all([
      getDescriptorIndex(records).catch((err) => {
        console.error("[search] descriptor read failed:", err instanceof Error ? err.message : err);
        return new Map<string, string>();
      }),
      getEmbeddingIndex(records), // fails open to an empty map internally
      embedQuery(query), // fails open to null internally
    ]);
    descriptors = descResult;
    semantic = semanticScores(queryVec, embeddingIndex, records);
  }

  // Prefilter + score. When moods are in play, classify (or reuse cached) moods
  // for the collection so the facet AND filter (and the soft-mood bonus) can use
  // Claude's per-record tags. Only moods picked from the facet act as a hard
  // filter; moods inferred from the query broaden results instead.
  const moodIndex = spec.moods.length > 0 ? await getMoodIndex(records) : null;
  const scored = scoreRecords(spec, records, moodIndex, descriptors, options.moods ?? [], semantic);
  const candidates = scored.slice(0, CANDIDATE_LIMIT).map((s) => s.record);

  if (candidates.length === 0) {
    return { results: [], spec, reranked: false };
  }

  // Rerank (only worthwhile when there's a natural-language query to interpret).
  if (client && query) {
    try {
      const reranked = await rerankWithClaude(client, query, candidates, descriptors);
      if (reranked && reranked.length > 0) {
        return { results: reranked, spec, reranked: true };
      }
    } catch {
      // fall through to local ordering
    }
  }

  const results = candidates
    .slice(0, RESULT_LIMIT)
    .map((record) => ({ record, reason: localReason(record, spec) }));
  return { results, spec, reranked: false };
}

/**
 * Similar-by-style, optionally widened by Last.fm sonic similarity. A candidate
 * qualifies when it shares a STYLE with the seed, is by the same artist, OR its
 * artist is in `similarArtists` — the seed's Last.fm similar-artist map (normalized
 * artist name → 0..1 match). This connects records that sound alike even when
 * their Discogs style tags diverge. A shared broad GENRE (e.g. "Rock") still does
 * NOT qualify a record on its own; genre overlap is only a minor tiebreak.
 *
 * When `similarArtists` is empty (no key / not hydrated / read failed), the Last.fm
 * terms are inert and behavior degrades to exactly the pure style/artist path.
 */
export function similarRecords(
  seed: ShelfRecord,
  records: ShelfRecord[],
  similarArtists: Map<string, number> = new Map(),
  limit = 20,
): SearchResult[] {
  const seedStyles = new Set(seed.styles.map(norm));
  const seedGenres = new Set(seed.genres.map(norm));
  const seedArtist = norm(seed.artist);

  const scored: Scored[] = [];
  for (const record of records) {
    if (record.id === seed.id && record.owner === seed.owner) continue;

    let sharedStyles = 0;
    for (const s of record.styles) if (seedStyles.has(norm(s))) sharedStyles += 1;
    const sameArtist = norm(record.artist) === seedArtist;
    const match = similarArtists.get(normArtist(record.artist)) ?? 0;

    // Qualify on a shared style, the same artist, or a Last.fm sonic match.
    if (sharedStyles === 0 && !sameArtist && match <= 0) continue;

    let score = sharedStyles * 2;
    if (sameArtist) score += 1.5;
    if (match > 0) score += SIMILAR_WEIGHT * match;

    let sharedGenres = 0;
    for (const g of record.genres) if (seedGenres.has(norm(g))) sharedGenres += 1;
    score += sharedGenres * 0.25; // minor tiebreak only

    scored.push({ record, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ay = a.record.year ?? 0;
    const by = b.record.year ?? 0;
    if (by !== ay) return by - ay;
    return a.record.title.localeCompare(b.record.title);
  });

  return scored.slice(0, limit).map(({ record }) => ({
    record,
    reason: similarReason(record, seed, similarArtists),
  }));
}

/**
 * Most informative reason first: shared styles, then same artist, then a Last.fm
 * match (worded by strength), then a shared genre, then the owner. With an empty
 * map the Last.fm branch never fires, so this matches the old style-only reason.
 */
function similarReason(record: ShelfRecord, seed: ShelfRecord, similarArtists: Map<string, number>): string {
  const seedStyles = new Set(seed.styles.map(norm));
  const shared = record.styles.filter((s) => seedStyles.has(norm(s))).slice(0, 3);
  if (shared.length) return `Shares ${shared.join(" · ")}`;
  if (norm(record.artist) === norm(seed.artist)) return "Same artist";
  const match = similarArtists.get(normArtist(record.artist)) ?? 0;
  if (match > 0) {
    return match >= 0.5
      ? `Similar sound to ${seed.artist}`
      : `In the same listening world as ${seed.artist}`;
  }
  const seedGenres = new Set(seed.genres.map(norm));
  const sharedG = record.genres.filter((g) => seedGenres.has(norm(g))).slice(0, 2);
  if (sharedG.length) return `Shares ${sharedG.join(" · ")}`;
  return `Also ${record.owner}'s`;
}
