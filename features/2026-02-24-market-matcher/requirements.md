# Feature: AI-Powered Cross-Exchange Market Matching

**Status**: COMPLETE
**Priority**: High
**Created**: 2026-02-24

---

## Summary

Detect equivalent prediction markets across Kalshi and Polymarket using OpenAI GPT-5 Nano, populating the `market_mappings` table with matches above 85% confidence.

---

## Problem

The `market_mappings` table exists but is empty. There is no automated way to identify which Kalshi market corresponds to which Polymarket market for the same real-world event. Cross-exchange arbitrage detection requires knowing which markets are equivalent.

---

## Solution

A standalone service (`market-matcher`) that:
1. Runs every 5 minutes (aligned with market sync)
2. Fetches **all open markets** from both exchanges (no category filtering — Polymarket has 393+ categories with inconsistent naming)
3. Pre-filters candidates by keyword overlap, outcome name, status, and expiry proximity
4. Uses OpenAI GPT-5 Nano to compare market fields focusing on **real-world outcome matching**
5. **Writes matches immediately** to `market_mappings` as they are found (prevents data loss on container restart)

---

## Algorithm / Logic

Runs **separately for each outcome side** (YES-YES, then NO-NO):

```
For each outcome_side in ['YES', 'NO']:
  1. Fetch ALL Kalshi markets (this side, Open) from DB — no category filter
  2. Fetch ALL Polymarket markets (this side, Open) from DB — no category filter
  3. Fetch existing mapped (market_id, outcome_side) pairs -> skip already-matched
  4. Pre-filter: outcome_name must be standard "Yes"/"No" (skip named outcomes like "Chiefs")
  5. For each unmatched Kalshi market on this side:
     a. Extract keywords from title (lowercase, remove stop words, numbers, short tokens)
     b. Score each Polymarket candidate by keyword overlap count
     c. Filter: keyword overlap >= 1, expiry within 120 days
     d. Take top 10 candidates by overlap score
     e. Call OpenAI GPT-5 Nano -> get match/no-match + confidence per candidate
     f. Accept matches where match=true AND confidence >= 0.85
     g. **Write matches to DB immediately** (not batched at end of cycle)
  6. Generate canonical_market_id = "CM-" + sha256(sorted pair keys + outcome_side).substring(0, 16)
  7. Write 2 rows per match: (Kalshi <side>, Polymarket <side>)
  8. Log summary: X new matches found for <side>, Y API calls made
```

YES-YES matches and NO-NO matches are **independent** -- each side gets its own canonical ID and its own AI comparison.

---

## Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `OPENAI_API_KEY` | OpenAI API key | (required) |
| `OPENAI_MODEL` | Model to use | `gpt-5-nano` |
| `OPENAI_RATE_LIMIT_RPM` | Max API requests per minute | `50` |
| `MATCHER_INTERVAL_MS` | Run interval | `300000` (5 min) |
| `MATCHER_CONFIDENCE_THRESHOLD` | Min confidence to accept match | `0.85` |
| `MATCHER_CANDIDATES_PER_BATCH` | Polymarket candidates per API call | `10` |
| `MATCHER_EXPIRY_TOLERANCE_DAYS` | Max days difference in expires_at | `120` |
| `MATCHER_MATCH_VERSION` | Version tag for prompt/schema | `1` |

---

## Input Data

| Source | Table/API | Fields Used |
|--------|-----------|-------------|
| Kalshi markets | `prediction_markets` | source_id, exchange_id, market_id, outcome_side, outcome_name, title, sub_title, rules_primary, price, expires_at, status, category |
| Polymarket markets | `prediction_markets` | Same fields as above |
| Existing mappings | `market_mappings` | market_id, outcome_side |

---

## Output Data

| Table | Field | Type | Description |
|-------|-------|------|-------------|
| `market_mappings` | canonical_market_id | VARCHAR(50) | "CM-" + sha256 hash prefix |
| `market_mappings` | source_id | VARCHAR(255) | KALSHI_DIRECT or POLY_DIRECT |
| `market_mappings` | exchange_id | VARCHAR(255) | KALSHI or POLYMARKET |
| `market_mappings` | market_id | VARCHAR(255) | Ticker or token ID |
| `market_mappings` | outcome_side | VARCHAR(10) | YES or NO |
| `market_mappings` | confidence_score | DOUBLE PRECISION | AI confidence (0.0-1.0) |
| `market_mappings` | matched_at | TIMESTAMPTZ | When match was detected |
| `market_mappings` | model_id | VARCHAR(50) | Model used (e.g. gpt-5-nano) |
| `market_mappings` | match_version | INTEGER | Prompt/schema version |

---

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| No markets on either exchange | Log "no markets found", skip side |
| All markets already matched | Log "no new markets to match", skip |
| OpenAI API timeout (30s) | Retry 3x with exponential backoff, then skip market |
| OpenAI returns invalid JSON | Log error, skip that batch |
| Confidence below threshold | Do not write mapping, log at debug level |
| Market with named outcome (e.g. "Chiefs") | Pre-filter skips it (not standard Yes/No) |
| Expiry dates differ by > 120 days | Pre-filter skips pair |
| No keyword overlap between titles | Pre-filter skips pair (eliminates ~90%+ irrelevant comparisons) |
| Multiple Polymarket matches for one Kalshi | Accept highest confidence if >= threshold |
| Missing OPENAI_API_KEY | Exit with error on startup |
| Container restart mid-cycle | No data loss — matches written immediately when found |

---

## Acceptance Criteria

- [x] Service starts and connects to DB
- [x] Fetches all markets from both exchanges (no category filter)
- [x] Skips already-matched markets
- [x] Pre-filters by keyword overlap, outcome name, expiry tolerance
- [x] Calls OpenAI with structured prompt focused on real-world outcome matching
- [x] Writes matches to market_mappings immediately when found
- [x] Runs on interval (5 min default)
- [x] Handles SIGTERM gracefully
- [x] Logs summary per cycle
- [x] 30-second fetch timeout prevents hanging on OpenAI API calls

---

## Key Design Decisions

1. **No category filtering**: Polymarket has 393+ categories with inconsistent naming (e.g., "Politics" vs "Elections", "Crypto" vs "Ethereum"). Manual category pair mapping was unmaintainable and blocked 80%+ of legitimate matches.

2. **Keyword pre-filter**: Extracts keywords from titles and scores candidates by overlap. This eliminates ~90%+ of irrelevant comparisons before hitting the AI API. Stop words, numbers, and short tokens (< 3 chars) are removed.

3. **120-day expiry tolerance**: Kalshi and Polymarket set very different contract expiry dates for the same event (e.g., 92 days apart for the same Fed rate decision). The original 7-day tolerance was too strict.

4. **Real-world outcome matching prompt**: The AI prompt focuses on whether markets resolve on the same real-world outcome, ignoring superficial differences like wording ("Federal Reserve" vs "Fed"), phrasing ("at the meeting" vs "after the meeting"), and contract expiry dates.

5. **Immediate match persistence**: Matches are written to DB as soon as they're found, not batched at end of cycle. Cycles process 32k+ markets and take 30+ minutes — batching risked losing all matches on container restart.

---

## Notes

- Matches all categories across ~32k Kalshi and ~20k Polymarket markets
- The matcher is designed to be idempotent -- re-running won't create duplicate mappings (ON CONFLICT DO UPDATE)
- Canonical IDs are deterministic: same pair always produces the same ID
- FK constraints from `market_mappings` to `canonical_markets` and `prediction_markets` have been dropped for simplicity
