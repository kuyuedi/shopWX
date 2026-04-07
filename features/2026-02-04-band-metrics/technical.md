# Technical Changes: Best Price, Band Liquidity & VWAP

This document details the database and architecture changes required for the Best Price, Band Liquidity & VWAP feature.

---

## Database Schema Changes

### 1. New Columns in `market_latest_data`

```sql
ALTER TABLE direct_exchanges_data.market_latest_data
ADD COLUMN IF NOT EXISTS reference_price NUMERIC(10,4),
ADD COLUMN IF NOT EXISTS band_liquidity_qty_ask NUMERIC(12,2),
ADD COLUMN IF NOT EXISTS band_liquidity_qty_bid NUMERIC(12,2),
ADD COLUMN IF NOT EXISTS band_vwap_ask NUMERIC(10,4),
ADD COLUMN IF NOT EXISTS band_vwap_bid NUMERIC(10,4),
ADD COLUMN IF NOT EXISTS band_delta_used NUMERIC(6,4);
```

| Column | Type | Description |
|--------|------|-------------|
| `reference_price` | NUMERIC(10,4) | Mid-price from dust-filtered best bid/ask |
| `band_liquidity_qty_ask` | NUMERIC(12,2) | Total ask quantity within execution band |
| `band_liquidity_qty_bid` | NUMERIC(12,2) | Total bid quantity within execution band |
| `band_vwap_ask` | NUMERIC(10,4) | Volume-weighted avg price for asks in band |
| `band_vwap_bid` | NUMERIC(10,4) | Volume-weighted avg price for bids in band |
| `band_delta_used` | NUMERIC(6,4) | The execution_band_delta config value used |

### 2. Bridge Table: `market_mappings`

The `market_mappings` table maps exchange-specific market identifiers to canonical market IDs.

**Current state:** Table exists but is empty.

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS direct_exchanges_data.market_mappings (
    source_id VARCHAR(50) NOT NULL,
    exchange_id VARCHAR(50) NOT NULL,
    market_id VARCHAR(255) NOT NULL,
    outcome_side VARCHAR(10),
    canonical_market_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (source_id, exchange_id, market_id, outcome_side)
);
```

**Required action:** Populate this table with mapping data before the feature can work correctly.

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           BAND METRICS DATA FLOW                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌──────────────┐         ┌──────────────┐         ┌──────────────┐       │
│   │ order_books  │         │market_mappings│        │market_latest │       │
│   │   (~24M rows)│         │  (bridge)    │         │    _data     │       │
│   └──────┬───────┘         └──────┬───────┘         └──────▲───────┘       │
│          │                        │                        │               │
│          │ bids/asks JSONB        │ market_id →            │ reference_price │
│          │                        │ canonical_market_id    │ band_liquidity  │
│          │                        │                        │ band_vwap       │
│          ▼                        ▼                        │               │
│   ┌───────────────────────────────────────────────────────┤               │
│   │              BAND METRICS CALCULATOR                   │               │
│   ├───────────────────────────────────────────────────────┤               │
│   │  1. Dust filter (min_executable_qty_for_reference)    │               │
│   │  2. Reference validity (max_reference_spread)          │               │
│   │  3. Reference price calculation                        │               │
│   │  4. Band filter (execution_band_delta)                │               │
│   │  5. Liquidity aggregation (execution_cap_qty)         │               │
│   │  6. VWAP calculation                                   │               │
│   │  7. Reference price clamping (VWAP guard)             │               │
│   │  8. Inverted VWAP sanity check                        │               │
│   └───────────────────────────────────────────────────────┘               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Dependencies

### Prerequisites (must be completed before feature deployment)

1. **Database migration:** Run the ALTER TABLE statement to add new columns
2. **market_mappings data:** Populate the bridge table with mapping data

### Runtime Dependencies

| Component | Required For |
|-----------|-------------|
| `order_books` table | Source of bid/ask data |
| `market_mappings` table | Mapping market_id to canonical_market_id |
| `market_latest_data` table | Storage of calculated metrics |

---

## Migration Checklist

- [ ] Run ALTER TABLE to add new columns to `market_latest_data`
- [ ] Verify columns exist with schema query
- [ ] Populate `market_mappings` with initial mapping data
- [ ] Deploy calculation logic
- [ ] Verify metrics are flowing with verification queries

---

## Rollback Plan

If issues arise, the new columns can be dropped:

```sql
ALTER TABLE direct_exchanges_data.market_latest_data
DROP COLUMN IF EXISTS reference_price,
DROP COLUMN IF EXISTS band_liquidity_qty_ask,
DROP COLUMN IF EXISTS band_liquidity_qty_bid,
DROP COLUMN IF EXISTS band_vwap_ask,
DROP COLUMN IF EXISTS band_vwap_bid,
DROP COLUMN IF EXISTS band_delta_used;
```

---

## Exchange-Specific Implementation Notes

### Polymarket
- Prices are already in decimal format (0-1 range)
- Each token/asset represents one outcome (YES or NO) - `outcome_side` cached from Gamma API
- Band metrics calculated in `packages/polymarket-listener/src/websocket/handlers.ts`
- Records skipped if `outcome_side` cache miss (avoids writing UNKNOWN)

### Kalshi
- Prices are in cents (1-100 range)
- Must normalize by dividing by 100 before calling `calculateBandMetrics()`
- **Each orderbook update emits TWO records** (one YES, one NO):
  - YES: bids from YES orders, asks from inverted NO orders
  - NO: bids from NO orders, asks from inverted YES orders
- Band metrics calculated separately for both sides in `packages/kalshi-listener/src/websocket/handlers.ts`

### Database Considerations
- `market_latest_data` unique constraint: `(source_id, exchange_id, market_id, outcome_side)`
- `order_books` unique constraint: `(source_id, exchange_id, market_id, outcome_side, time_exchange)`
- Batch deduplication keys must include `outcome_side` to preserve both YES and NO records

---

## Testing Strategy

### Unit Tests

**File:** `packages/shared/src/utils/__tests__/bandMetrics.test.ts`

| Test Case | Input | Expected Output |
|-----------|-------|-----------------|
| Normal market | Standard bid/ask book | reference_price calculated |
| Dust filtering | Small orders < 25 qty | Small orders ignored |
| Wide spread | Spread > 0.20 | All metrics = NULL |
| One-sided market | Only bids or only asks | All metrics = NULL |
| Empty book | No orders | All metrics = NULL |
| VWAP calculation | Multiple levels | Correct weighted average |
| Execution cap | Large liquidity | Capped at execution_cap_qty |
| VWAP guard (ref < vwap_bid) | Reference below VWAP band | reference_price clamped to vwap_bid |
| VWAP guard (ref > vwap_ask) | Reference above VWAP band | reference_price clamped to vwap_ask |
| Inverted VWAPs | vwap_bid > vwap_ask | VWAP and liquidity = NULL |

### Post-Deployment Validation

See verification queries in `usage.md`.

---

## Performance Considerations

- `order_books` table has ~24M rows - queries should be indexed appropriately
- Band metrics calculation should be incremental (process new/updated order books only)
- Consider batch processing for initial backfill if needed
