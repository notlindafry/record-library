"use client";

import type { Record as ShelfRecord } from "@/lib/types";

/**
 * A compact record tile for the home-view "On the shelf" grid: cover art (with a
 * color fallback), title, artist, and an owner tag. The whole tile links to the
 * record's Discogs page when one is known.
 */
export default function RecordTile({ record }: { record: ShelfRecord }) {
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

  if (record.discogsUrl) {
    return (
      <a
        className="tile"
        href={record.discogsUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${record.artist} — ${record.title} on Discogs`}
      >
        {inner}
      </a>
    );
  }
  return <div className="tile">{inner}</div>;
}
