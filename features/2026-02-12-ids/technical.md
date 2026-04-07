# Technical Changes: Market IDs & Resolution Info

Technical implementation details for the Market IDs & Resolution Info feature.

---

## Database Schema Changes

### Column Changes on `prediction_markets`

```sql
-- 1. Add event_id column
ALTER TABLE direct_exchanges_data.prediction_markets
ADD COLUMN IF NOT EXISTS event_id VARCHAR(255);

-- 2. Rename description → rules_primary
ALTER TABLE direct_exchanges_data.prediction_markets
RENAME COLUMN description TO rules_primary;

-- 3. Add rules_secondary column
ALTER TABLE direct_exchanges_data.prediction_markets
ADD COLUMN IF NOT EXISTS rules_secondary TEXT;
```

| Column | Type | Description |
|--------|------|-------------|
| `event_id` | VARCHAR(255) | Parent event identifier grouping related outcomes/markets |
| `rules_primary` | TEXT | Primary resolution rules (renamed from `description`) |
| `rules_secondary` | TEXT | Secondary resolution rules (Kalshi only, NULL for Polymarket) |

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     EVENT ID & RULES DATA FLOW                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  POLYMARKET                           KALSHI                            │
│  ┌──────────────┐                     ┌──────────────┐                 │
│  │ Gamma API    │                     │ Events API   │                 │
│  │ GET /markets │                     │ GET /events  │                 │
│  └──────┬───────┘                     │ ?with_nested │                 │
│         │                             │  _markets    │                 │
│         │ id → event_id               └──────┬───────┘                 │
│         │ description → rules_primary         │ event_ticker → event_id│
│         │                                     │ rules_primary          │
│         │                                     │ rules_secondary        │
│         ▼                                     ▼                        │
│  ┌──────────────┐                     ┌──────────────┐                 │
│  │ normalize.ts │                     │ normalize.ts │                 │
│  │ (polymarket) │                     │  (kalshi)    │                 │
│  └──────┬───────┘                     └──────┬───────┘                 │
│         │                                     │                        │
│         └──────────────┬──────────────────────┘                        │
│                        ▼                                               │
│                 ┌──────────────┐                                       │
│                 │ queries.ts   │                                       │
│                 │ (shared)     │                                       │
│                 └──────┬───────┘                                       │
│                        │                                               │
│                        ▼                                               │
│                 ┌──────────────┐                                       │
│                 │ prediction_  │                                       │
│                 │ markets      │                                       │
│                 └──────────────┘                                       │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Code Changes

| File | Change |
|------|--------|
| `packages/shared/src/db/types.ts` | Add `event_id`, rename `market_description` → `rules_primary`, add `rules_secondary` |
| `packages/shared/src/db/queries.ts` | Update INSERT/ON CONFLICT for `event_id`, `rules_primary`, `rules_secondary` |
| `packages/shared/src/types/market.ts` | Add `eventId`, rename `marketDescription` → `rulesPrimary`, add `rulesSecondary` |
| `packages/kalshi-listener/src/transformers/normalize.ts` | Add `event_ticker`, `rules_primary`, `rules_secondary` to `KalshiMarket`; map in `normalizeMarket()` |
| `packages/kalshi-listener/src/services/marketSync.ts` | Thread `event_ticker` from `KalshiEvent` into each `KalshiMarket`; pass new fields in `syncMarkets()` |
| `packages/polymarket-listener/src/transformers/normalize.ts` | Populate `eventId` from `market.id`; rename `marketDescription` → `rulesPrimary` |
| `packages/polymarket-listener/src/services/gammaApi.ts` | Pass `eventId`, `rulesPrimary` in `syncMarkets()` |

### Kalshi: Threading event_ticker

Current code in `fetchActiveMarkets()` drops event-level fields:
```typescript
// BEFORE
allMarkets.push(market);  // event_ticker is lost

// AFTER
allMarkets.push({ ...market, event_ticker: event.event_ticker });
```

---

## Dependencies

### Prerequisites

1. Database migration must be run (RENAME + ADD COLUMN)
2. Deploy updated application code

### Runtime Dependencies

| Component | Required For |
|-----------|-------------|
| Polymarket Gamma API | `id` field for event_id, `description` for rules_primary |
| Kalshi Events API | `event_ticker` for event_id, `rules_primary`/`rules_secondary` for resolution rules |

---

## Migration Checklist

- [x] Run database migration (add event_id, rename description → rules_primary, add rules_secondary)
- [x] Verify schema changes
- [x] Deploy application code (both listeners)
- [x] Verify event_id is populated for both exchanges
- [x] Verify rules_primary is populated
- [x] Verify rules_secondary is populated for Kalshi

---

## Rollback Plan

If issues arise:

```sql
-- Rollback: rename rules_primary back to description
ALTER TABLE direct_exchanges_data.prediction_markets
RENAME COLUMN rules_primary TO description;

-- Rollback: drop new columns
ALTER TABLE direct_exchanges_data.prediction_markets
DROP COLUMN IF EXISTS event_id,
DROP COLUMN IF EXISTS rules_secondary;
```

Code rollback: Revert to previous Git commit.

---

## Performance Considerations

- `event_id` is a new nullable column — no index required initially
- Consider adding an index on `event_id` if grouping queries become frequent:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_prediction_markets_event_id
  ON direct_exchanges_data.prediction_markets (event_id)
  WHERE event_id IS NOT NULL;
  ```
- `rules_primary` and `rules_secondary` are TEXT columns — no performance impact on existing queries
- No change to batch insert chunk sizes or deduplication logic
