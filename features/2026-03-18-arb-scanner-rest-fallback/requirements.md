# Arb Scanner REST Orderbook Fallback

## Problem

The arb scanner currently only evaluates ~35% of matched market pairs because Kalshi low-volume markets go 15+ minutes without a WebSocket orderbook delta, causing them to fail the staleness filter (`max_staleness_sec = 900`). This means the majority of potential arbitrage opportunities are missed.

## Solution

Add a REST API fallback to fetch fresh orderbook data for stale market legs before evaluating arb opportunities. When a matched market leg's `market_latest_data` is stale (older than `max_staleness_sec`), the scanner fetches the orderbook via REST API, recalculates band metrics, upserts to `market_latest_data`, and uses the refreshed data for arb detection.

## Requirements

1. **Remove SQL-level staleness filter** — Fetch ALL matched market legs regardless of staleness, handle freshness checks in application code
2. **REST orderbook fetch for Kalshi** — Use Kalshi REST API (`GET /markets/{ticker}/orderbook`) with RSA-PSS authentication to fetch current orderbook
3. **REST orderbook fetch for Polymarket** — Use Polymarket CLOB API (`GET /book?token_id={tokenId}`) to fetch current orderbook (no auth required)
4. **Band metrics recalculation** — Apply `calculateBandMetrics()` to the fetched orderbook and upsert refreshed data to `market_latest_data`
5. **Cooldown per leg** — Don't re-fetch a leg more often than `rest_refresh_cooldown_sec` (default 60s) to avoid hammering APIs
6. **Concurrency control** — Limit concurrent REST fetches to `rest_concurrency` (default 10)
7. **Timeout** — Per-request timeout of `rest_timeout_ms` (default 5000ms)
8. **Kill switch** — `rest_fallback_enabled` config flag in `arb_config` table to disable without redeployment
9. **429 handling** — On rate limit response, skip remaining REST fetches for the current cycle
10. **Graceful degradation** — If a REST fetch fails, skip that leg silently (don't block other legs or crash the scanner)
11. **Pair-aware REST filtering** — Only REST-refresh stale legs that have at least one fresh leg on the OTHER exchange for the same `canonical_market_id`. No point refreshing a stale Kalshi leg if the Polymarket side is also stale — the pair can't produce an arb either way. This reduces REST calls from ~1,400 to ~50-100 per cycle and brings scan time from ~75s back to ~10-15s.

## Expected Impact

- Kalshi leg freshness: ~35% → >90%
- Active arb count: ~200-260 → potentially 500+
- No impact on existing WebSocket-based data flow
- Reduced API pressure: pair-aware filtering drops REST calls from ~1,400 to ~50-100 per cycle

## Configuration (arb_config table)

| Key | Default | Description |
|-----|---------|-------------|
| `rest_fallback_enabled` | `true` | Enable/disable REST fallback |
| `rest_refresh_cooldown_sec` | `60` | Min seconds between REST fetches per leg |
| `rest_concurrency` | `10` | Max concurrent REST requests |
| `rest_timeout_ms` | `5000` | Per-request timeout in ms |
