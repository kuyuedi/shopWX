# Feature: Use Gamma Market ID for Polymarket market_id

**Status**: COMPLETED
**Priority**: High
**Created**: 2026-02-18

---

## Summary

Replace Polymarket's `market_id` from the 76-character clobTokenId (unique per YES/NO token) to the short numeric Gamma market ID (shared per market, differentiated by `outcome_side`), matching how Kalshi already works.

---

## Problem

Polymarket's `market_id` stored the **clobTokenId** -- a 76-character token hash that identifies a specific YES or NO outcome token. This caused:

1. **Inconsistency with Kalshi**: Kalshi YES/NO rows share the same `market_id`, differentiated by `outcome_side`. Polymarket had different `market_id` values for YES and NO of the same market.
2. **Difficult cross-exchange matching**: Matching markets across exchanges requires a consistent `market_id` concept (one ID per market, not per token).
3. **Unwieldy IDs**: 76-char hashes are hard to read, query, and debug compared to short numeric IDs like `517310`.

**Before (Polymarket):**
| market_id | outcome_side |
|-----------|-------------|
| `96826264265703...` (76 chars) | YES |
| `41532928029116...` (76 chars) | NO |

**Before (Kalshi):**
| market_id | outcome_side |
|-----------|-------------|
| `KXBTCD-26FEB14-T107250` | YES |
| `KXBTCD-26FEB14-T107250` | NO |

---

## Solution

Use Gamma API's numeric `market.id` (e.g., `1368232`) as the Polymarket `market_id`. Both YES and NO rows now share the same `market_id`, matching Kalshi's pattern. The original clobTokenId is preserved in `source_specific_data.token_id`.

**After (Polymarket):**
| market_id | outcome_side | source_specific_data.token_id |
|-----------|-------------|-------------------------------|
| `517310` | YES | `101676997363687199724245607...` |
| `517310` | NO | `415329280291161070183230948...` |

---

## Algorithm / Logic

```
1. During market sync (syncMarkets):
   a. Build conditionId -> Gamma market ID cache from raw market data
   b. Use market.id (Gamma numeric ID) as market_id in all DB writes
   c. Store clobTokenId in source_specific_data.token_id

2. During WebSocket message handling:
   a. Extract msg.market (condition_id hex hash) from every WS message
   b. Look up Gamma market ID from conditionId cache
   c. Use resolved Gamma ID as market_id in all DB writes
   d. Fall back to clobTokenId (asset_id) if cache miss
```

---

## Configuration

No new configuration parameters. Uses existing caches and sync mechanisms.

---

## Input Data

| Source | Table/API | Fields Used |
|--------|-----------|-------------|
| Gamma API `/markets` | REST API | `market.id` (Gamma numeric ID), `market.conditionId` (hex hash) |
| Polymarket WebSocket | WS messages | `msg.market` (condition_id), `msg.asset_id` (clobTokenId) |

---

## Output Data

| Table | Field | Type | Description |
|-------|-------|------|-------------|
| prediction_markets | market_id | VARCHAR(255) | Now stores Gamma numeric ID (e.g., `517310`) |
| prediction_markets | source_specific_data.token_id | TEXT (JSON) | Preserves original clobTokenId |
| market_latest_data | market_id | VARCHAR(255) | Now stores Gamma numeric ID |
| order_books | market_id | VARCHAR(255) | Now stores Gamma numeric ID |
| trades | market_id | VARCHAR(255) | Now stores Gamma numeric ID |

---

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| conditionId not in cache (WS handler) | Fall back to asset_id (clobTokenId) |
| Market without conditionId (Gamma API) | Skip conditionId cache entry; market.id still used for DB writes |
| Transition period (old + new rows) | Old clobTokenId rows deleted via SQL cleanup; new rows repopulated on sync |

---

## Acceptance Criteria

- [x] Polymarket `market_id` is short numeric Gamma ID in all tables
- [x] YES and NO rows share the same `market_id`, differentiated by `outcome_side`
- [x] Original clobTokenId preserved in `source_specific_data.token_id`
- [x] No old clobTokenId rows remain in `prediction_markets` or `market_latest_data`
- [x] WebSocket handlers (book, price_change, last_trade_price) all use Gamma ID
- [x] All existing tests pass
- [x] Smoke tests pass after deployment (10/10)

---

## Examples

### Example 1: prediction_markets row

**Before:**
```
market_id:    101676997363687199724245607342877036148401850938023978421879460310389391082353
outcome_side: YES
title:        Will Trump deport less than 250,000?
```

**After:**
```
market_id:    517310
outcome_side: YES
title:        Will Trump deport less than 250,000?
source_specific_data: {"condition_id":"0x...","volume":1234,"liquidity":5678,"token_id":"101676997363687199724245607342877036148401850938023978421879460310389391082353"}
```

### Example 2: YES/NO pairing

```
market_id | outcome_side | title
517310    | YES          | Will Trump deport less than 250,000?
517310    | NO           | Will Trump deport less than 250,000?
```

---

## Notes

- No database migration required -- VARCHAR column accepts any string.
- Old rows were cleaned up via DELETE statements after deployment, not via self-healing.
- Trade counts may show 0 for up to 24h after migration as historical trades still reference clobTokenId.
