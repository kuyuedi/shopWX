# Event-Level Matching — Technical Design

## Database Schema

### Migration SQL

```sql
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

CREATE INDEX idx_events_exchange_status ON direct_exchanges_data.events (exchange_id, status);
```

## Field Mappings

| DB Column | Kalshi Source | Polymarket Source |
|-----------|-------------|-------------------|
| `event_id` | `event_ticker` | `id` |
| `title` | `title` | `title` |
| `subtitle` | `sub_title` | `subtitle` |
| `category` | `category` | `tags[0].label` or `categories[0].label` |
| `series_id` | `series_ticker` | `series[0].ticker` |
| `end_date` | `strike_date` | `endDate` |
| `image_url` | — | `image` |
| `mutually_exclusive` | `mutually_exclusive` | `enableNegRisk` |
| `market_count` | `markets.length` | `markets.length` |
| `source_specific_data` | `strike_period`, `collateral_return_type` | `slug`, `negRisk`, `volume`, `liquidity`, `volume24hr` |

## Data Flow

### Kalshi

```
fetchActiveMarkets()
  └─ GET /events?with_nested_markets=true&status=open (paginated)
     └─ For each event:
        ├─ Extract event → ExchangeEvent (new)
        └─ Extract nested markets → KalshiMarket[] (existing)
  └─ Returns { markets: KalshiMarket[], events: ExchangeEvent[] }

refreshMarkets()
  ├─ const { markets, events } = await fetchActiveMarkets()
  ├─ await syncMarkets(markets)           // existing
  ├─ await upsertEventsBatch(events)      // new
  ├─ await markStaleEventsAsClosed()      // new
  └─ await syncMarketOHLC()               // existing
```

### Polymarket

```
fetchEventsWithMarkets()
  └─ GET /events?active=true&closed=false&limit=100 (paginated)
     └─ For each event:
        ├─ Extract event → ExchangeEvent (new)
        ├─ Extract nested markets → PolymarketMarket[] (replaces fetchActiveMarkets)
        └─ Build event-to-token mappings (replaces fetchEventMapping)
  └─ Returns { events: ExchangeEvent[], markets: PolymarketMarket[], eventMapping: EventMappingResult }

refreshMarkets()
  ├─ const { events, markets, eventMapping } = await fetchEventsWithMarkets()
  ├─ await syncMarkets(markets, eventMapping)   // existing
  ├─ await upsertEventsBatch(events)            // new
  └─ await markStaleEventsAsClosed()            // new
```

## Files Modified

| File | Change |
|------|--------|
| `packages/shared/src/db/types.ts` | Add `ExchangeEvent` interface |
| `packages/shared/src/db/queries.ts` | Add `upsertEventsBatch()`, `markStaleEventsAsClosed()` |
| `packages/shared/src/index.ts` | Exports already covered by `export *` |
| `packages/kalshi-listener/src/services/marketSync.ts` | Extend `KalshiEvent`, return events alongside markets |
| `packages/kalshi-listener/src/index.ts` | Call `upsertEventsBatch()` during refresh |
| `packages/polymarket-listener/src/services/gammaApi.ts` | Add `fetchEventsWithMarkets()` |
| `packages/polymarket-listener/src/index.ts` | Use unified fetch, call `upsertEventsBatch()` |
| `docker-compose.yml` | Remove market-matcher service |
| `package.json` (root) | Remove market-matcher scripts |
| `CLAUDE.md` | Remove market-matcher docs, add event ingestion docs |

## Files Deleted

| File/Dir | Reason |
|----------|--------|
| `packages/market-matcher/` | Replaced by event-level matching (Phase 2) |
| `deploy-matcher.sh` | No longer needed |
