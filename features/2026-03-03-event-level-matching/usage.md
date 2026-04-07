# Event-Level Matching — Usage & Verification

## Database Migration

Run on the server before deployment:

```bash
ssh root@8.216.43.26

PGPASSWORD='HAH2#mwzay_8a' psql -h pgm-0iwbjigj740ve1e5.pgsql.japan.rds.aliyuncs.com \
  -U direct_exchanges -d direct_exchanges -c "
CREATE TABLE IF NOT EXISTS direct_exchanges_data.events (
    source_id            VARCHAR(50)   NOT NULL,
    exchange_id          VARCHAR(50)   NOT NULL,
    event_id             VARCHAR(255)  NOT NULL,
    title                TEXT,
    subtitle             TEXT,
    category             VARCHAR(255),
    series_id            VARCHAR(255),
    status               VARCHAR(50)   DEFAULT 'Open',
    end_date             TIMESTAMPTZ,
    image_url            TEXT,
    mutually_exclusive   BOOLEAN,
    market_count         INTEGER,
    source_specific_data JSONB,
    created_at           TIMESTAMPTZ   DEFAULT NOW(),
    updated_at           TIMESTAMPTZ   DEFAULT NOW(),
    PRIMARY KEY (source_id, exchange_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_events_exchange_status ON direct_exchanges_data.events (exchange_id, status);
"
```

## Verification Queries

### Check events table exists

```sql
SELECT COUNT(*) FROM direct_exchanges_data.events;
```

### Event counts by exchange and status

```sql
SELECT exchange_id, status, COUNT(*), AVG(market_count)::int as avg_markets_per_event
FROM direct_exchanges_data.events
GROUP BY exchange_id, status
ORDER BY exchange_id, status;
```

### Recent events

```sql
SELECT exchange_id, event_id, title, category, market_count, status, updated_at
FROM direct_exchanges_data.events
WHERE status = 'Open'
ORDER BY updated_at DESC
LIMIT 20;
```

### Events with most markets

```sql
SELECT exchange_id, event_id, title, market_count
FROM direct_exchanges_data.events
WHERE status = 'Open'
ORDER BY market_count DESC
LIMIT 20;
```

## Post-Deployment Verification

### Check logs

```bash
# Event sync logs
docker compose logs --tail 30 kalshi-listener | grep -i event
docker compose logs --tail 30 polymarket-listener | grep -i event

# Market-matcher should not exist
docker compose ps  # should NOT show market-matcher

# Verify markets still flowing
docker compose logs --tail 10 kalshi-listener | grep -i "synced all markets"
docker compose logs --tail 10 polymarket-listener | grep -i "synced all markets"
```

### Build verification

```bash
pnpm build   # All packages compile
pnpm test    # Existing tests pass
```

## Troubleshooting

### Events not appearing in DB

1. Check listener logs for errors during event upsert
2. Verify the events table was created with the migration
3. Check that the API responses include event data

### Market ingestion broken after changes

1. Check that `fetchActiveMarkets` (Kalshi) still returns markets correctly
2. Check that `fetchEventsWithMarkets` (Polymarket) returns markets correctly
3. Compare market counts before/after deployment

### market-matcher still running

```bash
docker compose stop market-matcher && docker compose rm -f market-matcher
```
