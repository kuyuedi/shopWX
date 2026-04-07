# Technical: WebSocket Pool Incremental Updates

---

## Files Changed

### Polymarket

**`packages/polymarket-listener/src/websocket/pool.ts`**
- Added `clientAssets: Map<PolymarketWebSocketClient, Set<string>>` to track per-client subscriptions
- Rewrote `subscribeToMarkets()` for incremental updates
- `buildPool()` now populates `clientAssets` on initial build

### Kalshi

**`packages/kalshi-listener/src/websocket/pool.ts`**
- Added `clientTickers: Map<KalshiWebSocketClient, Set<string>>` to track per-client subscriptions
- Rewrote `subscribeToMarkets()` for incremental updates
- `buildPool()` now populates `clientTickers` on initial build

**`packages/kalshi-listener/src/websocket/client.ts`**
- Added `unsubscribeFromMarkets(tickers: string[])` method
- Added import of `getBatchUnsubscriptionMessage`

**`packages/kalshi-listener/src/websocket/subscriptions.ts`**
- Added `getBatchUnsubscriptionMessage()` function

---

## Data Flow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Market Sync  │ --> │  Pool.sub()  │ --> │  Per-Client   │
│ (5min cycle) │     │  Diff Logic  │     │  Subscribe    │
└──────────────┘     └──────────────┘     └──────────────┘
                           │
                     ┌─────┴─────┐
                     │ Compare:  │
                     │ new vs    │
                     │ current   │
                     └─────┬─────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Replace  │ │ Fill     │ │ New      │
        │ closed   │ │ spare    │ │ sockets  │
        │ markets  │ │ capacity │ │ overflow │
        └──────────┘ └──────────┘ └──────────┘
```

---

## Platform Differences

### Polymarket
- No native unsubscribe: re-sending `{type: 'market', assetIds: [...]}` replaces the subscription entirely
- Closed markets are simply removed from tracking; the next `subscribeToMarkets()` call to the client sends the updated full list
- Max 500 assets per socket

### Kalshi
- Native `subscribe`/`unsubscribe` commands supported
- Closed markets are explicitly unsubscribed via `getBatchUnsubscriptionMessage()`
- New markets are then subscribed via `getBatchSubscriptionMessage()`
- Max 2000 tickers per socket
- Batched with configurable `WS_SUBSCRIPTION_BATCH_SIZE` (default 250) and `WS_SUBSCRIPTION_DELAY_MS` (default 100ms)

---

## Related Fix: Kalshi volume_traded bigint

**`packages/kalshi-listener/src/websocket/handlers.ts`** (line ~163)

Kalshi's `_fp` (floating point) volume fields send values as float strings (e.g., `"3204.00"`). These were passed directly to a PostgreSQL `bigint` column, causing `invalid input syntax for type bigint` errors.

Fix: `Math.round(Number(rawVolume))` to convert float strings to integers before DB insertion.

---

## Rollback Plan

If incremental updates cause issues, revert to the previous behavior by restoring the old `subscribeToMarkets()` that calls `closeAll()` first. The previous approach was functionally correct but caused the oscillation pattern.

---

## Performance Considerations

- Socket count remains stable after initial build (no connection churn)
- No bulk orderbook snapshots on reconnect (eliminates timestamp clustering)
- Incremental updates are O(n) where n = number of new/closed markets (typically small)
- Memory overhead of `Map<Client, Set<string>>` is negligible (~100KB for 20k markets)
