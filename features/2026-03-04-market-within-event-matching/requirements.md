# Feature: Market-Within-Event Matching

**Status**: IMPLEMENTED
**Priority**: High
**Created**: 2026-03-04

---

## Summary

Match individual markets across Kalshi and Polymarket within already-matched events, using algorithmic similarity matching with AI verification for borderline cases.

---

## Problem

The event-matcher service matches events across exchanges (writes to `event_mappings`), but does NOT match individual markets within those events. The `/api/v1/events` endpoint needs `market_mappings` data to merge cross-exchange prices per market/outcome.

Additionally, the event-matcher had a **source_id bug**: it hardcoded `'DIRECT'` but the actual data uses `'KALSHI_DIRECT'`/`'POLYMARKET_DIRECT'` (defined in `packages/shared/src/types/market.ts`). This prevented the matcher from finding any events.

---

## Solution

Market matching runs inline immediately after each event match (not as a separate batch phase):
1. When an event pair is matched by a worker, `matchMarketsForSinglePair()` is called immediately
2. Fetch YES-side open markets from both exchanges for that event pair
3. Match markets algorithmically (binary auto-match or greedy Jaccard similarity)
4. Write results to existing `market_mappings` and `market_titles` tables

---

## Algorithm / Logic

```
Called inline via matchMarketsForSinglePair() immediately after each event match:

1. Fetch YES-side open markets from both exchanges for the event pair
2. Skip if either side has 0 markets
3. Fetch already-mapped market_ids via fetchExistingMappedMarketIds()
4. Filter out markets already in market_mappings
5. Skip if no un-mapped markets remain
6. Three-tier matching:
   - Binary (1 market each after filtering): auto-match, confidence=1.0, model_id='algorithmic-v1'
   - Multi-outcome Jaccard >= 0.5: auto-accept via greedy matching, model_id='algorithmic-v1'
   - Multi-outcome Jaccard 0.3–0.5: AI verification via verifyMarketMatch(),
     accepted only if AI confidence >= 0.8, model_id='ai-verified-v1'
7. For each matched pair:
   - Generate canonical_market_id = CM-{sha256(sort(KALSHI:id, POLY:id))[0:16]}
   - Write 4 MarketMapping rows (YES+NO per exchange)
   - Write market_titles row
8. Return number of markets matched
```

Similarity formula (Jaccard token similarity):
```
tokens_a = set(normalize(name_a).split(' '))
tokens_b = set(normalize(name_b).split(' '))
similarity = |tokens_a ∩ tokens_b| / |tokens_a ∪ tokens_b|
```

AI verification (`verifyMarketMatch()`):
```
Input: kalshiMarket, polyMarket, jaccardScore
Output: { match: boolean, confidence: number, reasoning: string }
Accept if: match=true AND confidence >= 0.8
```

---

## Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `MARKET_MATCH_THRESHOLD` | Jaccard auto-accept threshold for multi-outcome matching | `0.5` |
| `MARKET_MATCH_AI_THRESHOLD` | Min Jaccard to trigger AI verification for borderline matches | `0.3` |
| `MATCHER_RECHECK_INTERVAL_MS` | Recheck interval for unmatched events (ms) | `86400000` (24h) |

---

## Input Data

| Source | Table/API | Fields Used |
|--------|-----------|-------------|
| Event pairs | `event_mappings` | `event_id`, `source_id`, `exchange_id`, `canonical_event_id` |
| Markets | `prediction_markets` | `market_id`, `source_id`, `exchange_id`, `event_id`, `outcome_side`, `outcome_name`, `title`, `status` |
| Existing mappings | `market_mappings` | `market_id` (for dedup) |

---

## Output Data

| Table | Field | Type | Description |
|-------|-------|------|-------------|
| `market_mappings` | 4 rows per match | — | YES+NO per exchange, `canonical_market_id` format `CM-{hash}` |
| `market_mappings` | `model_id` | VARCHAR | `algorithmic-v1` (auto/Jaccard) or `ai-verified-v1` (AI-verified borderline) |
| `market_titles` | `generated_title` | VARCHAR | From Kalshi outcome_name or title |

---

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| Event pair with 0 markets on one side | Skip pair |
| All markets already mapped | Skip pair |
| Binary event (1 market each) | Auto-match with confidence 1.0 |
| Multi-outcome with no matches above threshold | No markets matched for that pair |
| Same market matched in multiple event pairs | Prevented by mappedMarketIds tracking |

---

## Source ID Bugfix

The event-matcher hardcoded `KALSHI_SOURCE = 'DIRECT'` and `POLY_SOURCE = 'DIRECT'`, but the actual data in `prediction_markets` and `events` tables uses `'KALSHI_DIRECT'` and `'POLYMARKET_DIRECT'`. This was fixed by importing `KALSHI_SOURCE_ID` and `POLYMARKET_SOURCE_ID` from `@prediction-market/shared`.

---

## Acceptance Criteria

- [x] source_id bug fixed (uses KALSHI_DIRECT/POLYMARKET_DIRECT)
- [x] Market matching runs after event matching in each cycle
- [x] Binary events auto-matched with confidence 1.0
- [x] Multi-outcome Jaccard >= 0.5 auto-accepted (`algorithmic-v1`)
- [x] Multi-outcome Jaccard 0.3–0.5 AI-verified via `verifyMarketMatch()` (`ai-verified-v1`, confidence >= 0.8)
- [x] Results written to market_mappings, market_titles
- [x] Already-mapped markets skipped
- [x] Two model_ids: `algorithmic-v1` (auto) and `ai-verified-v1` (AI-verified)
- [x] Configurable thresholds via MARKET_MATCH_THRESHOLD and MARKET_MATCH_AI_THRESHOLD
- [x] Unmatched events skipped for 24h via recheck interval (MATCHER_RECHECK_INTERVAL_MS)
