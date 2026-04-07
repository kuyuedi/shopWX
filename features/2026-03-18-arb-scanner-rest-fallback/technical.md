# Technical Design: Arb Scanner REST Orderbook Fallback

## Architecture

```
scanForArbs() cycle
  │
  ├─ fetchMatchedMarketLegs(null, minConfidence)   ← no staleness filter
  │
  ├─ Partition legs into fresh / stale
  │    └─ stale = data_updated_at older than maxStalenessSec
  │
  ├─ Pair-aware filtering (2026-03-20)
  │    ├─ Build set of canonical_market_ids with at least one fresh leg
  │    └─ Filter stale legs: only keep those whose canonical_market_id is in the fresh set
  │         └─ Skips ~44% of stale legs (no fresh counterpart = no arb possible)
  │
  ├─ refreshStaleLegs(refreshableStaleLegs)
  │    ├─ Skip legs within cooldown window
  │    ├─ Promise pool (concurrency limit)
  │    ├─ Per-leg: fetchOrderbook → calculateBandMetrics → upsertMarketLatestData
  │    └─ On 429: abort remaining fetches
  │
  ├─ Merge refreshed legs into fresh legs
  │
  └─ Existing arb detection logic (unchanged)
```

## Files Changed

| File | Change |
|------|--------|
| `packages/shared/src/db/queries.ts` | `fetchMatchedMarketLegs` accepts `maxStalenessSeconds: number \| null` — when null, omits staleness WHERE clause |
| `packages/homepage-api/src/services/orderbookRefresher.ts` | **NEW** — REST fetch, band metrics recalc, upsert |
| `packages/homepage-api/src/services/arbScanner.ts` | Partition stale/fresh legs, call refresher, merge results |
| `packages/homepage-api/src/config.ts` | Add `kalshiApiKey`, `kalshiPrivateKeyPath`, `kalshiRestUrl`, `polymarketClobUrl` |
| `packages/homepage-api/src/index.ts` | Call `initRefresher(config)` at startup |
| `docker-compose.yml` | Add env vars + volume mount for homepage-api |

## Kalshi REST Orderbook

**Endpoint:** `GET {KALSHI_REST_URL}/markets/{ticker}/orderbook`

**Auth:** RSA-PSS signed headers (same as WS auth in `packages/kalshi-listener/src/utils/auth.ts`)
- `KALSHI-ACCESS-KEY`: API key
- `KALSHI-ACCESS-SIGNATURE`: RSA-PSS signature of `timestamp + method + path`
- `KALSHI-ACCESS-TIMESTAMP`: Unix timestamp ms

**Response:**
```json
{
  "orderbook": {
    "yes": [[price_cents, qty], ...],
    "no": [[price_cents, qty], ...]
  }
}
```

**Transformation (matches `handlers.ts:334-345`):**
- YES side: bids = yes array (price/100), asks = inverted no array ((100-price)/100)
- NO side: bids = no array (price/100), asks = inverted yes array ((100-price)/100)

## Polymarket REST Orderbook

**Endpoint:** `GET {POLYMARKET_CLOB_URL}/book?token_id={tokenId}`

**Auth:** None required

**Response:**
```json
{
  "bids": [{"price": "0.55", "size": "100"}, ...],
  "asks": [{"price": "0.56", "size": "200"}, ...]
}
```

**Transformation:** Parse price/size strings to numbers, pass directly (already decimal).

**Note:** Polymarket `market_id` in `market_latest_data` is the Gamma numeric ID, but the CLOB API needs the `token_id` (clobTokenId). The token_id is stored in `prediction_markets.source_specific_data->>'token_id'`. A DB lookup is needed to resolve this.

## Cooldown Mechanism

In-memory `Map<string, number>` keyed by `${exchange_id}:${market_id}:${outcome_side}`.
- Before fetching, check if `Date.now() - lastFetchTime < cooldownMs`
- After successful fetch, update the timestamp
- Map is never cleared (entries are small, bounded by number of matched markets)

## Concurrency Control

Simple promise pool: maintain array of active promises, `await Promise.race(pool)` when pool is full. No new dependencies needed.

## Error Handling

- Per-leg try/catch — failure for one leg doesn't affect others
- On HTTP 429: set cycle-level `rateLimited` flag, skip all remaining REST fetches
- On timeout: treat as failure, skip leg
- Log warnings for failed fetches, don't retry within same cycle
