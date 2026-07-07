/**
 * Insights generation (feature 6): build the prompt, call Claude, and defensively
 * parse and validate the output.
 *
 * Reuses the same Anthropic client, key, and model as QuerySpec parsing and the
 * Forgotten Shelf blurb — constructed inline per call, model from ANTHROPIC_MODEL
 * (default claude-haiku-4-5). No second client, no second key.
 *
 * Model output is treated as untrusted input: we strip stray fences, parse in a
 * try/catch, validate every card's shape, cap the count and text lengths, and
 * reject any action whose value is not actually in the collection — so a bad
 * card can neither break rendering nor drive an unexpected search. On any error
 * we log server-side and return an empty list; the caller falls back to stat cards.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Insight, InsightAction } from "@/lib/types";
import type { Aggregate, AllowedActionValues } from "@/lib/insights/aggregate";
import { INSIGHTS_SYSTEM_PROMPT, buildInsightsUserMessage } from "@/lib/insights/prompt";

const MAX_INSIGHTS = 10; // upper bound of the 6-10 range in the prompt
const MAX_TITLE = 80;
const MAX_BODY = 240;
const MAX_KIND = 40;
const MAX_SEARCH_VALUE = 100;

function model(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5";
}

/**
 * Generate the insight batch for an aggregate. Returns [] when no key is set or
 * on any Claude / parse error (the caller serves stat cards instead).
 */
export async function generateInsights(
  aggregate: Aggregate,
  allowed: AllowedActionValues,
): Promise<Insight[]> {
  if (!process.env.ANTHROPIC_API_KEY) return [];
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let raw: string;
  try {
    const res = await client.messages.create({
      model: model(),
      max_tokens: 2000, // small structured output; read `usage` to right-size
      // No temperature: ANTHROPIC_MODEL is a shared override (the other Claude call
      // sites omit it too), and newer models reject sampling params. Phrasing
      // variety comes from the prompt's VOICE block ("vary how sentences open").
      system: INSIGHTS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildInsightsUserMessage(aggregate) }],
    });
    // Extract text defensively; do not assume the first block is text.
    raw = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  } catch (err) {
    // Log server-side with detail; surface nothing here.
    console.error("[insights] generation failed:", err instanceof Error ? err.message : err);
    return [];
  }

  return parseInsights(raw, allowed);
}

/** Tolerantly pull a JSON object out of a model response. */
function extractJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
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

function clampText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function parseInsights(raw: string, allowed: AllowedActionValues): Insight[] {
  // Strip stray code fences before parsing.
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  const parsed = extractJsonObject(cleaned);
  if (!parsed || typeof parsed !== "object") {
    console.error("[insights] JSON parse failed");
    return [];
  }

  const list = Array.isArray((parsed as { insights?: unknown }).insights)
    ? ((parsed as { insights: unknown[] }).insights)
    : [];

  const out: Insight[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const title = clampText(record.title, MAX_TITLE);
    const body = clampText(record.body, MAX_BODY);
    const kind = clampText(record.kind, MAX_KIND);
    // Title and body are required; kind may be empty (rendered as no caption).
    if (!title || !body) continue;
    out.push({ title, body, kind, action: validateAction(record.action, allowed) });
    if (out.length >= MAX_INSIGHTS) break;
  }
  return out;
}

/**
 * Validate a card's action. A genre/style/owner action must resolve to a value
 * actually present in the collection (returned as the canonical facet string);
 * a search action must be a non-empty, bounded free-text string. Anything else
 * becomes null, so a malformed or unverifiable action cannot drive a search.
 */
function validateAction(value: unknown, allowed: AllowedActionValues): InsightAction | null {
  if (!value || typeof value !== "object") return null;
  const action = value as { type?: unknown; value?: unknown };
  if (typeof action.type !== "string" || typeof action.value !== "string") return null;

  const v = action.value.trim();
  if (!v) return null;
  const lower = v.toLowerCase();

  switch (action.type) {
    case "genre": {
      const canon = allowed.genres.get(lower);
      return canon ? { type: "genre", value: canon } : null;
    }
    case "style": {
      const canon = allowed.styles.get(lower);
      return canon ? { type: "style", value: canon } : null;
    }
    case "owner": {
      const canon = allowed.owners.get(lower);
      return canon ? { type: "owner", value: canon } : null;
    }
    case "search":
      return { type: "search", value: v.slice(0, MAX_SEARCH_VALUE) };
    default:
      return null;
  }
}
