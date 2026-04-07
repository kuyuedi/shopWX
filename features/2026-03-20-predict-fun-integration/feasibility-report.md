# Predict.fun Integration Feasibility Report

## Executive Summary

**Verdict: YES — predict.fun can be integrated in the same way as Kalshi and Polymarket.** The API provides all data needed for market sync, event ingestion, WebSocket orderbook streaming, and band metrics calculation. Price format is identical to Polymarket (decimal 0-1). A bonus: their markets already contain `polymarketConditionIds` and `kalshiMarketTicker` fields for free cross-exchange mapping.

---

## 1. REST API — Market & Event Sync

### 1.1 List Markets: `GET /v1/markets`

**Server:** `https://api.predict.fun` (mainnet, requires `x-api-key` header) / `https://api-testnet.predict.fun` (testnet, no key)

**Pagination:** Cursor-based (`cursor` + `first` params), same pattern as Polymarket.

**Key query params:**
| Param | Values | Notes |
|-------|--------|-------|
| `status` | `REGISTERED`, `RESOLVED` | `REGISTERED` = active/open |
| `tradingStatus` | `OPEN`, `CLOSED`, `CANCEL_ONLY`, `MATCHING_NOT_ENABLED` | Filter tradable markets |
| `sort` | `VOLUME_24H_DESC`, `VOLUME_TOTAL_DESC`, etc. | Useful for prioritization |
| `tagIds` | comma-separated or repeated | Filter by category tags |
| `marketVariant` | `DEFAULT`, `SPORTS_MATCH`, `CRYPTO_UP_DOWN`, `TWEET_COUNT`, `SPORTS_TEAM_MATCH` | Market type filter |

**Market object — key fields for our integration:**

| Field | Type | Maps to our schema | Notes |
|-------|------|-------------------|-------|
| `id` | number | `market_id` | Unique market identifier |
| `title` | string | `title` / outcome name | e.g. "Oklahoma City Thunder" |
| `question` | string | `title` (parent question) | e.g. "Will the OKC Thunder win the 2026 NBA Finals?" |
| `status` | string | `status` | REGISTERED=Open, RESOLVED=Closed |
| `tradingStatus` | string | — | OPEN, CLOSED, CANCEL_ONLY |
| `categorySlug` | string | `event_id` (links market→event) | e.g. "2026-nba-champion" |
| `outcomes[]` | array | YES/NO outcome mapping | Each has `name`, `indexSet`, `onChainId`, `status` |
| `feeRateBps` | number | Fee rate for arb calc | e.g. 200 = 2% |
| `decimalPrecision` | number | Price precision | 2 or 3 decimal places |
| `kalshiMarketTicker` | string\|null | Cross-exchange mapping | Direct link to Kalshi market |
| `polymarketConditionIds` | string[] | Cross-exchange mapping | Direct link to Polymarket conditions |
| `isNegRisk` | boolean | Outcome type flag | Affects how YES/NO complement works |
| `createdAt` | ISO date | `created_at` | |
| `imageUrl` | string | `image_url` | |

**Outcome structure:**
```json
{
  "indexSet": 1,
  "name": "Yes",
  "onChainId": "110846...",
  "status": null
}
```
- `indexSet`: 1 = Yes, 2 = No
- `status`: null = active, "WON"/"LOST" = resolved

**Sufficient for `prediction_markets` table?** ✅ YES

### 1.2 List Categories (Events): `GET /v1/categories`

Returns event-level groups with nested markets. Equivalent to Polymarket's `/events` endpoint.

**Category (Event) object — key fields:**

| Field | Type | Maps to our schema | Notes |
|-------|------|-------------------|-------|
| `id` | number | `event_id` | Unique event ID |
| `slug` | string | `event_id` (alternative) | e.g. "2026-nba-champion" |
| `title` | string | `events.title` | e.g. "2026 NBA Champion" |
| `description` | string | `events.subtitle` | |
| `status` | string | `events.status` | OPEN, RESOLVED |
| `startsAt` | ISO date | — | |
| `endsAt` | ISO date | `events.end_date` | |
| `imageUrl` | string | `events.image_url` | |
| `markets[]` | array | Nested market objects | Full market objects as described above |
| `tags[]` | array | `events.category` | `[{id, name, level}]` |
| `resolutionProvider` | string | — | "PREDICT_DOT_FUN" or "THREE_PO" |
| `marketVariant` | string | — | DEFAULT, SPORTS_MATCH, etc. |

