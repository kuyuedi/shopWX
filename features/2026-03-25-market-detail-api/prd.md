# Market Detail Page — Backend API PRD

**Status**: In Progress
**Priority**: P0
**Date**: 2026-03-25

---

## Summary

Three new API endpoints to power the market detail page. All endpoints are in a single new route file (`marketDetail.ts`) — no existing code is modified except one line in `server.ts` to register the route.

---

## Endpoints

### 1. `GET /api/v1/markets/:id` — Market Detail

Returns full detail for a single canonical market.

**Path param**: `id` = canonical_market_id (e.g., `CM-8bb8429978bb669a`)

**Response**:
```json
{
  "id": "CM-8bb8429978bb669a",
  "title": "2028 Democratic nominee for President?",
  "category": "politics",
  "end_date": "Nov 7, 2028",
  "image_url": "...",
  "volume": "$899.9M",
  "status": "Open",
  "exchanges": ["kal", "poly"],
  "exchange_links": [
    { "exchange": "kal", "market_id": "KXPRESNOMD-28-GN", "event_id": "KXPRESNOMD-28", "series_id": "KXPRESNOMD", "trade_url": "https://kalshi.com/markets/..." },
    { "exchange": "poly", "market_id": "559652", "trade_url": "https://polymarket.com/event/..." }
  ],
  "outcomes": [
    {
      "label": "Gavin Newsom",
      "prices": {
        "kal": { "price": 28, "bid": 20, "ask": 28, "depth_bid": 35, "depth_ask": 30 },
        "poly": { "price": 24, "bid": 24.1, "ask": 24.3, "depth_bid": 500, "depth_ask": 500 }
      }
    }
  ],
  "resolution": [
    { "exchange": "kal", "rules": "If [candidate] wins and accepts the nomination..." },
    { "exchange": "poly", "rules": "This market will resolve to Yes if..." }
  ],
  "related": [
    { "id": "CM-xxx", "title": "2028 Presidential Election Winner", "best_price": 18 },
    { "id": "CM-yyy", "title": "Who will run for Dem nomination 2028?", "best_price": 87 }
  ]
}
```

**Data sources**:
- `market_mappings` — canonical_market_id lookup, exchange mapping
- `prediction_markets` — titles, rules_primary, event_id, series_id, price
- `market_latest_data` — reference_price, band_vwap_ask/bid, band_liquidity_qty_ask/bid
- `market_titles` — display title
- `events` — category, image, end_date, source_specific_data (Poly slug for trade URL)

**Query strategy**: Single query with JOINs across market_mappings → prediction_markets → market_latest_data, grouped by outcome.

---

### 2. `GET /api/v1/markets/:id/orderbook` — Orderbook

Returns orderbook depth for a specific outcome within the market.

**Path param**: `id` = canonical_market_id
**Query params**:
- `outcome` (optional, default 0) — index of outcome
- `exchange` (optional, default "combined") — `combined`, `kalshi`, `polymarket`

**Response**:
```json
{
  "spread": 3.7,
  "bids": [
    { "price": 24.1, "qty": 500, "exchange": "poly" },
    { "price": 20.0, "qty": 35, "exchange": "kal" }
  ],
  "asks": [
    { "price": 24.3, "qty": 500, "exchange": "poly" },
    { "price": 28.0, "qty": 30, "exchange": "kal" }
  ],
  "updated_at": "2026-03-25T12:00:00Z"
}
```

**MVP**: Uses band metrics from `market_latest_data` (single bid/ask level per exchange). Full multi-level orderbook from `order_books` table can be added later.

---

### 3. `GET /api/v1/markets/:id/history` — Price History

Returns price history for chart display.

**Path param**: `id` = canonical_market_id
**Query params**:
- `tf` (optional, default "today") — `today` or `7d`
- `top` (optional, default 5) — number of top outcomes to include

**Response**:
```json
{
  "timeframe": "today",
  "labels": ["00:00", "02:00", "04:00", ...],
  "series": [
    {
      "name": "Gavin Newsom",
      "color": "#3b82f6",
      "data": [26.1, 26.5, 27.0, ...],
      "kalshi_data": [27.0, 27.5, 28.0, ...],
      "poly_data": [25.2, 25.5, 24.3, ...]
    }
  ]
}
```

**Data source**: `trades` table aggregated into intervals:
- Today: 2-hour intervals (12 points)
- 7D: 6-hour intervals (28 points)

Last trade price per interval = closing price for that interval.

**Prerequisite**: Extend trades table retention from 2 days to 7 days (DB partition config change).

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/homepage-api/src/routes/marketDetail.ts` | **NEW** | All 3 endpoints |
| `packages/homepage-api/src/server.ts` | **MODIFY** | Add 1 line: register marketDetailRoute |
| `features/2026-03-25-market-detail-api/prd.md` | **NEW** | This document |

**No other existing files are modified.**

---

## DB Changes

### Extend trades retention to 7 days

Current: 2-day retention (partitions cleaned daily)
New: 7-day retention

Change the partition cleanup cron on the server to keep 7 days instead of 2.

---

## Deployment

1. Push code to GitHub
2. SSH to server: `cd /opt/prediction-market-ingestion && git pull`
3. Rebuild: `docker compose build homepage-api`
4. Deploy: `docker compose up -d homepage-api`
5. Verify: `curl https://marketsapi.17b.com/api/v1/markets/CM-8bb8429978bb669a`

---

## Verification

1. `GET /api/v1/markets/CM-8bb8429978bb669a` returns full detail with outcomes + prices
2. `GET /api/v1/markets/CM-8bb8429978bb669a/orderbook` returns bid/ask with depth
3. `GET /api/v1/markets/CM-8bb8429978bb669a/history?tf=today` returns price series
4. All existing endpoints continue working (no regression)
5. Response times < 500ms for detail, < 200ms for orderbook
