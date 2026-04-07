# Feature: Market Detail Page Performance Fix

**Status**: DONE
**Priority**: P0
**Created**: 2026-03-29

---

## Summary

Fix market detail page load times for large events (30+ outcomes) by removing an expensive `order_books` table scan and adding a 30-second response cache.

---

## Problem

Market detail pages for events with many outcomes (e.g., "2028 Democratic nominee for President?" with 38 markets) take 6-30 seconds to load. The worst case was 29.9 seconds for the Dem Nominee page.

### Root Cause Analysis

| Bottleneck | Query | Impact |
|-----------|-------|--------|
| `order_books` batch scan | `SELECT DISTINCT ON (market_id, exchange_id) ... FROM order_books WHERE market_id = ANY($1) AND time_exchange > NOW() - INTERVAL '4 hours'` | Scans millions of rows across hourly partitions for ALL outcomes in the event. This was the primary bottleneck. |
| `trades` history scan | `SELECT ... FROM trades WHERE market_id = ANY($1) AND timestamp >= NOW() - INTERVAL '7 days'` | Scans 7 days of daily partitions for the price history chart. Secondary bottleneck (history endpoint only). |

**Why some events were slow and others fast**: Load time correlated with the event's orderbook write volume, not the number of markets. The 2028 Dem Nominee event has high-volume political markets with frequent orderbook snapshots, making the 4-hour scan enormous. The Masters golf event had fewer historical snapshots and loaded in 0.35s despite having more markets (51 vs 38).

### Benchmarks (Before)

| Event | Markets | Detail Load | History Load |
|-------|---------|-------------|-------------|
| Dem Nominee 2028 | 38 | **29.9s** | **18.7s** |
| Golf Open | 48 | **7.6s** | — |
| GOP Nominee 2028 | 32 | **6.1s** | **17.0s** |
| World Cup | 42 | **2.9s** | — |
| Single market (CM-xxx) | 1 | 0.37s | — |

---

## Solution

### Fix 1: Remove `order_books` batch query from event detail

The event detail endpoint (`handleEventDetail`) was querying the `order_books` table to override Level 1 bid/ask prices. This is unnecessary because:

- `market_latest_data` (already fetched in the CTE) provides the same `band_vwap_bid`, `band_vwap_ask`, and `band_liquidity_qty` values
- Full orderbook data is only needed when the user explicitly clicks an outcome to view the orderbook (served by the separate `/orderbook` endpoint)

**Action**: Removed the entire `order_books` batch query block (~70 lines) from `handleEventDetail`. Band metrics from `market_latest_data` are used for the overview page. The `/orderbook` endpoint (which fetches per-market, not batch) is unchanged.

### Fix 2: Add 30-second in-memory response cache

Added a response cache for the two expensive endpoints:

| Endpoint | Cache Key | TTL |
|----------|-----------|-----|
| Event detail (`handleEventDetail`) | `event-detail:{eventId}:{lang}` | 30s |
| Event history (`handleEventHistory`) | `event-history:{eventId}:{tf}:{split}` | 30s |

The cache auto-evicts entries older than 30s and caps at 200 entries to prevent memory leaks.

---

## Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `RESPONSE_CACHE_TTL_MS` | Response cache TTL (in-code constant) | 30000 (30s) |

---

## Input Data

No changes to input data. The fix removes a query, it does not add new data sources.

| Source | Table | Status |
|--------|-------|--------|
| `market_latest_data` | band_vwap_bid, band_vwap_ask, band_liquidity_qty_* | Already used (no change) |
| `order_books` | bids, asks | **Removed from event detail** (still used by `/orderbook` endpoint) |

---

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| Cache miss (first request) | Full query runs, result cached for 30s |
| Cache hit (within 30s) | Instant response from memory |
| Cache eviction (>200 entries) | Old entries cleaned up, no memory leak |
| Different languages | Cached separately per `lang` parameter |
| Single market (CM-xxx) | Not cached (fast enough without cache) |

---

## Acceptance Criteria

- [x] Event detail page loads in < 2s cold for all events
- [x] Event detail page loads in < 500ms cached
- [x] Prices (bid/ask/depth) still display correctly from band metrics
- [x] Price history chart still renders correctly
- [x] Orderbook endpoint (`/markets/:id/orderbook`) unchanged and working
- [x] No impact on arb scanner, listeners, or other services
- [x] Zero frontend console errors

---

## Benchmarks (After)

| Event | Markets | Detail (cold) | Detail (cached) | Speedup |
|-------|---------|---------------|-----------------|---------|
| Dem Nominee 2028 | 38 | **1.45s** | **0.37s** | 20x / 80x |
| Golf Open | 48 | **0.38s** | **0.36s** | 20x |
| GOP Nominee 2028 | 32 | **0.38s** | **0.36s** | 16x |
| World Cup | 42 | **0.38s** | **0.38s** | 7.6x |
| Single market | 1 | 0.40s | — | same |

History endpoint: cold query still 10-20s (trades table scan), but cached response is 0.36s.

---

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `packages/homepage-api/src/routes/marketDetail.ts` | **MODIFIED** | Removed order_books batch query, added response cache |

No other files modified. No database changes. No config changes.

---

## Notes

- The history endpoint cold query (trades table scan over 7-day partitions) remains slow. A future optimization could pre-aggregate price buckets or use a materialized view.
- The 30s cache TTL is a balance between freshness and performance. Can be tuned via the `RESPONSE_CACHE_TTL_MS` constant.