**Sufficient for `events` table?** ✅ YES

### 1.3 Tags: `GET /v1/tags`

Returns all 63 category tags with `{id, name, level}`. Hierarchical: level 1 = top-level (Crypto, Sports, Esports, Entertainment & Culture, Finance & Economy, World & Politics), level 2 = subcategory.

**Sufficient for category mapping?** ✅ YES

### 1.4 Market Stats: `GET /v1/markets/{id}/stats`

```json
{
  "data": {
    "totalLiquidityUsd": 2274628.85,
    "volume24hUsd": 1070.14,
    "volumeTotalUsd": 34828453.59
  }
}
```

**Sufficient for volume data?** ✅ YES

### 1.5 Orderbook (REST): `GET /v1/markets/{id}/orderbook`

```json
{
  "data": {
    "marketId": 393,
    "updateTimestampMs": 1774034219132,
    "asks": [[0.83, 569037.49], [0.85, 8.715]],
    "bids": [[0.42, 558733.95], [0.38, 6]],
    "lastOrderSettled": {
      "id": "293563",
      "kind": "LIMIT",
      "marketId": 393,
      "outcome": "Yes",
      "price": "0.71",
      "side": "Bid"
    }
  }
}
```

**Format:** `[price, quantity]` pairs. Prices are decimal 0-1 representing YES outcome. NO prices = `1 - YES price` (using `decimalPrecision` for complement).

**Sufficient for `order_books` table + band metrics?** ✅ YES

### 1.6 Trades / Activity

**⚠️ GAP:** No public `/v1/markets/{id}/trades` or `/v1/markets/{id}/recent-trades` endpoint found on testnet. The `lastOrderSettled` field in the orderbook response provides the most recent trade only. There may be an `/activity` endpoint (referenced in docs) but it returned 404 on testnet.

**Impact:** Acceptable — the arb scanner doesn't use the trades table. Band metrics come from orderbook data. We can still extract the last trade price from each WS push via `lastOrderSettled`.

---

## 2. WebSocket — Real-Time Orderbook Streaming

### 2.1 Connection

| Property | Value |
|----------|-------|
| **URL** | `wss://ws.predict.fun/ws` |
| **Auth** | Optional `x-api-key` header or `apiKey` query param. Not currently required for public data. |
| **Protocol** | JSON over WebSocket |
| **Heartbeat** | Server sends every 15s; client must echo timestamp back |
| **Limits** | No documented per-connection subscription limit |

### 2.2 Subscribe/Unsubscribe

```json
// Subscribe
{"method": "subscribe", "requestId": 1, "params": ["predictOrderbook/393"]}

// Unsubscribe
{"method": "unsubscribe", "requestId": 2, "params": ["predictOrderbook/393"]}

// Heartbeat response (must echo server timestamp)
{"method": "heartbeat", "data": 1736696400000}
```

**Topic format:** `predictOrderbook/{marketId}` where marketId is the numeric market ID.

### 2.3 Server Messages

```json
// Subscription acknowledgment
{"type": "R", "requestId": 1, "success": true, "data": ...}

// Push message (orderbook update)
{"type": "M", "topic": "predictOrderbook/393", "data": {...orderbook...}}

// Heartbeat
{"type": "M", "topic": "heartbeat", "data": 1736696400000}
```

### 2.4 Orderbook Push Data

The WS orderbook push matches the REST orderbook structure:
```json
{
  "marketId": 393,
  "updateTimestampMs": 1774034219132,
  "asks": [[0.83, 569037.49], [0.85, 8.715]],
  "bids": [[0.42, 558733.95], [0.38, 6]],
  "lastOrderSettled": { "id", "kind", "marketId", "outcome", "price", "side" }
}
```

