# N-Exchange Support — Arb Scanner, Events API, and Query Layer Generalization

## Overview

The prediction market ingestion system previously hardcoded two exchanges (Kalshi and Polymarket) throughout the query layer and API routes. This generalization removes all hardcoded exchange references so the system supports **N exchanges** automatically — any new exchange added via a listener package is immediately visible in arb scanning, the events API, and the frontend display layer.

The immediate driver is **Predict.fun**, the third exchange integrated into the system. Future exchanges (4th, 5th, etc.) will require only a new listener package — no changes to the arb scanner, events API, or display layer.

## Predict.fun Integration

Predict.fun is a prediction market that mirrors markets from both Kalshi and Polymarket. Its API provides direct cross-exchange links:
- `kalshiMarketTicker` — the corresponding Kalshi market ticker
- `polymarketConditionIds` — the corresponding Polymarket condition IDs

This means **no AI matching is needed** for Predict.fun. The `predict-listener` package uses these API-provided links to create `market_mappings` entries automatically, at zero AI cost.

### Data Ingested
- Markets and events (from `GET /v1/categories?status=OPEN` — single paginated endpoint, markets nested inside categories)
- Orderbooks (via WebSocket delta accumulation)
- Trades (via WebSocket)

### What This Enables
- Arbitrage detection between Predict↔Kalshi
- Arbitrage detection between Predict↔Polymarket
- Side-by-side price display on the events page

## N-Exchange Arb Scanner

The arb scanner core (`arbScanner.ts`) was already exchange-agnostic — it uses generic `leg1_*`/`leg2_*` fields and iterates all exchange pairs naturally. The generalization was in the **query layer** and **API routes**:

### Changes Made
1. **`fetchArbsV7()` query** — Previously joined only to Polymarket for event IDs (needed for trade URLs). Now joins `prediction_markets` + `events` for BOTH legs generically, returning `leg1_event_id` and `leg2_event_id`.

2. **Trade URL construction** — Each exchange has its own URL pattern:
   - Kalshi: `https://kalshi.com/markets/{marketId}`
   - Polymarket: `https://polymarket.com/event/{eventId}`
   - Predict.fun: `https://predict.fun/market/{marketId}`
   - Unknown exchanges: gracefully return `null`

3. **Exchange abbreviations** — Dynamic with known map + fallback:
   - K = Kalshi, P = Polymarket, PR = Predict, O = Opinion.trade
   - Unknown exchanges: first 2 characters of exchange ID

### Fee Rates Per Exchange
| Exchange | Fee Rate | Type |
|----------|----------|------|
| Kalshi | 7% | On profit |
| Polymarket | 2% | Taker fee |
| Predict.fun | 2% | Taker fee |
| Default | 1% | Fallback |

### New Arb Types
With 3 exchanges, the scanner now finds arbs across all pairs:
- Kalshi ↔ Polymarket (existing)
- Predict ↔ Kalshi (new)
- Predict ↔ Polymarket (new)

## Events & Markets Display

The events API now shows markets from all exchanges with prices side-by-side.

### Changes Made
1. **`EventRow` type** — Replaced `kalshi_event_id` / `poly_event_id` with a single `exchange_event_ids: Record<string, string>` (e.g., `{"KALSHI":"evt123","POLYMARKET":"slug-abc","PREDICT":"cat-456"}`)

2. **SQL CTEs** — Replaced hardcoded `CASE WHEN exchange_id = 'KALSHI'` with `jsonb_object_agg()` / `jsonb_build_object()`

3. **Market batch fetch** — Dynamically builds WHERE clause for all exchanges present in the page, instead of hardcoding Kalshi + Polymarket conditions

4. **Exchange keys** — `kal`, `poly`, `pred`, `opinion` with fallback for unknown exchanges

## Scalability

Adding a 4th or 5th exchange requires:
1. A new listener package (e.g., `packages/newexchange-listener/`)
2. Market mappings populated (either via AI matching or API-provided links)
3. Optionally add a trade URL pattern in `buildTradeUrl()` and an abbreviation in `EXCHANGE_SHORT`

The arb scanner, events API, query layer, and display layer handle new exchanges automatically with no code changes needed.

## What's NOT Changing

- **Event matcher** was generalized on 2026-03-26 to support N exchange pairs with configurable AI vs derived strategies. See `features/2026-03-26-n-exchange-matching/` for details.
- **Score computation queries** — Minor fix to use `COALESCE` for title selection instead of hardcoded Kalshi, and generic exchange prefix for unmatched market IDs.

## Files Modified

| File | What Changed |
|------|-------------|
| `packages/shared/src/db/queries.ts` | `fetchArbsV7()` JOINs generalized, `ArbV7Row` type updated, `fetchMatchedMarketsRawData()` title COALESCE, `fetchUnmatchedMarketsRawData()` generic ID prefix |
| `packages/homepage-api/src/routes/arb.ts` | `EXCHANGE_SHORT` + `exchangeShort()` fallback, `buildTradeUrl()` with Predict support, `buildLeg()` uses per-leg event IDs |
| `packages/homepage-api/src/routes/events.ts` | `EventRow` uses `exchange_event_ids`, CTEs use `jsonb_object_agg`/`jsonb_build_object`, market fetch is data-driven, exchanges list is dynamic |

## Verification

```sql
-- Arbs with PREDICT legs
SELECT leg1_exchange_id, leg2_exchange_id, COUNT(*)
FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE'
GROUP BY leg1_exchange_id, leg2_exchange_id;

-- Cross-exchange mappings
SELECT exchange_id, model_id, COUNT(*)
FROM direct_exchanges_data.market_mappings
GROUP BY exchange_id, model_id
ORDER BY exchange_id;
```
