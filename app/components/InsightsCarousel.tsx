"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchInsights } from "@/lib/api";
import type { Insight, InsightAction } from "@/lib/types";

const AUTO_ADVANCE_MS = 7000;
const SWIPE_THRESHOLD_PX = 40;
const ACTION_TYPES = new Set<InsightAction["type"]>(["genre", "style", "owner", "search"]);

/**
 * The home-view insights carousel (feature 6). Fetches the cached batch once,
 * holds it in state, and rotates through the cards entirely client-side — moving
 * between cards costs nothing (never calls Claude). All card text renders as
 * escaped React text; a tap-to-search action is re-validated here before it can
 * dispatch. Hides itself (renders nothing) while loading or when there is nothing
 * usable, rather than showing an empty frame.
 */
export default function InsightsCarousel({
  onAction,
}: {
  onAction?: (action: InsightAction) => void;
}) {
  const [insights, setInsights] = useState<Insight[] | null>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const touchStartX = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchInsights()
      .then((res) => {
        if (!cancelled) setInsights(Array.isArray(res.insights) ? res.insights : []);
      })
      .catch(() => {
        if (!cancelled) setInsights([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const count = insights?.length ?? 0;

  const go = useCallback(
    (next: number) => {
      if (count === 0) return;
      setIndex(((next % count) + count) % count);
    },
    [count],
  );

  // Auto-advance, paused on hover/focus/touch and disabled for users who prefer
  // reduced motion. Including `index` in the deps resets the countdown after a
  // manual move, so it never jumps immediately.
  useEffect(() => {
    if (paused || count <= 1) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setIndex((i) => (i + 1) % count), AUTO_ADVANCE_MS);
    return () => window.clearInterval(id);
  }, [paused, count, index]);

  function onTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  }
  function onTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current == null) return;
    const dx = (e.changedTouches[0]?.clientX ?? touchStartX.current) - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
    go(index + (dx < 0 ? 1 : -1));
  }

  if (insights === null || count === 0) return null;

  const current = insights[Math.min(index, count - 1)];
  const action = validAction(current.action);

  return (
    <section
      className="insights"
      aria-label="Collection insights"
      aria-roledescription="carousel"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="insights-head">
        <span className="insights-eyebrow">On the shelf</span>
        {count > 1 && (
          <span className="insights-progress" aria-hidden>
            {index + 1} / {count}
          </span>
        )}
      </div>

      <div className="insight-card">
        {current.kind && <span className="insight-kind">{current.kind}</span>}
        <h3 className="insight-title">{current.title}</h3>
        <p className="insight-body">{current.body}</p>
        {action && onAction && (
          <button
            type="button"
            className="insight-action linkish"
            onClick={() => onAction(action)}
          >
            {actionLabel(action)}
          </button>
        )}
      </div>

      {count > 1 && (
        <div className="insights-nav">
          <button
            type="button"
            className="insights-arrow"
            aria-label="Previous insight"
            onClick={() => go(index - 1)}
          >
            ‹
          </button>
          <div className="insights-dots">
            {insights.map((_, i) => (
              <button
                key={i}
                type="button"
                className={`insights-dot${i === index ? " active" : ""}`}
                aria-label={`Go to insight ${i + 1}`}
                aria-current={i === index}
                onClick={() => go(i)}
              />
            ))}
          </div>
          <button
            type="button"
            className="insights-arrow"
            aria-label="Next insight"
            onClick={() => go(index + 1)}
          >
            ›
          </button>
        </div>
      )}
    </section>
  );
}

/** Re-validate an action before dispatch: known type, non-empty value. */
function validAction(action: InsightAction | null): InsightAction | null {
  if (!action) return null;
  if (!ACTION_TYPES.has(action.type)) return null;
  if (typeof action.value !== "string" || action.value.trim().length === 0) return null;
  return action;
}

function actionLabel(action: InsightAction): string {
  switch (action.type) {
    case "genre":
    case "style":
      return `Browse ${action.value} →`;
    case "owner":
      return `See ${action.value}’s shelf →`;
    case "search":
      return `Search “${action.value}” →`;
  }
}