**Key insight: WS sends FULL orderbook snapshots, not deltas.** This is simpler than all other exchanges — the OrderBookManager can just replace state on each push rather than applying incremental changes.

### 2.5 Additional WS Topics

| Topic | Purpose | Auth Required | Useful for us? |
|-------|---------|---------------|----------------|
| `predictOrderbook/{marketId}` | Full orderbook snapshots | No | ✅ Primary data source |
| `assetPriceUpdate/{priceFeedId}` | External price feeds (crypto) | No | ❌ Not needed |
| `predictWalletEvents/{jwt}` | User order/trade events | Yes (JWT) | ❌ Not needed |

**Sufficient for real-time orderbook streaming + band metrics?** ✅ YES

---

## 3. Field-by-Field Mapping to Our Schema

### 3.1 `prediction_markets` table

| Our column | Predict.fun source | Notes |
|-----------|-------------------|-------|
| `source_id` | `"PREDICT_DIRECT"` | Constant |
| `exchange_id` | `"PREDICT"` | Constant |
| `market_id` | `market.id` (string of number) | e.g. "393" |
| `event_id` | `market.categorySlug` or category `id` | Links to event |
| `title` | `market.question` | Full question text |
| `outcome_name` | `market.title` | e.g. "Oklahoma City Thunder" |
| `outcome_side` | `outcome.indexSet === 1 ? 'YES' : 'NO'` | Two records per market |
| `price` | From orderbook best bid/ask | Decimal 0-1 |
| `status` | `tradingStatus === 'OPEN' ? 'Open' : 'Closed'` | |

### 3.2 `events` table

| Our column | Predict.fun source | Notes |
|-----------|-------------------|-------|
| `source_id` | `"PREDICT_DIRECT"` | |
| `exchange_id` | `"PREDICT"` | |
| `event_id` | `category.slug` or `category.id` | |
| `title` | `category.title` | |
| `subtitle` | `category.description` | |
| `category` | `category.tags[0].name` | First tag = primary category |
| `status` | `category.status` | OPEN/RESOLVED |
| `end_date` | `category.endsAt` | |
| `market_count` | `category.markets.length` | |
| `image_url` | `category.imageUrl` | |

### 3.3 `market_latest_data` table

| Our column | Predict.fun source | Notes |
|-----------|-------------------|-------|
| `reference_price` | Midpoint of best bid/ask | Calculated by `bandMetrics.ts` |
| `band_vwap_bid/ask` | From orderbook levels | Calculated by `bandMetrics.ts` |
| `band_liquidity_qty_bid/ask` | From orderbook levels | Calculated by `bandMetrics.ts` |
| `band_delta_used` | Default 1% | Same as other exchanges |

### 3.4 `order_books` table

| Our column | Predict.fun source | Notes |
|-----------|-------------------|-------|
| `bids` | `orderbook.bids` | `[[price, qty], ...]` |
| `asks` | `orderbook.asks` | `[[price, qty], ...]` |
| `time_exchange` | `orderbook.updateTimestampMs` | |

---

## 4. Comparison with Existing Exchanges

