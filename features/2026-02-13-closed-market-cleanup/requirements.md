# Feature: Closed Market Cleanup

**Status**: COMPLETED
**Priority**: High
**Created**: 2026-02-13

---

## Summary

Automatically detect and clean up closed/resolved prediction markets that accumulate in the database.

---

## Problem

Both listeners only sync active/open markets. When a market closes, it simply stops appearing in the API — its status stays "Open" forever in the DB. Closed/resolved markets accumulate indefinitely:

- **Kalshi**: 501,956 Open, 35,738 Closed, 10,914 Resolved
- **Polymarket**: 826,539 Closed, 58,273 Open
- **Total ~874k non-open rows** cluttering the table

---

## Solution

Two-phase cleanup:

1. **Phase 1 (Detect)**: After each market sync, mark any "Open" market whose `updated_at` wasn't refreshed as "Closed" — it was dropped from the active API response.
2. **Phase 2 (Delete)**: Periodically delete rows where status is Closed/Resolved/Cancelled and `updated_at` is older than the retention period.

---

## Algorithm / Logic

### Phase 1: Mark Stale Markets

```
1. Record syncStartTime = NOW() before upserts begin
2. Run upsertPredictionMarketsBatch() for all active markets (sets updated_at = NOW())
3. UPDATE prediction_markets SET status='Closed', updated_at=NOW()
   WHERE source_id=X AND exchange_id=X AND status='Open' AND updated_at < syncStartTime
```

### Phase 2: Delete Old Closed Markets

```
1. Every CLEANUP_INTERVAL_MS (default 1 hour):
2. DELETE FROM market_latest_data WHERE (source_id, exchange_id, market_id, outcome_side) IN
   (SELECT ... FROM prediction_markets WHERE status IN ('Closed','Resolved','Cancelled')
    AND updated_at < NOW() - retention_interval)
3. DELETE FROM prediction_markets WHERE status IN ('Closed','Resolved','Cancelled')
   AND updated_at < NOW() - retention_interval
4. Batch deletes in groups of 1000 to avoid lock contention
```

---

## Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| CLEANUP_INTERVAL_MS | How often the periodic delete runs | 3600000 (1 hour) |
| CLEANUP_RETENTION_MS | How long closed markets are kept before deletion | 86400000 (24 hours) |

---

## Input Data

| Source | Table/API | Fields Used |
|--------|-----------|-------------|
| prediction_markets | DB table | source_id, exchange_id, status, updated_at |
| market_latest_data | DB table | source_id, exchange_id, market_id, outcome_side |

---

## Output Data

No new columns or tables. Existing rows are updated (status) or deleted.

---

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| First sync after deploy | All markets get fresh updated_at, no stale marking |
| Sync fails midway | syncStartTime prevents marking markets that weren't attempted |
| Market re-opens | Next sync upserts it back with status='Open' |
| No closed markets to delete | Delete query returns 0, logged at debug level |

---

## Acceptance Criteria

- [x] After sync, markets that stopped appearing in API are marked Closed
- [x] Periodic cleanup deletes Closed/Resolved/Cancelled markets older than retention
- [x] market_latest_data rows are cleaned up alongside prediction_markets
- [x] Batched deletes prevent lock contention
- [x] Both Kalshi and Polymarket listeners have cleanup enabled
- [x] Configurable via environment variables
