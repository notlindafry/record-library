"use client";

import type { Record as ShelfRecord } from "@/lib/types";

/**
 * A compact record tile for the "On the shelf" grids: cover art (with a color
 * fallback), title, artist, and an owner tag. The tile content links to the
 * record's Discogs page when one is known.
 *
 * Passing `onToggleBookmark` overlays a save (bookmark) control on the cover — the
 * whole-shelf browse view uses it so records can be saved there too, not only from
 * search results. The button is a sibling of the link (not nested inside the
 * anchor, which HTML forbids), so a save click never triggers the Discogs link.
 */
export default function RecordTile({
  record,
  isBookmarked,
  onToggleBookmark,
}: {
  record: ShelfRecord;
  isBookmarked?: boolean;
  onToggleBookmark?: (record: ShelfRecord) => void;
}) {
  const inner = (
    <>
      <div className={`tile-cover${record.coverImage ? " has-art" : ""}`} aria-hidden>
        {record.coverImage && (
          <img src={record.coverImage} alt="" loading="lazy" />
        )}
      </div>
      <div className="tile-title">{record.title}</div>
      <div className="tile-artist">{record.artist}</div>
      <span className="tile-owner">{record.owner}</span>
    </>
  );

  const body = record.discogsUrl ? (
    <a
      className="tile-link"
      href={record.discogsUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${record.artist} — ${record.title} on Discogs`}
    >
      {inner}
    </a>
  ) : (
    <div className="tile-link">{inner}</div>
  );

  return (
    <div className="tile">
      {body}
      {onToggleBookmark && (
        <button
          type="button"
          className="tile-save"
          aria-pressed={isBookmarked}
          aria-label={isBookmarked ? "Remove from saved" : "Save record"}
          title={isBookmarked ? "Saved" : "Save"}
          onClick={() => onToggleBookmark(record)}
        >
          {isBookmarked ? "★" : "☆"}
        </button>
      )}
    </div>
  );
}