| Aspect | Kalshi | Polymarket | Opinion | **Predict.fun** |
|--------|--------|-----------|---------|-----------------|
| **REST markets** | `/markets` + `/events` | `/events?active=true` (Gamma) | `/market?status=activated` | `/v1/markets` + `/v1/categories` |
| **Pagination** | Cursor | Cursor | Offset (page) | Cursor (`cursor` + `first`) |
| **Events/categories** | Nested in `/events` | Nested in `/events` | N/A | Nested in `/v1/categories` |
| **WS URL** | `wss://api.elections.kalshi.com/trade-api/ws/v2` | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | `wss://ws.opinion.trade` | `wss://ws.predict.fun/ws` |
| **WS auth** | RSA-PSS per connection | None | apikey URL param | Optional x-api-key header |
| **WS orderbook topic** | `orderbook_delta` channel | Asset-based subscription | `market.depth.diff` | `predictOrderbook/{marketId}` |
| **Orderbook delivery** | Snapshot + deltas | Snapshot + `price_change` deltas | Snapshot + deltas | **Full snapshot on every update** |
| **Price format** | Cents (0-100) → /100 | Decimal (0-1) | Decimal (0-1) | **Decimal (0-1)** ✅ |
| **YES/NO** | Two records emitted | Separate tokens per side | Separate per side | **Single orderbook for YES; NO = complement** |
| **Heartbeat** | WS ping frames | WS ping frames | Manual heartbeat msg | **Manual heartbeat msg (15s, echo timestamp)** |
| **Per-socket limit** | ~2000 subscriptions | 500 assets | ~200 markets | **No documented limit** |
| **Fee rate** | 7% on profit | 2% taker | Unknown | **2% (200 bps)** — per market `feeRateBps` |
| **Cross-exchange IDs** | ❌ | ❌ | ❌ | ✅ `kalshiMarketTicker`, `polymarketConditionIds` |
| **Trade data** | WS trade messages | WS `last_trade_price` | WS trade messages | **`lastOrderSettled` in orderbook only** ⚠️ |
| **Rate limit** | Auth-based | Auth-based | 15 req/s | **240 req/min** |

---

## 5. Gaps & Risks

### 5.1 No dedicated trade stream or trade history endpoint ⚠️

The only trade data comes from `lastOrderSettled` in the orderbook response (both REST and WS). This gives us the **last trade only** — not a stream of all trades.

**Impact:** We can't populate the `trades` table with full history. However, this is **acceptable** because:
- The arb scanner doesn't use the trades table
- Band metrics come from orderbook data
- We can still extract the last trade price from each WS push
- `volume_24h` and `volume_total` come from the `/stats` endpoint

### 5.2 WS orderbook push payload not fully documented

The docs say the WS orderbook topic pushes "Orderbook data (JSON)" without specifying the exact schema. Based on the Rust SDK and REST orderbook structure, it almost certainly matches the REST format (`{marketId, updateTimestampMs, asks, bids, lastOrderSettled}`). **Needs verification by connecting to testnet WS.**

### 5.3 API key will be required on mainnet "in the near future"

Currently optional for public data on mainnet. Need to secure a key before it becomes mandatory. Testnet works without a key.

### 5.4 No documented per-connection subscription limit

Could mean unlimited, or could mean undocumented limits that cause disconnects. **Start conservative (200-500 per socket) and monitor.**

### 5.5 Market count unknown on mainnet

Testnet has limited markets. Mainnet market count needs investigation — determines pool sizing and whether we need subscription limits.

### 5.6 `isNegRisk` flag affects outcome handling

Markets with `isNegRisk: true` (multi-outcome events like "2026 NBA Champion") use a shared collateral pool. The YES/NO complement calculation is the same, but `isNegRisk` is needed for order building (not for our read-only ingestion). **No impact on our integration.**

---

## 6. Conclusion

### What we CAN do (same as Kalshi/Polymarket):
- ✅ REST market sync with events/categories hierarchy
- ✅ WebSocket real-time orderbook streaming
- ✅ Band metrics calculation (identical price format to Polymarket)
- ✅ `prediction_markets` + `events` + `market_latest_data` + `order_books` population
- ✅ Arb scanner compatibility (orderbook + band metrics)
- ✅ Cross-exchange matching via built-in `kalshiMarketTicker` and `polymarketConditionIds`
- ✅ Fee rate per market (`feeRateBps`)
- ✅ Event-matcher integration

### What's different/simpler:
- WS sends full orderbook snapshots (no delta accumulation needed)
- Prices already decimal 0-1 (no conversion like Kalshi cents)
- Built-in cross-exchange market IDs (free matching, no AI cost)
- Heartbeat is manual echo (like Opinion, not WS ping frames)

### What's missing/limited:
- ⚠️ No trade stream — only `lastOrderSettled` per orderbook push
- ⚠️ WS message format not fully documented (need testnet verification)
- ⚠️ Mainnet API key needed soon
- ⚠️ Per-socket limits undocumented

### Overall assessment

**Full integration is feasible.** The pattern would closely mirror the Opinion listener (our simplest/newest integration) with even less complexity due to full-snapshot orderbooks.
