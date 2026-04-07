# Feature: Opinion.trade Exchange Integration

**Status**: NEW
**Priority**: High
**Created**: 2026-03-11

---

## Summary

Integrate Opinion.trade as the third prediction market exchange alongside Kalshi and Polymarket, enabling cross-exchange arbitrage detection across all three platforms.

---

## Problem

The system currently ingests data from only Kalshi and Polymarket. Adding a third exchange (Opinion.trade) increases the number of arb combinations from 1 pair (K-P) to 3 pairs (K-P, K-O, P-O), significantly expanding opportunity discovery.

---

## Solution

Create an `opinion-listener` package that follows the same architecture as `kalshi-listener` and `polymarket-listener`:
1. REST market sync every 5 minutes
2. WebSocket listener for real-time orderbooks, trades, and prices
3. OrderBook delta accumulation (Opinion sends deltas like Kalshi)
4. Populate the same DB tables (`prediction_markets`, `events`, `order_books`, `market_latest_data`, `trades`)
5. Event matcher and arb scanner automatically discover Opinion markets with zero changes

---

## Sub-Features

This feature is broken into 4 implementation phases:

| # | Sub-Feature | Description | Depends On |
|---|-------------|-------------|------------|
| 1 | [Package Scaffold + Market Sync](./sub1-market-sync.md) | REST API integration, market/event sync to DB | None |
| 2 | [WebSocket Listener](./sub2-websocket.md) | Real-time orderbook, trade, price ingestion | Sub 1 |
| 3 | [OrderBook Delta Manager](./sub3-orderbook-manager.md) | In-memory delta accumulation for orderbooks | Sub 2 |
| 4 | [Docker + Deploy + Healthcheck](./sub4-deploy.md) | Containerization, deployment, monitoring | Sub 1-3 |

---

## Opinion.trade API Summary

| Aspect | Detail |
|--------|--------|
| REST base URL | `https://openapi.opinion.trade/openapi` |
| WS URL | `wss://ws.opinion.trade?apikey={API_KEY}` |
| Auth | API key in `apikey` header (REST) or query param (WS) |
| Rate limit | 15 req/s |
| Pagination | `page` + `limit` (max 20 per page) |
| Price format | Decimal strings (`"0.55"`) — already 0-1 range |
| Market types | Binary (`marketType=0`) + Categorical (`marketType=1`) |
| Outcome sides | `outcomeSide`: 1=YES, 2=NO |
| WS channels | `market.depth.diff`, `market.last.price`, `market.last.trade` |
| WS heartbeat | `{"action":"HEARTBEAT"}` every 30s |
| Orderbook delivery | Deltas (like Kalshi), not full snapshots |

---

## Mapping to Our System

| Our field | Opinion source | Notes |
|-----------|---------------|-------|
| `source_id` | `'OPINION_DIRECT'` | Constant |
| `exchange_id` | `'OPINIONTRADE'` | Constant |
| `market_id` | `marketId` (int64 → string) | Per-market unique ID |
| `event_id` | `rootMarketId` (categorical) or `marketId` (binary) | Groups child markets |
| `outcome_side` | `outcomeSide`: 1→`'YES'`, 2→`'NO'` | In both REST and WS |
| `price` | `parseFloat(price)` | Already decimal (0-1) |
| `market_name` | `marketTitle` | Direct mapping |
| `status` | `statusEnum`: `"Activated"`→`"Open"`, `"Resolved"`→`"Closed"` | |
| `expires_at` | `cutoffAt` (ms timestamp → Date) | |
| `event_id` (events table) | `rootMarketId` or `marketId` | |
| `title` (events table) | `rootMarketTitle` or `marketTitle` | |
| `category` | From market list (not in API — use `collection.title` or null) | |

---

## What Needs NO Changes

These components are exchange-agnostic and work automatically once Opinion data is in the DB:

- **Event matcher** — queries `events` table for any exchange, auto-matches Opinion↔Kalshi and Opinion↔Polymarket
- **Market-within-event matcher** — runs inline after event match, works with any exchange pair
- **Arb scanner** — queries `market_mappings` + `market_latest_data`, auto-discovers 3-way arbs
- **Homepage API** — serves whatever is in the DB, no exchange-specific logic
- **Band metrics** — `calculateBandMetrics()` is pure math on bids/asks arrays
- **Batch writer** — generic buffered write utility

---

## Blockers

1. **API key required** — must apply at Google Form: https://docs.google.com/forms/d/1h7gp8UffZeXzYQ-lv4jcou9PoRNOqMAQhyW4IwZDnII
2. **Unknown WS subscription limit** — need to test how many markets one connection supports
3. **Unknown market count** — need to verify Opinion has enough active markets for meaningful arbs

---

## Acceptance Criteria

- [ ] `prediction_markets` table contains Opinion markets with correct YES/NO records
- [ ] `events` table contains Opinion events (binary as single events, categorical grouped)
- [ ] `order_books` table receives real-time orderbook snapshots from WS deltas
- [ ] `market_latest_data` table has band metrics for Opinion markets
- [ ] `trades` table receives Opinion trade events
- [ ] Event matcher finds Opinion↔Kalshi and Opinion↔Polymarket matches
- [ ] Arb scanner detects cross-exchange opportunities involving Opinion
- [ ] Docker container runs stably in production
- [ ] Healthcheck monitors Opinion listener
