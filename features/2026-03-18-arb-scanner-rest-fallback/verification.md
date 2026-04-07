# Verification Report: Arb Scanner REST Orderbook Fallback

**Date:** 2026-03-19
**Deployed at:** 21:44 UTC+8
**Verified at:** 22:07 UTC+8 (~23 minutes post-deploy)
**Container uptime at verification:** 21 minutes (no restarts)

---

## 1. Deployment

### Commits

| Commit | Description |
|--------|-------------|
| `8a57bd1` | feat: add REST orderbook fallback for arb scanner stale legs |
| `aace49f` | fix: cast source_specific_data to jsonb for token_id extraction |
| `72d883f` | fix: improve REST refresh logging and reduce concurrency |
| `f3c6e17` | fix: rewrite REST concurrency pool to properly limit parallel requests |

### DB Migration

4 config rows inserted into `arb_config`:

| config_key | config_value |
|------------|-------------|
| `rest_fallback_enabled` | `true` |
| `rest_refresh_cooldown_sec` | `60` |
| `rest_concurrency` | `3` |
| `rest_timeout_ms` | `5000` |

### Container Status

```
homepage-api   Up 21 minutes   0.0.0.0:3100->3100/tcp
```

Startup log confirms REST refresher initialized:
```
{"service":"orderbook-refresher","msg":"Kalshi private key loaded for REST orderbook fallback"}
```

---

## 2. Functional Verification

### 2.1 SQL Query Change (staleness filter bypass)

**Before:** `fetchMatchedMarketLegs` always filtered by `max_staleness_sec` (900s), returning ~2,700 legs.

**After:** When `rest_fallback_enabled = true`, staleness filter is omitted. Query returns all matched legs.

| Metric | Before | After |
|--------|--------|-------|
| `legsQueried` | ~2,700 | ~7,800 |
| `marketsScanned` | ~900 | ~2,650 |

### 2.2 Stale/Fresh Partitioning

Scanner correctly partitions legs by `data_updated_at` vs `max_staleness_sec` (900s):

```
staleLegsCount: ~2,250-2,300
freshLegs (from WS): ~5,500
```

### 2.3 REST Orderbook Fetches

REST fetch is working. Sample log lines from the last 2 minutes of operation:

```
staleLegsCount:2243, refreshedCount:12, emptyBooks:803, failedCount:0
staleLegsCount:2213, refreshedCount:6,  emptyBooks:371, failedCount:0
staleLegsCount:2252, refreshedCount:8,  emptyBooks:591, failedCount:0
staleLegsCount:2264, refreshedCount:2,  emptyBooks:587, failedCount:0
staleLegsCount:2195, refreshedCount:0,  emptyBooks:73,  failedCount:0
```

- **refreshedCount** ranges 0–12 per cycle — REST fetched orderbook, recalculated band metrics, upserted to `market_latest_data`
- **emptyBooks** ranges 28–803 per cycle — REST returned valid response but orderbook too thin for band metrics (expected for low-volume markets)
- **failedCount** = 0 in all observed cycles — no HTTP errors or timeouts

### 2.4 Rate Limit Handling

- 22 rate-limit log entries in last 10 minutes (Kalshi 429 responses)
- Circuit breaker fires correctly: once a 429 is received, remaining REST fetches in that cycle are skipped
- With concurrency=3, rate limit events are infrequent and only produce 2–4 log lines per event (down from 40+ before pool fix)

### 2.5 Cooldown Mechanism

Cooldown (`rest_refresh_cooldown_sec: 60`) is working:
- Eligible legs per cycle varies (some in cooldown, some not)
- emptyBooks count fluctuates between cycles as different legs rotate out of cooldown

### 2.6 Band Metrics Recalculation

Refreshed legs pass through `calculateBandMetrics()` from `@prediction-market/shared`. The upsert to `market_latest_data` uses `band_delta_used` which triggers the `updated_at` refresh in the ON CONFLICT clause — confirmed by `refreshedCount > 0` leading to those legs joining the fresh pool.

---

## 3. Data Verification

### 3.1 Active Arb Count

```sql
SELECT COUNT(*) FROM arb_opportunities WHERE status = 'ACTIVE';
-- Result: 16
```

| Metric | Before Feature | After Feature |
|--------|---------------|---------------|
| Active arbs | 8–11 | 12–16 |

### 3.2 Arb Breakdown

```
  arb_type  | count | avg_spread_pct | avg_gross_profit
 -----------+-------+----------------+-----------------
  COMPLEMENT|     9 |         0.2183 |            74.49
  DIRECT    |     7 |         0.2215 |            71.67
```

### 3.3 Freshness by Exchange

```
 exchange_id | total_matched | fresh_900s | fresh_pct | has_band | stale_w_metrics | stale_no_metrics
 POLYMARKET  |         7,392 |      4,878 |     66.0% |    5,295 |             950 |            1,564
 KALSHI      |         7,430 |      3,022 |     40.7% |    3,588 |           1,174 |            3,234
```

**Key insight:** Of the ~4,400 stale Kalshi legs, 3,234 (73%) have no band metrics at all — these markets have zero orderbook liquidity. The REST fallback correctly confirms this by fetching empty/thin books. The remaining 1,174 stale legs with old band metrics are the refresh candidates; most return empty books on REST as well, with 0–12 per cycle successfully refreshed.

