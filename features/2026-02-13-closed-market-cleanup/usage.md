# Usage: Closed Market Cleanup

How to use and verify this feature.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CLEANUP_INTERVAL_MS` | `3600000` (1 hour) | How often the periodic delete runs |
| `CLEANUP_RETENTION_MS` | `86400000` (24 hours) | How long closed markets are kept before deletion |

Set in `docker-compose.yml` or `.env` file.

---

## Verification Queries

### 1. Status distribution after deployment

```sql
SELECT exchange_id, status, COUNT(*)
FROM direct_exchanges_data.prediction_markets
GROUP BY exchange_id, status
ORDER BY exchange_id, status;
```

**Expected:** After first sync cycle, many previously "Open" markets should now be "Closed".

### 2. Verify closed markets are being cleaned up

```sql
SELECT exchange_id, status, MIN(updated_at), MAX(updated_at), COUNT(*)
FROM direct_exchanges_data.prediction_markets
WHERE status IN ('Closed', 'Resolved', 'Cancelled')
GROUP BY exchange_id, status;
```

**Expected:** After retention period, old closed markets should be deleted. `MAX(updated_at)` should be within retention window.

### 3. Monitor cleanup progress over time

```sql
SELECT
    date_trunc('hour', updated_at) as hour,
    exchange_id,
    status,
    COUNT(*)
FROM direct_exchanges_data.prediction_markets
WHERE updated_at > NOW() - INTERVAL '24 hours'
GROUP BY hour, exchange_id, status
ORDER BY hour DESC, exchange_id;
```

### 4. Verify market_latest_data is also cleaned up

```sql
SELECT
    mld.source_id,
    COUNT(*) as orphan_count
FROM direct_exchanges_data.market_latest_data mld
LEFT JOIN direct_exchanges_data.prediction_markets pm
    ON mld.source_id = pm.source_id
    AND mld.exchange_id = pm.exchange_id
    AND mld.market_id = pm.market_id
    AND mld.outcome_side = pm.outcome_side
WHERE pm.market_id IS NULL
GROUP BY mld.source_id;
```

**Expected:** Zero orphan rows (market_latest_data without matching prediction_markets).

---

## Log Messages

### Phase 1: Stale Detection

```
{"level":"info","msg":"Marked stale markets as closed","sourceId":"KALSHI_DIRECT","exchangeId":"KALSHI","markedClosed":42}
```

### Phase 2: Periodic Cleanup

```
{"level":"info","msg":"Closed market cleanup completed","sourceId":"KALSHI_DIRECT","exchangeId":"KALSHI","marketsDeleted":150,"latestDataDeleted":150}
```

---

## Troubleshooting

### Markets keep getting marked as Closed then re-appearing as Open

This is expected behavior. If a market was temporarily absent from the API (e.g., API pagination issue), it will be marked Closed, then the next sync will upsert it back as Open. The retention period prevents premature deletion.

### Cleanup not running

Check that `CLEANUP_INTERVAL_MS` is set and > 0. Look for the "Starting closed market cleanup interval" log message at startup.

### Too many markets being marked as Closed

Ensure `syncStartTime` is captured before the upsert loop begins, not after. If the sync takes a long time, markets upserted early in the batch may have `updated_at` slightly before `syncStartTime` if clocks drift — but since both use `NOW()` from the DB, this shouldn't happen.
