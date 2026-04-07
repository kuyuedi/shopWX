# Technical: Use Gamma Market ID for Polymarket market_id

Technical implementation details for this feature.

---

## Database Schema Changes

No schema changes required. The `market_id` column is `VARCHAR(255)` and accepts both the old 76-char clobTokenId and the new short numeric Gamma ID.

### Data Cleanup (one-time migration)

```sql
-- Delete old clobTokenId rows (replaced by new Gamma ID rows on next sync)
DELETE FROM direct_exchanges_data.prediction_markets
WHERE exchange_id = 'POLYMARKET' AND LENGTH(market_id) > 20;

DELETE FROM direct_exchanges_data.market_latest_data
WHERE exchange_id = 'POLYMARKET' AND LENGTH(market_id) > 20;
```

Old order_book rows expire via the existing 3-hour server cron cleanup. Old trades retain their clobTokenId as historical data.

---

## Data Flow

```
┌──────────────────┐     ┌─────────────────────┐     ┌──────────────────┐
│  Gamma API       │     │  outcomeSideCache.ts │     │   PostgreSQL     │
│  /markets        │ --> │  conditionIdCache    │     │                  │
│  (market.id,     │     │  conditionId ->      │     │                  │
│   conditionId)   │     │    Gamma market ID   │     │                  │
└──────────────────┘     └──────────┬────────────┘     └────────▲─────────┘
                                   │                           │
┌──────────────────┐               │                           │
│  Polymarket WS   │     ┌────────▼────────────┐              │
│  msg.market =    │ --> │  handlers.ts         │ ─────────────┘
│  condition_id    │     │  resolve Gamma ID    │
│  msg.asset_id =  │     │  from cache          │
│  clobTokenId     │     └─────────────────────┘
└──────────────────┘
```

### Sync path (every 5 min)
1. `syncMarkets()` fetches markets from Gamma API
2. Builds `conditionId -> Gamma market ID` map and populates cache via `bulkSetGammaMarketId()`
3. Writes `prediction_markets` and `market_latest_data` using `market.id` as `market_id`
4. Stores `clobTokenId` in `source_specific_data.token_id`

### WebSocket path (real-time)
1. WS message arrives with `msg.market` (condition_id) and `msg.asset_id` (clobTokenId)
2. Handler resolves Gamma market ID: `getGammaMarketId(conditionId) || assetId`
3. Writes to `order_books`, `market_latest_data`, `trades` using resolved Gamma ID

---

## Files Modified

| File | Change |
|------|--------|
| `packages/shared/src/utils/outcomeSideCache.ts` | Added `conditionIdCache` Map, `getGammaMarketId()`, `bulkSetGammaMarketId()`, `getConditionIdCacheSize()` |
| `packages/polymarket-listener/src/services/gammaApi.ts` | `syncMarkets()`: build conditionId map, use `market.id` for DB writes, store clobTokenId in `source_specific_data.token_id`, populate cache via `bulkSetGammaMarketId()` |
| `packages/polymarket-listener/src/websocket/handlers.ts` | `handleBook()`, `handlePriceChange()`, `handleLastTradePrice()`: extract `msg.market` (condition_id), resolve Gamma market ID via `getGammaMarketId()` |

### Files NOT modified
- `packages/polymarket-listener/src/transformers/normalize.ts` -- normalizer still outputs clobTokenId as `marketId` (used for outcome_side cache and eventMapping lookups)
- `packages/shared/src/db/queries.ts` -- no query changes needed
- `packages/shared/src/db/types.ts` -- no type changes needed

---

## Dependencies

### Prerequisites

1. Gamma API must return `market.id` (numeric) and `market.conditionId` (hex hash) per market
2. Polymarket WebSocket messages must include `msg.market` field (condition_id)

### Runtime Dependencies

| Component | Required For |
|-----------|-------------|
| `conditionIdCache` (outcomeSideCache.ts) | WebSocket handlers to resolve Gamma market ID from condition_id |
| `outcomeSideCache` (existing) | WebSocket handlers to resolve outcome_side from clobTokenId (unchanged) |
| Market sync (every 5 min) | Populates both caches on startup and periodically |

---

## Migration Checklist

- [x] Deploy application code (commit `3b83fbc`)
- [x] Verify new rows have Gamma market IDs
- [x] Delete old clobTokenId rows from `prediction_markets`
- [x] Delete old clobTokenId rows from `market_latest_data`
- [x] Restart kalshi-listener and healthcheck (stopped by `docker compose down`)
- [x] Verify all tables clean (0 old rows, all new Gamma IDs)
- [x] Smoke tests pass (10/10)

---

## Rollback Plan

If issues arise:

1. Revert commit `3b83fbc` and redeploy -- code will go back to using clobTokenId
2. Old clobTokenId rows will be recreated by the first `syncMarkets()` run
3. New Gamma ID rows can be cleaned up:

```sql
DELETE FROM direct_exchanges_data.prediction_markets
WHERE exchange_id = 'POLYMARKET' AND LENGTH(market_id) <= 20;

DELETE FROM direct_exchanges_data.market_latest_data
WHERE exchange_id = 'POLYMARKET' AND LENGTH(market_id) <= 20;
```

---

## Testing Strategy

### Unit Tests

All existing tests pass (145/145). No new test files added since the change is in the integration layer (cache population and DB writes), not in calculation logic.

**Affected test files:**
- `packages/shared/src/utils/__tests__/outcomeSideCache.test.ts` -- 8 tests pass (cache clear now also clears conditionIdCache)
- `packages/polymarket-listener/src/websocket/__tests__/handlers.test.ts` -- 12 tests pass
- `packages/polymarket-listener/src/transformers/__tests__/normalize.test.ts` -- 19 tests pass (normalizer unchanged)

### Integration Verification

Verified via SQL queries after deployment:

| Check | Result |
|-------|--------|
| All Polymarket market_ids are short Gamma IDs | 48,780 rows, 0 old |
| YES/NO share same market_id | 19,861 markets with both sides |
| clobTokenId preserved in source_specific_data | Confirmed |
| Recent trades use Gamma ID | 5,341 new-format trades |
| Recent order_books use Gamma ID | 5,341 new-format rows |
| Smoke tests | 10/10 passed |

---

## Performance Considerations

- **conditionIdCache memory**: ~10k entries (one per active market condition), negligible memory (~1MB)
- **No additional API calls**: conditionId comes from the same `/markets` response already being fetched
- **No query changes**: Same batch upsert queries, just different market_id values
- **Cache fallback**: If conditionId cache misses, falls back to clobTokenId (graceful degradation, not a crash)
