# Feature: Binary-Only Polymarket Market Ingestion

**Status**: DONE
**Priority**: High
**Created**: 2026-03-04

---

## Summary

Skip non-binary Polymarket markets (e.g. multi-outcome sports, multi-choice) and only ingest binary Yes/No markets.

---

## Problem

36% of Polymarket markets (~12,622) have non-binary outcomes (e.g. "Kings" vs "Blue Jackets", "Up" vs "Down"). Our `normalizeMarket()` incorrectly labels both tokens as `outcome_side = 'NO'` for these markets because the outcome text doesn't match "YES".

This causes:
- Market matcher can't find these on the Polymarket side (it fetches YES-side only)
- 2,118 markets in matched events are invisible to matching
- DB has inconsistent data (both tokens labeled NO with outcome_name "No")

---

## Solution

Filter non-binary markets at three levels:
1. `normalizeMarket()` skips markets whose outcomes don't include both "Yes" and "No"
2. `fetchEventsWithMarkets()` sets `market_count` to only count binary markets
3. `matchingCycle` skips Polymarket events with `market_count = 0`

Kalshi markets are always binary, so no filter is needed there.

---

## Algorithm / Logic

```
1. Parse market outcomes JSON from Gamma API
2. Check: does outcomes array contain both "Yes" and "No" (case-insensitive)?
3. If yes → normalize and ingest as before
4. If no → skip market entirely (return empty array)
5. Event market_count = count of binary markets only
6. Event matcher filters out Poly events where market_count = 0
```

---

## Configuration

No new configuration parameters. The binary filter is always active.

---

## Input Data

| Source | Table/API | Fields Used |
|--------|-----------|-------------|
| Polymarket Gamma API | `/events` (nested markets) | `market.outcomes` (JSON string) |

---

## Output Data

| Table | Field | Type | Description |
|-------|-------|------|-------------|
| prediction_markets | outcome_side | VARCHAR | Always 'YES' or 'NO' for Polymarket (non-binary skipped) |
| events | market_count | INTEGER | Count of binary markets only (was total markets) |

---

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| Outcomes = ["Yes", "No"] | Ingest normally |
| Outcomes = ["Kings", "Blue Jackets"] | Skip — non-binary |
| Outcomes = ["Up", "Down", "Flat"] | Skip — non-binary |
| Outcomes = ["yes", "no"] (lowercase) | Ingest — case-insensitive check |
| Outcomes parse fails | Skip — existing error handling |
| Event with all non-binary markets | market_count = 0, skipped in matcher |
| Event with mix of binary and non-binary | market_count = binary count only |

---

## Acceptance Criteria

- [x] No NO-only markets in prediction_markets for Polymarket
- [x] Equal YES and NO counts for Polymarket markets
- [x] market_count on events reflects binary markets only
- [x] Event matcher skips 0-market Polymarket events
- [x] DB cleanup removes existing non-binary data (~16,416 rows)
- [x] All tests pass, smoke tests pass

---

## Examples

### Example 1: Binary Market (ingested)

**Input:**
```json
{
  "outcomes": "[\"Yes\",\"No\"]",
  "clobTokenIds": "[\"token1\",\"token2\"]"
}
```

**Expected Output:** 2 NormalizedMarket records (YES and NO)

### Example 2: Non-Binary Market (skipped)

**Input:**
```json
{
  "outcomes": "[\"Kings\",\"Blue Jackets\"]",
  "clobTokenIds": "[\"token1\",\"token2\"]"
}
```

**Expected Output:** Empty array (market skipped)

---

## Notes

- Post-deploy DB cleanup SQL is in technical.md
- Non-binary markets may be supported in the future with proper outcome_side mapping
- The polymarket-listener self-corrects market_count on events every 5-minute sync cycle
