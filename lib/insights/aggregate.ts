/**
 * Aggregate computation for the insights carousel (feature 6).
 *
 * Pure functions over the merged `Record[]` already cached in Redis (feature 1) —
 * no Discogs or Claude calls. `buildAggregate` produces the compact contract the
 * model interprets; `collectionHash` gives the cron a stable identity to decide
 * whether the shelf changed; `allowedActionValues` is the validator's allowlist
 * (a tap-to-search action may only reference a genre/style/owner actually in the
 * data); `statCards` is the code-computed fallback the read route serves before
 * the first generation.
 *
 * We compute what we have cleanly and omit angles we cannot derive (no extremes
 * without a release year; no overlap with fewer than two shelves) rather than
 * fabricating values to fill the shape.
 */

import { createHash } from "node:crypto";
import type { Insight, InsightAction, Record as ShelfRecord } from "@/lib/types";
import { presentGenres, presentOwners, presentStyles } from "@/lib/vocab";

/**
 * How many insight cards the carousel shows. Single source of truth: the
 * generation prompt asks for this many, the parser caps the model batch at it,
 * the read path trims any cached batch to it, and the code-computed fallback is
 * capped to it. Trimming on read matters because a batch cached under an older,
 * larger count is served verbatim until it is regenerated, so the cap has to be
 * enforced at read time, not only at generation time.
 */
export const INSIGHTS_COUNT = 4;

// Bounds that keep the model input small and cheap.
const TOP_LIST_LIMIT = 15;
const PER_OWNER_LIMIT = 5;
const SHARED_ARTIST_LIMIT = 15;

export interface OwnerCount {
  label: string;
  record_count: number;
}
export interface NamedShare {
  name: string;
  count: number;
  pct: number;
}
export interface NamedCount {
  name: string;
  count: number;
}
export interface DecadeShare {
  decade: string;
  count: number;
  pct: number;
}
export interface Extreme {
  year: number;
  title: string;
  artist: string;
  owner: string;
}
export interface PerOwnerTops {
  top_genres: string[];
  top_styles: string[];
}
export interface Overlap {
  shared_artists: string[];
  shared_release_count: number;
  exclusive_counts: Record<string, number>;
}

/** The contract passed to the model as the user message. */
export interface Aggregate {
  collection: {
    total_records: number;
    shelves: number;
    owners: OwnerCount[];
  };
  genres: NamedShare[];
  styles: NamedShare[];
  decades: DecadeShare[];
  labels: NamedCount[];
  artists: NamedCount[];
  extremes?: {
    oldest?: Extreme;
    newest?: Extreme;
  };
  per_owner?: Record<string, PerOwnerTops>;
  overlap?: Overlap;
}

/** Lowercased-lookup allowlists so a model action resolves to a real facet value. */
export interface AllowedActionValues {
  genres: Map<string, string>;
  styles: Map<string, string>;
  owners: Map<string, string>;
}

function norm(value: string): string {
  return value.toLowerCase().trim();
}

