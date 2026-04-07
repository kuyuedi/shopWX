# N-Exchange Event & Market Matching

## Overview

The event-matcher service was previously hardcoded to match events and markets between Kalshi and Polymarket only. This generalization makes it support **N exchange pairs** via a declarative configuration, with two matching strategies:

- **AI matching** — OpenAI-based semantic comparison for exchanges without API-provided links
- **Derived matching** — Infer event mappings from existing `market_mappings` for exchanges that already have reliable market-level links (e.g., Predict.fun)

All canonical ID generation, transitive grouping, and market-within-event matching are fully parameterized for any exchange pair.

## Motivation

With Predict.fun as the third exchange and Opinion.trade as the fourth, hardcoding Kalshi↔Polymarket was no longer viable. Predict already has API-provided market links (via `kalshiMarketTicker` and `polymarketConditionIds`), so AI calls are unnecessary — derived matching is both faster and free. Opinion.trade will need AI matching when enabled.

## Exchange Pair Configuration

Six exchange pairs are configured, each with a strategy and enabled flag:

| # | Pair | Strategy | Enabled | Notes |
|---|------|----------|---------|-------|
| 1 | Kalshi ↔ Polymarket | `ai` | Always | Existing behavior, unchanged |
| 2 | Kalshi ↔ Predict | `derived` | `ENABLE_PREDICT_MATCHING !== 'false'` | No AI calls |
| 3 | Polymarket ↔ Predict | `derived` | `ENABLE_PREDICT_MATCHING !== 'false'` | No AI calls |
| 4 | Kalshi ↔ Opinion | `ai` | `ENABLE_OPINION_MATCHING === 'true'` | Disabled by default |
| 5 | Polymarket ↔ Opinion | `ai` | `ENABLE_OPINION_MATCHING === 'true'` | Disabled by default |
| 6 | Predict ↔ Opinion | `ai` | `ENABLE_OPINION_MATCHING === 'true'` | Disabled by default |

Adding a new exchange requires only adding entries to the pair config — no changes to matching logic.

## Matching Strategies

### AI Strategy (`strategy: 'ai'`)

Used for exchange pairs without pre-existing market links. The existing Phase 1 logic is reused, parameterized with source/target exchange IDs instead of hardcoded Kalshi/Polymarket:

1. Fetch open events from both exchanges
2. Skip already-matched and recently-checked events
3. Pre-filter candidates by keyword/entity overlap
4. Send to OpenAI for semantic comparison
5. On match: create `event_mappings` with transitive canonical grouping, then match markets inline

AI prompts are parameterized (e.g., "KALSHI EVENT" / "OPINION CANDIDATES") so they work for any pair.

### Derived Strategy (`strategy: 'derived'`)

Used for exchanges that already have market-level cross-links (e.g., Predict↔Kalshi, Predict↔Polymarket via `predict-api-link-v1` market_mappings):

1. Query `market_mappings` to find markets linked across the two exchanges (shared `canonical_market_id`)
2. Look up each market's `event_id` from `prediction_markets`
3. Skip event pairs that already exist in `event_mappings`
4. Create `event_mappings` with transitive canonical grouping
5. `model_id = 'derived-from-market-mappings-v1'`, `confidence_score = 1.0`

No AI calls, no cost, instant matching.

## Transitive Canonical Grouping

When a match is found for any pair, the system checks if either event (or market) already belongs to a canonical group from a prior pair match. If so, it reuses the existing `canonical_event_id` / `canonical_market_id`.

**Example:** Kalshi event A matches Polymarket event B → canonical group `CE-abc`. Later, Predict event C is derived-matched to Kalshi event A → C joins `CE-abc` (not a new group). Result: 3-exchange canonical group.

This works because:
- `findExistingCanonicalEventId()` checks if either event already has a mapping
- `findExistingCanonicalMarketId()` does the same for markets
- The first non-null result is reused; only if neither exists is a new ID generated

## Canonical ID Format

Deterministic hash-based IDs via `generateCanonicalId()`:

- **Events:** `CE-<16-char-sha256-hex>`
- **Markets:** `CM-<16-char-sha256-hex>`

Algorithm: sort `EXCHANGE:id` entries lexicographically, join with `|`, SHA-256 hash, take first 16 hex chars. Backward compatible — same K↔P inputs produce identical IDs to the old hardcoded functions.

## Predict Integration Flow

```
predict-listener (market sync — single API: GET /v1/categories?status=OPEN)
  ├→ Categories → events table (449 open events)
  ├→ Nested markets → prediction_markets table (extracted from categories)
  └→ crossMapping.ts creates market_mappings (predict-api-link-v1)
       └→ Predict↔Kalshi and Predict↔Polymarket pairwise links

event-matcher (matching cycle)
  └→ derivedMatcher.ts queries market_mappings
       └→ Infers event_mappings from market links
            └→ Transitive grouping joins existing canonical groups
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_PREDICT_MATCHING` | `true` | Enable Predict derived matching pairs |
| `ENABLE_OPINION_MATCHING` | `false` | Enable Opinion AI matching pairs |
| `MATCHER_CONCURRENCY` | `20` | Concurrent AI matching workers per pair |
| `MATCHER_INTERVAL_MS` | `300000` | Cycle interval (5 min) |

## Verification

```sql
-- Event mappings by exchange (should show PREDICT entries)
SELECT exchange_id, COUNT(*) FROM direct_exchanges_data.event_mappings GROUP BY exchange_id;

-- Events in canonical groups with 3+ exchanges
SELECT canonical_event_id, array_agg(DISTINCT exchange_id) as exchanges
FROM direct_exchanges_data.event_mappings WHERE is_active = TRUE
GROUP BY canonical_event_id HAVING COUNT(DISTINCT exchange_id) >= 3;

-- Markets in canonical groups with 3+ exchanges
SELECT canonical_market_id, array_agg(DISTINCT exchange_id) as exchanges
FROM direct_exchanges_data.market_mappings
GROUP BY canonical_market_id HAVING COUNT(DISTINCT exchange_id) >= 3;

-- Derived event matches
SELECT COUNT(*) FROM direct_exchanges_data.event_mappings
WHERE model_id = 'derived-from-market-mappings-v1';
```
