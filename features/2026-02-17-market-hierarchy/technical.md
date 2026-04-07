# Technical Implementation

## Database Migration

```sql
ALTER TABLE direct_exchanges_data.prediction_markets
ADD COLUMN IF NOT EXISTS series_id VARCHAR(255);

ALTER TABLE direct_exchanges_data.prediction_markets
ADD COLUMN IF NOT EXISTS sub_title TEXT;

ALTER TABLE direct_exchanges_data.prediction_markets
ADD COLUMN IF NOT EXISTS category VARCHAR(255);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prediction_markets_series_id
ON direct_exchanges_data.prediction_markets (series_id)
WHERE series_id IS NOT NULL;
```

## Code Changes

### Shared Types
- `PredictionMarket`: Add `series_id`, `sub_title`
- `NormalizedMarket`: Add `seriesId`, `subTitle`

### queries.ts (Bug Fix + New Columns)
- Add `category`, `series_id`, `sub_title` to INSERT/UPDATE in both `upsertPredictionMarket()` and `upsertPredictionMarketsBatch()`
- Param count: 14 → 18 per row

### Kalshi
- Thread `series_ticker` and `category` from events to markets in `fetchActiveMarkets()`
- Map `seriesId` and `subTitle` in normalizer

### Polymarket
- New `fetchEventMapping()` function: fetches Gamma `/events` to get real event IDs and series tickers
- Fix `event_id`: Override with real event.id from event mapping
- Add `series_id` from event mapping
- Add `subTitle` from `groupItemTitle` in normalizer

## Verification SQL

```sql
SELECT exchange_id,
       COUNT(*) as total,
       COUNT(series_id) as with_series,
       COUNT(category) as with_category,
       COUNT(sub_title) as with_sub_title
FROM direct_exchanges_data.prediction_markets
WHERE updated_at > NOW() - INTERVAL '10 minutes'
GROUP BY exchange_id;
```
