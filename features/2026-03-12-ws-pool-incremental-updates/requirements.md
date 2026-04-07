# Fix: WebSocket Pool Incremental Updates

**Status**: DONE
**Priority**: High
**Created**: 2026-03-12

---

## Summary

Changed WebSocket pool subscription management from full teardown/rebuild to incremental updates, eliminating arb count oscillation caused by bulk `updated_at` timestamp resets.

---

## Problem

Every market sync cycle (5 min for Polymarket, 60s for Kalshi), the WebSocket pool would:

1. Close ALL existing WebSocket connections (`closeAll()`)
2. Rebuild the entire pool from scratch
3. Upon reconnection, exchanges send fresh orderbook snapshots for all subscribed markets
4. These snapshots trigger band metric writes → `updated_at = NOW()` on all markets simultaneously
5. The arb scanner's `updated_at > NOW() - 30s` filter sees ALL markets as "fresh" → artificially inflated arb count
6. After 30s, timestamps age out → arb count drops back to normal
7. Cycle repeats → oscillation pattern: ~4100 legs / ~200 arbs → ~2700 legs / ~42 arbs

This was Root Cause 2 of the arb oscillation issue. Root Cause 1 (sync writes resetting `updated_at`) was fixed separately in `packages/shared/src/db/queries.ts`.

---

## Solution

Replace full pool teardown/rebuild with incremental subscription management:

1. On first call, build the full pool as before
2. On subsequent calls, compute the diff between current subscriptions and new market list
3. New markets replace closed/inactive markets on existing sockets (closed markets go silent on WebSocket — no active unsubscription needed for Polymarket; Kalshi uses native unsubscribe)
4. If sockets have spare capacity, new markets fill those slots
5. Only create new sockets if all existing ones are full
6. Never tear down existing connections unless `closeAll()` is explicitly called

---

## Algorithm / Logic

```
1. If pool is empty → buildPool(markets) (first call)
2. Compute currentIds = union of all per-client subscription sets
3. added = markets.filter(m => !currentIds.has(m))
4. If added.length === 0 → skip (no changes needed)
5. For each client with closed markets (in current set but not in new set):
   a. Remove closed markets from tracking
   b. Add new markets in their place (up to closedCount)
   c. Polymarket: re-send full asset list to replace subscriptions
   d. Kalshi: send unsubscribe for closed, then subscribe for new
6. For each client with spare capacity:
   a. Add remaining new markets up to marketsPerSocket limit
7. If still remaining → create new sockets for overflow
```

---

## Configuration

No new configuration parameters. Uses existing:

| Parameter | Description | Default |
|-----------|-------------|---------|
| `MARKETS_PER_SOCKET` | Polymarket assets per WebSocket | 500 |
| `KALSHI_MARKETS_PER_SOCKET` | Kalshi tickers per WebSocket | 2000 |

---

## Acceptance Criteria

- [x] No full pool teardown on subsequent sync cycles
- [x] Socket count remains stable (no oscillation in connected sockets)
- [x] New markets are picked up and receive WebSocket data
- [x] Closed markets are replaced by new ones on the same sockets
- [x] No bulk `updated_at` timestamp resets (except initial startup)
- [x] Arb count stable: legs ~2600-3000, arbs ~40-65

---

## Verification

```sql
-- Check for bulk timestamp clustering (should see NO spikes of 1000+ rows/sec)
SELECT date_trunc('second', updated_at) AS sec,
       COUNT(*)
FROM direct_exchanges_data.market_latest_data
WHERE updated_at > NOW() - INTERVAL '10 minutes'
GROUP BY sec
HAVING COUNT(*) > 100
ORDER BY sec;

-- Verify sync writes don't reset updated_at
SELECT COUNT(*)
FROM direct_exchanges_data.market_latest_data
WHERE band_delta_used IS NULL
  AND updated_at > NOW() - INTERVAL '2 minutes';
-- Should be 0 after initial startup
```

---

## Notes

- Polymarket doesn't support native unsubscribe — re-sending the full asset list replaces the subscription
- Kalshi supports native `subscribe`/`unsubscribe` commands — closed markets are explicitly unsubscribed
- Closed markets naturally go silent on WebSocket, so they don't waste bandwidth even if not explicitly unsubscribed
- Per-client tracking uses `Map<Client, Set<string>>` to know exactly which markets are on which sockets
