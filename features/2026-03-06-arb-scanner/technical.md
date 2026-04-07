# Technical: Arbitrage Scanner

Technical implementation details for the arb scanner service.

---

## Database Schema Changes

### New Tables

```sql
CREATE TABLE direct_exchanges_data.arb_opportunities (
    -- Identity
    arb_id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    canonical_market_id VARCHAR(50) NOT NULL,
    canonical_event_id  VARCHAR(50),

    -- Type
    arb_type            VARCHAR(20) NOT NULL,  -- 'DIRECT' or 'COMPLEMENT'

    -- Leg 1 (Buy side)
    leg1_exchange_id    VARCHAR(50) NOT NULL,
    leg1_source_id      VARCHAR(50) NOT NULL,
    leg1_market_id      VARCHAR(255) NOT NULL,
    leg1_side           VARCHAR(3) NOT NULL,    -- 'YES' or 'NO'
    leg1_action         VARCHAR(4) NOT NULL,    -- 'BUY'
    leg1_vwap           NUMERIC,               -- price used (vwap_ask)
    leg1_liquidity_qty  NUMERIC,               -- available qty

    -- Leg 2 (Sell side or second Buy)
    leg2_exchange_id    VARCHAR(50) NOT NULL,
    leg2_source_id      VARCHAR(50) NOT NULL,
    leg2_market_id      VARCHAR(255) NOT NULL,
    leg2_side           VARCHAR(3) NOT NULL,    -- 'YES' or 'NO'
    leg2_action         VARCHAR(4) NOT NULL,    -- 'SELL' (direct) or 'BUY' (complement)
    leg2_vwap           NUMERIC,               -- price used (vwap_bid or vwap_ask)
    leg2_liquidity_qty  NUMERIC,               -- available qty

    -- Opportunity Metrics
    gross_spread        NUMERIC NOT NULL,       -- raw price difference
    gross_spread_pct    NUMERIC NOT NULL,       -- spread as %
    executable_qty      NUMERIC,               -- MIN of both legs' liquidity
    gross_profit        NUMERIC,               -- spread * executable_qty

    -- Metadata
    market_title        VARCHAR(500),
    category            VARCHAR(100),
    expires_at          TIMESTAMPTZ,
    mapping_confidence  NUMERIC(5,4),          -- from market_mappings

    -- Lifecycle
    status              VARCHAR(20) DEFAULT 'ACTIVE',
                        -- ACTIVE | EXPIRED | EXECUTED | DISMISSED
    detected_at         TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    expired_at          TIMESTAMPTZ,

    -- Data freshness
    leg1_data_at        TIMESTAMPTZ,           -- market_latest_data.updated_at
    leg2_data_at        TIMESTAMPTZ            -- market_latest_data.updated_at
);

CREATE INDEX idx_arb_active ON direct_exchanges_data.arb_opportunities (status, gross_spread_pct DESC)
    WHERE status = 'ACTIVE';
CREATE INDEX idx_arb_canonical ON direct_exchanges_data.arb_opportunities (canonical_market_id, status);
CREATE INDEX idx_arb_detected ON direct_exchanges_data.arb_opportunities (detected_at DESC);
```

```sql
CREATE TABLE direct_exchanges_data.arb_config (
    config_key      VARCHAR(100) PRIMARY KEY,
    config_value    VARCHAR(255) NOT NULL,
    description     TEXT,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Production values as of 2026-03-13
INSERT INTO direct_exchanges_data.arb_config VALUES
('max_staleness_sec',     '900',    'Max age of orderbook data before excluding a leg (15 min)'),
('min_arb_pct',           '0.01',   'Minimum gross spread % to flag as opportunity (1%)'),
('min_confidence',        '0.95',   'Minimum market_mappings confidence_score'),
('scan_interval_sec',     '10',     'How often the scanner runs'),
('min_executable_qty',    '5',      'Minimum contracts to qualify as opportunity'),
('min_liquidity_usd',     '2',      'Minimum gross_profit USD to qualify'),
('expire_grace_sec',      '902',    'Grace period (sec) for arbs whose market was evaluated this cycle'),
('expire_long_grace_sec', '600',    'Grace period (sec) for arbs whose market could not be evaluated (stale legs)'),
('kalshi_fee_rate',       '0.07',   'Kalshi fee rate (on profit, not trade)'),
('polymarket_fee_rate',   '0.02',   'Polymarket taker fee rate'),
('default_fee_rate',      '0.01',   'Default fee rate for unknown exchanges');
```

---

## Data Flow

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ market_mappings  │     │ market_latest_   │     │  arb_config      │
│ (matched pairs)  │     │ data (VWAP/liq)  │     │  (thresholds)    │
└────────┬─────────┘     └────────┬─────────┘     └────────┬─────────┘
         │                        │                         │
         └────────────┬───────────┘                         │
                      │                                     │
               ┌──────▼──────┐                              │
               │ ARB SCANNER │◄─────────────────────────────┘
               │  (10s loop) │
               └──────┬──────┘
                      │
         ┌────────────▼────────────┐
         │  arb_opportunities      │
         │  (ACTIVE / EXPIRED)     │
         └────────────┬────────────┘
                      │
         ┌────────────▼────────────┐
         │  homepage-api           │
         │  GET /arb/{id}/refresh  │
         └─────────────────────────┘
```

### Scanner Loop (every scan_interval_sec)

```
1. READ arb_config params
2. QUERY matched markets with 2+ exchanges:
     market_mappings mm
     JOIN market_latest_data mld
       ON mm keys = mld keys
     WHERE mm.is_active = true
       AND mld.reference_price IS NOT NULL
       AND mld.updated_at > NOW() - max_staleness_sec
       AND mm.confidence_score >= min_confidence
