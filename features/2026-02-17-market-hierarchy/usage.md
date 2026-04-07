# Market Hierarchy — Business Guide

## What Changed

We now capture a **4-level market hierarchy** for both Kalshi and Polymarket:

```
Category → Series → Event → Market
```

Plus a new **sub_title** field that describes the specific outcome bracket (e.g., "Above 300,000", "800-900k").

### New Columns in `prediction_markets`

| Column | Type | Description | Example |
|--------|------|-------------|---------|
| `category` | VARCHAR(255) | Top-level topic | "Sports", "Crypto", "Politics" |
| `series_id` | VARCHAR(255) | Recurring series grouping events | "KXNFP" (Nonfarm Payrolls), "microstrategy-sell-any-bitcoin-in-2025" |
| `event_id` | VARCHAR(255) | Single event grouping multiple markets | "KXNFP-26FEB", "16282" |
| `sub_title` | TEXT | Outcome bracket within an event | "Above 300,000", "<250k" |

### Bug Fixes

- **Polymarket `event_id` fixed**: Previously stored the market/condition ID (unique per market). Now stores the real event ID that groups multiple related markets together.
- **`category` write bug fixed**: Category was being read from APIs but silently dropped before writing to the database.

## Coverage

| Exchange | Total Markets | With Category | With Series | With Sub-Title |
|----------|--------------|---------------|-------------|----------------|
| Kalshi | 64,144 | 100% | 100% | 100% |
| Polymarket | 57,562 | 99.6% | 58.9% | 89.5% |

*Series coverage on Polymarket is lower because not all events belong to a series. Sub-title coverage is lower because single-market events don't have bracket labels.*

## Hierarchy Examples

### Kalshi — Nonfarm Payrolls

| Level | Value |
|-------|-------|
| Category | Economics |
| Series | KXNFP |
| Event | KXNFP-26FEB |
| Market | KXNFP-26FEB-T300 |
| Sub-Title | Above 300,000 |

Multiple markets under the same event represent different outcome brackets (Above 200k, Above 250k, Above 300k, etc.) for the same February 2026 jobs report.

### Kalshi — Arctic Ice

| Level | Value |
|-------|-------|
| Category | Climate and Weather |
| Series | KXARCTICICEMAX |
| Event | KXARCTICICEMAX-26APR01 |
| Market | KXARCTICICEMAX-26APR01-T15.0 |
| Sub-Title | Above 15.0 million sq km |

### Polymarket — Trump Deportations

| Level | Value |
|-------|-------|
| Category | Politics |
| Series | *(none — not all Polymarket events have series)* |
| Event | 16282 |
| Market | 101676997363... (clobTokenId) |
| Sub-Title | <250k |

Multiple markets under event 16282 represent different deportation count brackets (<250k, 250-500k, 500-750k, 750k+).

## Live Sample Data

### Kalshi — 5 Markets Across Different Series (YES side)

| Category | Series | Event | Sub-Title | Market ID | Price |
|----------|--------|-------|-----------|-----------|-------|
| Climate and Weather | KXARCTICICEMAX | KXARCTICICEMAX-26APR01 | Above 14.0 million sq km | KXARCTICICEMAX-26APR01-T14.0 | 1.00 |
| Climate and Weather | KXAUSSNOWM | KXAUSSNOWM-26FEB | Above 0.1 inches | KXAUSSNOWM-26FEB-0.1 | 1.00 |
| Climate and Weather | KXBOSSNOWM | KXBOSSNOWM-26FEB | Above 0.1 inches | KXBOSSNOWM-26FEB-0.1 | 1.00 |
| Climate and Weather | KXCHISNOWM | KXCHISNOWM-26FEB | Above 0.1 inches | KXCHISNOWM-26FEB-0.1 | 1.00 |
| Climate and Weather | KXDALSNOWM | KXDALSNOWM-26FEB | Above 0.1 inches | KXDALSNOWM-26FEB-0.1 | 1.00 |

### Polymarket — 5 Markets Across Different Series (YES side)

| Category | Series | Event | Sub-Title | Price |
|----------|--------|-------|-----------|-------|
| AAPL | aapl-multi-strikes-weekly | 212792 | $260 | 0.88 |
| AAPL | aapl-neg-risk-weekly | 208281 | >$285 | 0.017 |
| AAPL | apple-multi-strikes-monthly | 193924 | $220 | 0.969 |
| AAPL | apple-multi-strikes-weekly | 208279 | $235 | 0.969 |
| AI | anthropic-ipo | 48300 | 300-400B | 0.0075 |

*Snapshot taken 2026-02-17. Prices reflect the probability at time of capture.*

## Useful Queries

### Markets per hierarchy level
```sql
SELECT exchange_id,
       COUNT(DISTINCT market_id) as markets,
       COUNT(DISTINCT event_id) as events,
       COUNT(DISTINCT series_id) as series,
       COUNT(DISTINCT category) as categories
FROM direct_exchanges_data.prediction_markets
WHERE status = 'Open'
GROUP BY exchange_id;
```

### Browse hierarchy for a category
```sql
SELECT category, series_id, event_id, sub_title, market_id, outcome_side, price
FROM direct_exchanges_data.prediction_markets
WHERE category = 'Crypto'
  AND status = 'Open'
ORDER BY series_id, event_id, sub_title, outcome_side;
```

### Find all markets in a series
```sql
SELECT event_id, sub_title, market_id, outcome_side, price, status
FROM direct_exchanges_data.prediction_markets
WHERE series_id = 'KXNFP'
ORDER BY event_id, sub_title, outcome_side;
```

### Count markets per event (to find multi-market events)
```sql
SELECT event_id, category, COUNT(DISTINCT market_id) as market_count
FROM direct_exchanges_data.prediction_markets
WHERE status = 'Open'
GROUP BY event_id, category
HAVING COUNT(DISTINCT market_id) > 2
ORDER BY market_count DESC
LIMIT 20;
```

### Category distribution
```sql
SELECT exchange_id, category, COUNT(*) as market_count
FROM direct_exchanges_data.prediction_markets
WHERE status = 'Open' AND category IS NOT NULL
GROUP BY exchange_id, category
ORDER BY exchange_id, market_count DESC;
```
