#!/usr/bin/env node
/**
 * Drive a hydration cron to completion.
 *
 * The hydrate-* crons each process a BOUNDED batch per request and return
 * `{ ok, hydratedThisRun, remaining, total }`, so a short loop walks a full
 * backfill without waiting for the daily schedule. Idempotent: it only ever
 * generates what is still pending, so re-running is safe and just resumes.
 *
 * Usage:
 *   CRON_SECRET=... npm run backfill:descriptors
 *   CRON_SECRET=... BASE_URL=https://your-app.vercel.app npm run backfill:descriptors
 *   CRON_SECRET=... node scripts/backfill.mjs hydrate-tracks
 *
 * Env:
 *   CRON_SECRET  (required) the same secret set on the deployment. Sent as
 *                `Authorization: Bearer <CRON_SECRET>`, exactly like Vercel Cron.
 *   BASE_URL     (optional) deployment origin. Default http://localhost:3000.
 *
 * Reads no files and prints only counts and the target path — never the secret.
 */

const KNOWN_CRONS = new Set(["hydrate-descriptors", "hydrate-tracks", "hydrate-lastfm"]);

const SLEEP_MS = 2_000; // polite gap between successful runs
const RATE_LIMIT_SLEEP_MS = 15_000; // back off when a cron reports it was rate limited
const FETCH_RETRIES = 3; // transient network errors per iteration
const STALL_LIMIT = 3; // consecutive no-progress runs before giving up
const MAX_RUNS = 1_000; // hard backstop against an infinite loop

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

const cron = (process.argv[2] ?? "hydrate-descriptors").replace(/^\/+|\/+$/g, "");
if (!KNOWN_CRONS.has(cron)) {
  fail(`unknown cron "${cron}". Expected one of: ${[...KNOWN_CRONS].join(", ")}`);
}

const secret = process.env.CRON_SECRET;
if (!secret) fail("CRON_SECRET is not set. Export it (the same value as on the deployment) and retry.");

const base = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const url = `${base}/api/cron/${cron}`;

/** One call to the cron, with a few retries for transient network failures. */
async function runOnce() {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${secret}` } });
      const body = await res.json().catch(() => null);
      if (res.status === 401) fail("401 Unauthorized — CRON_SECRET does not match the deployment.");
      if (!res.ok) {
        // 502 from the route (upstream failure) is worth retrying a couple times.
        throw new Error(`HTTP ${res.status}${body?.error ? ` — ${body.error}` : ""}`);
      }
      return body ?? {};
    } catch (err) {
      lastErr = err;
      if (attempt < FETCH_RETRIES) await sleep(1_000 * attempt);
    }
  }
  throw lastErr;
}

console.log(`Backfilling ${cron} via ${url}`);

let run = 0;
let stalls = 0;
let hydratedTotal = 0;

while (run < MAX_RUNS) {
  run += 1;

  let body;
  try {
    body = await runOnce();
  } catch (err) {
    fail(`request failed: ${err instanceof Error ? err.message : err}`);
  }

  // No key configured on the deployment → nothing to do, and re-running won't help.
  if (body.skipped) {
    console.log(`• skipped: ${body.skipped}`);
    console.log("Nothing to backfill (is ANTHROPIC_API_KEY / LASTFM_API_KEY set on the deployment?).");
    break;
  }
  if (body.ok !== true) {
    fail(`unexpected response: ${JSON.stringify(body)}`);
  }

  const done = Number(body.hydratedThisRun ?? 0);
  const remaining = Number(body.remaining ?? 0);
  const total = Number(body.total ?? 0);
  hydratedTotal += done;

  const pct = total > 0 ? Math.round(((total - remaining) / total) * 100) : 100;
  console.log(`run ${run}: +${done} this run · ${remaining} remaining of ${total} (${pct}%)`);

  if (remaining <= 0) {
    console.log(`✓ Done. Hydrated ${hydratedTotal} this session; ${total} total.`);
    break;
  }

  // No progress while work remains means chunks are failing transiently (rate
  // limit / upstream). Stop after a few so we don't spin forever.
  if (done === 0) {
    stalls += 1;
    if (stalls >= STALL_LIMIT) {
      fail(
        `no progress for ${STALL_LIMIT} runs with ${remaining} still pending. ` +
          `Likely rate-limited or a transient upstream failure — wait a bit and re-run.`,
      );
    }
  } else {
    stalls = 0;
  }

  await sleep(body.rateLimited ? RATE_LIMIT_SLEEP_MS : SLEEP_MS);
}

if (run >= MAX_RUNS) fail(`hit the ${MAX_RUNS}-run safety cap; re-run to continue.`);
