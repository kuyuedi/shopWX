# Market Hierarchy: series_id + Fix event_id + sub_title + Fix category

**Status**: COMPLETED

## Problem Statement

The prediction market ingestion system needs a 4-level market hierarchy: **category → series → event → market**. Four problems exist today:

1. **Polymarket `event_id` is wrong**: Currently `event_id = Gamma market.id`, but that's the Polymarket *market/condition* level, NOT the event level. The real event groups multiple markets.
2. **`category` write bug**: Field exists in types and normalizers but is silently dropped from `queries.ts` INSERT statements.
3. **`series_id` missing**: Level 2 of the hierarchy doesn't exist yet.
4. **`sub_title` missing**: Kalshi has `yes_sub_title`/`no_sub_title` (e.g., "Above 300,000") and Polymarket has `groupItemTitle` (e.g., "800-900k") — both describe the specific outcome bracket within an event.

## Hierarchy Mapping

| Level | Column | Kalshi Source | Polymarket Source |
|-------|--------|--------------|-------------------|
| 1. Category | `category` | `event.category` (threaded to market) | `market.category` from Gamma `/markets` |
| 2. Series | `series_id` (NEW) | `event.series_ticker` (threaded) | `event.series[0].ticker` from Gamma `/events` |
| 3. Event | `event_id` | `event.event_ticker` (works) | `event.id` from Gamma `/events` (**FIX**: currently wrong) |
| 4. Market | `market_id` | `market.ticker` (works) | `clobTokenId` (works) |
| — | `sub_title` (NEW) | `yes_sub_title` / `no_sub_title` | `groupItemTitle` from Gamma `/markets` |

## Acceptance Criteria

1. [x] `series_id` column populated for both exchanges
2. [x] Polymarket `event_id` correctly groups multiple markets under one event
3. [x] `sub_title` column populated with outcome-specific bracket descriptions
4. [x] `category` column actually written to the database (bug fix)