function pct(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

/**
 * Count how many records carry each value drawn from a per-record list (genres,
 * styles, ...). Each record contributes at most once per distinct value. Returns
 * canonical name -> count, using the first-seen casing as canonical.
 */
function countByList(records: ShelfRecord[], pick: (r: ShelfRecord) => string[]): Map<string, number> {
  const counts = new Map<string, number>();
  const canonical = new Map<string, string>();
  for (const record of records) {
    const seen = new Set<string>();
    for (const raw of pick(record)) {
      const value = raw.trim();
      if (!value) continue;
      const lower = value.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      const canon = canonical.get(lower) ?? value;
      if (!canonical.has(lower)) canonical.set(lower, canon);
      counts.set(canon, (counts.get(canon) ?? 0) + 1);
    }
  }
  return counts;
}

/** Sort a name->count map by count desc, then name, and cap to `limit`. */
function topCounts(counts: Map<string, number>, limit: number): Array<{ name: string; count: number }> {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function decadeOf(year: number): string {
  return `${Math.floor(year / 10) * 10}s`;
}

function buildOwners(records: ShelfRecord[]): OwnerCount[] {
  const counts = new Map<string, number>();
  for (const r of records) counts.set(r.owner, (counts.get(r.owner) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, record_count]) => ({ label, record_count }));
}

function buildDecades(records: ShelfRecord[], total: number): DecadeShare[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    if (typeof r.year === "number" && r.year > 0) {
      const d = decadeOf(r.year);
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  // Decades read naturally in chronological order.
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([decade, count]) => ({ decade, count, pct: pct(count, total) }));
}

function buildExtremes(records: ShelfRecord[]): Aggregate["extremes"] {
  let oldest: ShelfRecord | null = null;
  let newest: ShelfRecord | null = null;
  for (const r of records) {
    if (typeof r.year !== "number" || r.year <= 0) continue;
    if (!oldest || r.year < oldest.year!) oldest = r;
    if (!newest || r.year > newest.year!) newest = r;
  }
  if (!oldest || !newest) return undefined;
  const toExtreme = (r: ShelfRecord): Extreme => ({
    year: r.year as number,
    title: r.title,
    artist: r.artist,
    owner: r.owner,
  });
  return { oldest: toExtreme(oldest), newest: toExtreme(newest) };
}

function buildPerOwner(owners: OwnerCount[], records: ShelfRecord[]): Aggregate["per_owner"] {
  if (owners.length < 2) return undefined;
  const out: Record<string, PerOwnerTops> = {};
  for (const { label } of owners) {
    const owned = records.filter((r) => r.owner === label);
    out[label] = {
      top_genres: topCounts(countByList(owned, (r) => r.genres), PER_OWNER_LIMIT).map((g) => g.name),
      top_styles: topCounts(countByList(owned, (r) => r.styles), PER_OWNER_LIMIT).map((s) => s.name),
    };
  }
  return out;
}

function buildOverlap(owners: OwnerCount[], records: ShelfRecord[]): Overlap | undefined {
  if (owners.length < 2) return undefined;

  // Per-owner sets of release ids and normalized artist names.
  const idsByOwner = new Map<string, Set<string>>();
  const artistsByOwner = new Map<string, Map<string, string>>(); // owner -> (norm -> display)
  for (const { label } of owners) {
    idsByOwner.set(label, new Set());
    artistsByOwner.set(label, new Map());
  }
  for (const r of records) {
    idsByOwner.get(r.owner)?.add(r.id);
    const artist = r.artist.trim();
    if (artist) artistsByOwner.get(r.owner)?.set(norm(artist), artist);
  }

  // How many owners hold each release id / each artist.
  const idOwnerCount = new Map<string, number>();
  for (const set of idsByOwner.values()) for (const id of set) idOwnerCount.set(id, (idOwnerCount.get(id) ?? 0) + 1);

  const artistOwnerCount = new Map<string, number>();
  const artistDisplay = new Map<string, string>();
  for (const map of artistsByOwner.values()) {
    for (const [key, display] of map) {
      artistOwnerCount.set(key, (artistOwnerCount.get(key) ?? 0) + 1);
      if (!artistDisplay.has(key)) artistDisplay.set(key, display);
    }
  }

  let sharedReleaseCount = 0;
  for (const c of idOwnerCount.values()) if (c > 1) sharedReleaseCount += 1;

  const sharedArtists = [...artistOwnerCount.entries()]
    .filter(([, c]) => c > 1)
    .map(([key]) => artistDisplay.get(key)!)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, SHARED_ARTIST_LIMIT);

  const exclusiveCounts: Record<string, number> = {};
  for (const { label } of owners) {
    const set = idsByOwner.get(label)!;
    let exclusive = 0;
    for (const id of set) if ((idOwnerCount.get(id) ?? 0) === 1) exclusive += 1;
    exclusiveCounts[label] = exclusive;
  }

  return {
    shared_artists: sharedArtists,
    shared_release_count: sharedReleaseCount,
    exclusive_counts: exclusiveCounts,
  };
}

/** Build the aggregate contract from the merged collection. */
export function buildAggregate(records: ShelfRecord[]): Aggregate {
  const total = records.length;
  const owners = buildOwners(records);

  const genres = topCounts(countByList(records, (r) => r.genres), TOP_LIST_LIMIT).map((g) => ({
    name: g.name,
    count: g.count,
    pct: pct(g.count, total),
  }));
  const styles = topCounts(countByList(records, (r) => r.styles), TOP_LIST_LIMIT).map((s) => ({
    name: s.name,
    count: s.count,
    pct: pct(s.count, total),
  }));
  const labels = topCounts(
    countByList(records, (r) => (r.label ? [r.label] : [])),
    TOP_LIST_LIMIT,
  );
  const artists = topCounts(
    countByList(records, (r) => (r.artist ? [r.artist] : [])),
    TOP_LIST_LIMIT,
  );

  const aggregate: Aggregate = {
    collection: { total_records: total, shelves: owners.length, owners },
    genres,
    styles,
    decades: buildDecades(records, total),
    labels,
    artists,
  };

  const extremes = buildExtremes(records);
  if (extremes) aggregate.extremes = extremes;
  const perOwner = buildPerOwner(owners, records);
  if (perOwner) aggregate.per_owner = perOwner;
  const overlap = buildOverlap(owners, records);
  if (overlap) aggregate.overlap = overlap;

  return aggregate;
}