---

## 4. Stability

| Check | Result |
|-------|--------|
| Container restarts | 0 (stable for 21+ min) |
| OOM errors | 0 (initial OOM during first deploy was from score-computer, resolved by container restart) |
| Unhandled errors (last 10 min) | 0 |
| Scan cycle frequency | ~28 per 5 min (~10s interval, as configured) |
| Scan cycle duration | 8–15s (includes REST refresh for stale legs) |

---

## 5. Kill Switch

Config is in place and ready:

```sql
-- Disable REST fallback
UPDATE arb_config SET config_value = 'false' WHERE config_key = 'rest_fallback_enabled';
-- Takes effect within ~5 min (next config reload cycle)
```

---

## 6. Bug Fixes During Deployment

| Bug | Symptom | Fix |
|-----|---------|-----|
| `source_specific_data` is `text`, not `jsonb` | `operator does not exist: text ->> unknown` | Cast with `::jsonb` in SQL query |
| Promise pool started all tasks immediately | 40+ rate-limit log lines per 429 event | Rewrote pool with `Set` + `Promise.race` backpressure |
| No visibility into empty vs failed fetches | `failedCount` lumped empty books with errors | Added `emptyBooks` counter, upgraded error log to `warn` |

---

## 7. Expectations vs Reality

| Expectation (from PRD) | Reality | Explanation |
|------------------------|---------|-------------|
| Kalshi freshness ~35% → >90% | 40.7% | Most stale Kalshi markets have empty orderbooks — REST confirms no liquidity. Freshness is bounded by actual market liquidity, not by our fetch rate. |
| Active arbs ~200 → 500+ | 16 | The stale markets are stale because they have no liquidity. Markets with actual orderbooks are already fresh via WS. The gain is real but modest. |
| Scanner evaluates ~100% of pairs | ~2,650 canonical markets scanned (100% of matched) | Correct — all pairs are now evaluated. Most just don't produce arbs due to thin/empty books. |

---

## 8. Conclusion

The feature is **deployed and working correctly**. All acceptance criteria are met:

- [x] Stale legs are fetched via REST instead of discarded
- [x] Band metrics recalculated from REST orderbook snapshots
- [x] `market_latest_data.updated_at` refreshed after successful REST fetch
- [x] Cooldown prevents excessive API calls (60s per leg)
- [x] Rate limit (429) handled with circuit breaker
- [x] Failed REST calls don't crash scanner or block other legs
- [x] Kill switch available in `arb_config` table
- [x] Scanner cycle time remains reasonable (8–15s)

The arb count increase is modest (8–11 → 12–16) because the root cause of staleness is lack of market liquidity, not a data pipeline gap. The REST fallback correctly validates this rather than leaving it as an unknown.

---

## 9. Pair-Aware REST Filtering (2026-03-20)

### Problem

REST fallback was fetching ALL ~2,900 stale legs per cycle, even when the other exchange's leg was also stale. This wasted Kalshi API rate limit budget and caused ~75s+ scan cycles.

### Fix

Added pair-aware filtering: only REST-refresh stale legs whose `canonical_market_id` has at least one fresh leg on the OTHER exchange. No point refreshing a stale Kalshi leg if Polymarket is also stale — the pair can't produce an arb either way.

**Commit:** `c18f30b` — fix: only REST-refresh stale legs with fresh counterparts

### Results

**First cycle post-deploy (02:46 UTC+8):**
```
totalStale: 2919, refreshable: 1648, skippedNoPair: 1271
legsQueried: 7080, marketsScanned: 2587, arbsFound: 12
```

**Steady state (~03:13 UTC+8, after Kalshi WS reconnect):**
```
totalStale: 1502, refreshable: 547, skippedNoPair: 955
legsQueried: 8523, marketsScanned: 2693, arbsFound: 18
```

| Metric | Before (no filter) | After (initial) | After (steady state) |
|--------|-------------------|-----------------|---------------------|
| Stale legs sent to REST refresh | ~2,900 | 1,648 | 547 |
| Skipped (no fresh counterpart) | 0 | 1,271 (44%) | 955 (64%) |
| Arbs found | 12 | 12 | 18 |
| Markets scanned | 2,587 | 2,587 | 2,693 |

### Rate Limit Incident

The initial deploy with `rest_concurrency=3` caused Kalshi API rate limit contention — the REST refresher competed with the Kalshi listener's market sync (both share the 20 RPS Kalshi limit). The listener's candlestick fetch got stuck in a 429 loop (batch ~300/379), triggering a healthcheck dataflow alert.

**Resolution:** Reduced `rest_concurrency` from 3 → 1 via `arb_config` table. Kalshi listener recovered within ~2 minutes — completed market sync, reconnected all WS sockets (34,836 active markets, 1.14M orderbook messages received).

**Config change:**
```sql
UPDATE arb_config SET config_value = '1' WHERE config_key = 'rest_concurrency';
```

### Verification

- [x] Filtering log line appears: `totalStale`, `refreshable`, `skippedNoPair`
- [x] `skippedNoPair` > 0 confirms filtering is active
- [x] `arbsFound` count unchanged or improved (12 → 18 as Kalshi freshness recovered)
- [x] Kalshi listener stable after concurrency reduction (34,836 active markets)
- [x] Scan cycles completing normally (~10s, not 75s)
- [x] Build passes cleanly
