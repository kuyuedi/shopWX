# Technical: Closed Market Cleanup

Technical implementation details for the closed market cleanup feature.

---

## Database Schema Changes

### New Indexes (recommended)

```sql
-- Speeds up Phase 2 delete queries (finding closed/resolved markets by age)
CREATE INDEX CONCURRENTLY idx_prediction_markets_cleanup
  ON direct_exchanges_data.prediction_markets (source_id, exchange_id, status, updated_at)
  WHERE status IN ('Closed', 'Resolved', 'Cancelled');

-- Speeds up Phase 1 stale detection (finding open markets not recently updated)
CREATE INDEX CONCURRENTLY idx_prediction_markets_stale_check
  ON direct_exchanges_data.prediction_markets (source_id, exchange_id, updated_at)
  WHERE status = 'Open';
```

No new tables or columns required.

---

## Data Flow

### Phase 1: Stale Detection (after each sync)

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  API Fetch   │ --> │  Batch       │ --> │  Mark Stale  │
│  Active Mkts │     │  Upsert      │     │  as Closed   │
└──────────────┘     └──────────────┘     └──────────────┘
  syncStartTime        updated_at=NOW()    WHERE updated_at
  captured before      for all active       < syncStartTime
  upserts begin        markets              AND status='Open'
```

### Phase 2: Periodic Cleanup (setInterval)

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Find Closed │ --> │  Delete      │ --> │  Delete      │
│  Markets     │     │  Latest Data │     │  Markets     │
│  > retention │     │  (FK first)  │     │  (main table)│
└──────────────┘     └──────────────┘     └──────────────┘
```

---

## Dependencies

### Prerequisites

1. Database indexes should be created for performance (optional but recommended)
2. Existing `upsertPredictionMarketsBatch()` already sets `updated_at = NOW()`

### Runtime Dependencies

| Component | Required For |
|-----------|-------------|
| shared/db/queries.ts | markStaleMarketsAsClosed(), deleteClosedMarkets() |
| kalshi-listener/index.ts | Cleanup interval setup |
| polymarket-listener/index.ts | Cleanup interval setup |

---

## Files Modified

| File | Change |
|------|--------|
| `packages/shared/src/db/queries.ts` | Add `markStaleMarketsAsClosed()` + `deleteClosedMarkets()` |
| `packages/kalshi-listener/src/services/marketSync.ts` | Call mark after upsert, accept/return syncStartTime |
| `packages/kalshi-listener/src/index.ts` | Add cleanup interval |
| `packages/polymarket-listener/src/services/gammaApi.ts` | Call mark after upsert, accept/return syncStartTime |
| `packages/polymarket-listener/src/index.ts` | Add cleanup interval |
| `docker-compose.yml` | Add CLEANUP_INTERVAL_MS and CLEANUP_RETENTION_MS env vars |

---

## Migration Checklist

- [x] Run index creation SQL on server (optional, recommended)
- [x] Deploy application code
- [x] Verify stale markets are being marked after first sync cycle
- [x] Verify periodic cleanup is deleting old closed markets

---

## Rollback Plan

If issues arise:

```sql
-- Rollback indexes (if created)
DROP INDEX IF EXISTS direct_exchanges_data.idx_prediction_markets_cleanup;
DROP INDEX IF EXISTS direct_exchanges_data.idx_prediction_markets_stale_check;
```

To disable cleanup without redeploying, set env vars:
- `CLEANUP_INTERVAL_MS=0` — disables periodic cleanup
- Remove the `markStaleMarketsAsClosed()` call requires a code deploy

---

## Performance Considerations

- **Batched deletes**: 1000 rows per batch to avoid long lock holds
- **Partial indexes**: Only index rows matching the status filter conditions
- **ctid-based batching**: Uses PostgreSQL physical row IDs for efficient pagination
- **market_latest_data deleted first**: Avoids FK-like orphan issues (same composite key)