/**
 * A stable hash of the collection's identity — the sorted list of owner-stamped
 * release ids. The cron compares it against the stored hash to decide whether the
 * shelf actually changed since the last generation.
 */
export function collectionHash(records: ShelfRecord[]): string {
  const ids = records.map((r) => `${r.owner} ${r.id}`).sort();
  return createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 32);
}

/**
 * The allowlist the validator uses to reject any action whose value is not
 * actually in the collection. Built from the present facet values (a superset of
 * the aggregate's capped lists), keyed lowercased so a verbatim-but-recased value
 * still resolves — and always resolves back to the canonical facet string, so a
 * surviving action can only ever drive a real facet search.
 */
export function allowedActionValues(records: ShelfRecord[]): AllowedActionValues {
  const toMap = (values: string[]) => new Map(values.map((v) => [v.toLowerCase(), v]));
  return {
    genres: toMap(presentGenres(records)),
    styles: toMap(presentStyles(records)),
    owners: toMap(presentOwners(records)),
  };
}

// ---- Code-computed fallback cards (served until the first generation) ----

function ownerPossessive(label: string): string {
  return /s$/i.test(label) ? `${label}'` : `${label}'s`;
}

/**
 * Deterministic, honest cards derived straight from the aggregate — no model, no
 * fabricated numbers. Serves as the read-path fallback before the first cron run,
 * or whenever no batch is cached. Each card only surfaces when its data exists,
 * and any facet action uses a value that is by construction present.
 */
export function statCards(aggregate: Aggregate): Insight[] {
  const cards: Insight[] = [];
  const { collection, genres, styles, decades, labels, artists, extremes, overlap } = aggregate;
  const total = collection.total_records;
  if (total === 0) return cards;

  const shelfNote =
    collection.shelves > 1
      ? `${total} records across ${collection.shelves} shelves.`
      : `${total} records on the shelf.`;
  cards.push({ title: "The shelf, counted", body: shelfNote, kind: "overview", action: null });

  const topGenre = genres[0];
  if (topGenre) {
    cards.push({
      title: `Mostly ${topGenre.name}`,
      body: `${topGenre.name} tags ${topGenre.pct}% of the shelf (${topGenre.count} records), the largest single genre.`,
      kind: "genre lean",
      action: { type: "genre", value: topGenre.name },
    });
  }

  const topStyle = styles[0];
  if (topStyle) {
    cards.push({
      title: `${topStyle.name} runs deep`,
      body: `${topStyle.count} records carry the ${topStyle.name} style, the most of any style here.`,
      kind: "style lean",
      action: { type: "style", value: topStyle.name },
    });
  }

  const topDecade = [...decades].sort((a, b) => b.count - a.count)[0];
  if (topDecade) {
    cards.push({
      title: `A ${topDecade.decade} shelf`,
      body: `The ${topDecade.decade} account for ${topDecade.pct}% of the records that carry a year.`,
      kind: "era skew",
      action: null,
    });
  }

  if (extremes?.oldest && extremes.newest && extremes.oldest.year !== extremes.newest.year) {
    cards.push({
      title: "End to end",
      body: `From ${extremes.oldest.artist} (${extremes.oldest.year}) to ${extremes.newest.artist} (${extremes.newest.year}); ${extremes.newest.year - extremes.oldest.year} years apart.`,
      kind: "span",
      action: null,
    });
  }

  const topLabel = labels[0];
  if (topLabel && topLabel.count > 1) {
    cards.push({
      title: `${topLabel.name} shows up`,
      body: `${topLabel.count} records come out on ${topLabel.name}, the most-repeated label.`,
      kind: "label",
      action: { type: "search", value: topLabel.name },
    });
  }

  const topArtist = artists[0];
  if (topArtist && topArtist.count > 1) {
    cards.push({
      title: `${topArtist.name}, more than once`,
      body: `${topArtist.count} records by ${topArtist.name} sit on the shelf.`,
      kind: "artist",
      action: { type: "search", value: topArtist.name },
    });
  }

  if (overlap) {
    if (overlap.shared_release_count > 0) {
      cards.push({
        title: "Common ground",
        body: `${overlap.shared_release_count} of the same releases sit on both shelves.`,
        kind: "shared ground",
        action: null,
      });
    } else {
      const owners = collection.owners;
      const a = owners[0]?.record_count ?? 0;
      const b = owners[1]?.record_count ?? 0;
      cards.push({
        title: "No repeats",
        body: `The two shelves share no exact releases; ${a + b} records with nothing doubled up.`,
        kind: "shared ground",
        action: null,
      });
    }
  }

  // Cap to match the generated batch, so the carousel shows the same number of
  // cards whether or not a model batch is cached. Cards are built in priority
  // order above, so slicing keeps the most useful ones.
  return cards.slice(0, INSIGHTS_COUNT);
}