3. GROUP BY canonical_market_id → build legs per market
4. For each market with legs on 2+ exchanges:
     a. Check Type A (direct): compare vwap_bid vs vwap_ask same side
     b. Check Type B (complement): compare YES ask + NO ask vs 1.00
5. UPSERT qualifying opportunities
6. EXPIRE any ACTIVE arbs not refreshed this cycle
```

---

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `packages/shared/src/db/queries.ts` | Modify | Add `fetchMatchedMarketLegs()`, `upsertArbOpportunity()`, `expireStaleArbs()`, `fetchArbConfig()` |
| `packages/shared/src/db/types.ts` | Modify | Add `ArbOpportunity`, `ArbConfig`, `MarketLeg` types |
| `packages/homepage-api/src/routes/arb.ts` | Create | `/api/v1/arb` list endpoint + `/api/v1/arb/:id/refresh` |
| `packages/homepage-api/src/services/arbScanner.ts` | Create | Scanner loop: load config, query legs, compute spreads, upsert |

### Implementation Option: Where to run the scanner

The scanner needs to run on a 10s interval. Two options:

**Option A — Inside homepage-api (recommended for v1):**
- Simpler deployment, no new Docker service
- Scanner runs as a background interval in the homepage-api process
- `/arb/{id}/refresh` endpoint lives in the same process

**Option B — Separate service:**
- Better isolation, independent scaling
- Adds deployment complexity (new Dockerfile, docker-compose entry, deploy script)
- Better for v2+ when scanner becomes more complex

---

## Dependencies

### Prerequisites

1. Run database migration (create `arb_opportunities` and `arb_config` tables)
2. `market_mappings` must have active entries (market matching must be running)
3. `market_latest_data` must have fresh band metrics (listeners must be running)

### Runtime Dependencies

| Component | Required For |
|-----------|-------------|
| `market_mappings` table | Source of matched market pairs |
| `market_latest_data` table | Live VWAP and liquidity data |
| `prediction_markets` table | Market metadata (title, category, expiry) |
| `event_mappings` table | Canonical event ID for UI grouping |
| `arb_config` table | Runtime-configurable thresholds |

---

## Migration Checklist

- [ ] Run `arb_opportunities` CREATE TABLE on server
- [ ] Run `arb_config` CREATE TABLE + INSERT defaults on server
- [ ] Deploy application code
- [ ] Verify scanner is running (check logs)
- [ ] Verify arbs are being detected (query `arb_opportunities`)

---

## Rollback Plan

```sql
-- Drop tables if needed
DROP TABLE IF EXISTS direct_exchanges_data.arb_opportunities;
DROP TABLE IF EXISTS direct_exchanges_data.arb_config;
```

No impact on existing tables — these are purely additive.

---

## API Endpoints

### List Active Arbs

```
GET /api/v1/arb?sort=spread&limit=20&category=crypto
```

Returns active opportunities sorted by spread, with optional category filter.

### Refresh Single Arb

```
GET /api/v1/arb/:arb_id/refresh

Response:
{
  still_valid: true/false,
  gross_spread_pct: 0.035,
  executable_qty: 120,
  gross_profit: 4.20,
  data_age_ms: 850,
  leg1: { vwap: 0.45, liq: 200, book_age_ms: 500 },
  leg2: { vwap: 0.52, liq: 150, book_age_ms: 1200 }
}
```

1. Read arb record → get both legs' market IDs
2. Query FRESH `order_books` for both legs (latest snapshot)
3. Recalculate band metrics in real-time using `computeBandMetrics()`
4. Recompute spread & executable qty
5. If no longer valid → update status = EXPIRED in DB

---

## Testing Strategy

### Unit Tests

**File:** `packages/homepage-api/src/services/__tests__/arbScanner.test.ts`

| Test Case | Input | Expected Output |
|-----------|-------|-----------------|
| Direct arb detected | K ask=0.45, P bid=0.52 | spread=0.07, type=DIRECT |
| Complement arb detected | K YES ask=0.42, P NO ask=0.51 | spread=0.07, type=COMPLEMENT |
| No arb (negative spread) | K ask=0.50, P bid=0.49 | No opportunity recorded |
| Stale data filtered | updated_at 60s ago, max_staleness=30 | Market skipped |
| Low confidence filtered | confidence=0.80, min=0.95 | Market skipped |
| Null reference price | ref_price=NULL | Market skipped |
| Below min qty | executable_qty=5, min=10 | Opportunity skipped |
| Expire logic | ACTIVE arb not refreshed | status → EXPIRED |

---

## Performance Considerations

- Scanner query joins `market_mappings` + `market_latest_data` — both indexed on `(source_id, exchange_id, market_id, outcome_side)`
- Upsert uses composite key `(canonical_market_id, arb_type, leg1_exchange_id, leg2_exchange_id)` — needs unique index
- 10s scan interval is aggressive; monitor DB load and adjust if needed
- Expire logic should use a single UPDATE WHERE, not per-row
- The refresh endpoint queries `order_books` which is partitioned (hourly, 4h retention) — fast for recent data

---

## Scope (v1 vs Future)

| Component | Version | Notes |
|-----------|---------|-------|
| Scanner (detect & store) | v1 | P0 |
| Expire logic | v1 | P0 |
| List arbs API | v1 | P0 |
| Refresh on click API | v1 | P1 |
| Fee-adjusted net profit | v2 | Apply exchange fees to spread |
| Depth profitability curve | v2 | Walk full order book beyond band |
| Auto-execution | Future | Place orders via exchange APIs |
| Alerting | Future | Push notifications for large arbs |
