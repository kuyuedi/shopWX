# Phase 1.5 — Technical Details

## Implementation

### Backfill Script

`packages/event-matcher/src/scripts/backfillMarketMatches.ts`

One-time script that:
1. Connects to DB via `healthCheck()`
2. Runs a LATERAL JOIN query to find event pairs where both sides have unmatched YES-side open markets
3. Sorts by most unmatched markets first (biggest impact)
4. Calls `matchMarketsForSinglePair()` for each pair — the existing 4-tier pipeline
5. Logs progress every 50 pairs and final totals
6. Calls `closePool()` and exits

### Query Design

Uses `JOIN LATERAL` to count unmatched markets per side inline, filtering to only pairs where both sides have unmatched markets. This is more efficient than the existing `fetchMatchedEventPairsForMarketMatching()` which returns ALL pairs without filtering.

The query uses `source_id` from the `event_mappings` rows directly rather than hardcoded constants, making it robust to any source_id values.

### Matching Pipeline (existing, no changes)

```
Tier 0: Binary (1:1)     → auto-match if single market per side, confidence 1.0
Tier 1: Substring         → extract name after "—", check if in Poly title (with accent stripping)
Tier 2: Jaccard ≥ 0.85   → auto-accept via greedy matching
Tier 3: Jaccard 0.3–0.85 → AI verification, accept if confidence ≥ 0.8
```

Already-matched markets are filtered out by `fetchExistingMappedMarketIds()` inside `matchMarketsForSinglePair()`.

## Synonym Normalization Gap

`normalizeSynonyms()` from `preFilter.ts` is only used in event-level pre-filtering, NOT in market-level matching. `normalizeOutcomeName()` in `marketMatcher.ts` only calls `stripAccents()`.

Markets where the only difference is synonyms (e.g., "cut 25bps" vs "decrease by 25 bps") will have Jaccard ~0.0, falling below the 0.3 AI threshold. These remain for Phase 2 cross-event matching or a future enhancement to add `normalizeSynonyms()` to `computeSimilarity()` in `marketMatcher.ts`.

## Idempotency

Safe to re-run. `matchMarketsForSinglePair()` fetches `fetchExistingMappedMarketIds()` before matching, so already-matched markets are skipped. The LATERAL query also only returns pairs with unmatched markets, so subsequent runs process fewer pairs.

## Cost Estimate

| Tier | % of markets | Cost per match | Subtotal |
|------|-------------|----------------|----------|
| Tier 0: Binary (1:1) | ~10% | Free | $0 |
| Tier 1: Substring | ~50% | Free | $0 |
| Tier 2: Jaccard ≥ 0.85 | ~20% | Free | $0 |
| Tier 3: AI verify | ~20% | ~$0.001 | ~$10–30 |
| **Total** | | | **$10–30** |
