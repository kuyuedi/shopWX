# Feature: Best Price, Band Liquidity & VWAP Calculation

**Status**: COMPLETED
**Priority**: High
**Created**: 2026-02-04

---

## Summary

Calculate execution-realistic pricing metrics (best price, band liquidity, VWAP) from live order books for arbitrage detection.

---

## Problem

Current order book data doesn't filter out:
- Dust/junk orders with negligible size
- Anchoring orders at extreme prices
- One-sided or incoherent books

We need execution-realistic metrics for accurate arbitrage calculations.

---

## Solution

Compute metrics constrained to a configurable price relevance band around a validated, liquidity-anchored reference price.

---

## Algorithm / Logic

### Step 1: Dust Filter
Filter orders below minimum executable quantity:
```
eligible_asks = asks WHERE quantity >= min_executable_qty_for_reference
eligible_bids = bids WHERE quantity >= min_executable_qty_for_reference
```

### Step 2: Raw Best Prices
```
best_ask_raw = MIN(price) FROM eligible_asks
best_bid_raw = MAX(price) FROM eligible_bids
```

### Step 3: Reference Validity Check
```
IF both sides exist:
    spread = best_ask_raw - best_bid_raw
    IF spread > max_reference_spread:
        REJECT → all metrics = NULL
ELSE:
    REJECT → all metrics = NULL
```

### Step 4: Reference Price
```
reference_price = (best_ask_raw + best_bid_raw) / 2
```

### Step 5: Band Filter
```
band_min = reference_price - execution_band_delta
band_max = reference_price + execution_band_delta

best_ask = MIN(price) FROM asks WHERE price IN [band_min, band_max]
best_bid = MAX(price) FROM bids WHERE price IN [band_min, band_max]
```

### Step 6: Band Liquidity
```
Process asks in ascending price order until:
  - Band exhausted, OR
  - Cumulative quantity reaches execution_cap_qty

band_liquidity_qty_ask = SUM(taken_quantity)
```

### Step 7: Band VWAP
```
band_vwap_ask = SUM(price × taken_quantity) / SUM(taken_quantity)
band_vwap_bid = SUM(price × taken_quantity) / SUM(taken_quantity)
```

### Step 8: Reference Price Clamping (VWAP Guard)
Ensures reference_price stays within the VWAP band:
```
IF band_vwap_bid IS NOT NULL AND band_vwap_ask IS NOT NULL:
    reference_price = CLAMP(reference_price, band_vwap_bid, band_vwap_ask)
```

### Step 9: Inverted VWAP Sanity Check
Guards against edge cases where VWAPs are inverted:
```
IF band_vwap_bid > band_vwap_ask:
    band_vwap_bid = NULL
    band_vwap_ask = NULL
    band_liquidity_qty_bid = NULL
    band_liquidity_qty_ask = NULL
```

---

## Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `min_executable_qty_for_reference` | Min qty to influence reference | 25 |
| `max_reference_spread` | Max bid-ask gap for valid reference | 0.20 |
| `execution_band_delta` | Max distance from reference | 0.01 |
| `execution_cap_qty` | Max quantity per side | 500 |
| `min_book_levels` | Min eligible levels per side for valid reference | 1 |

---

## Input Data

| Source | Table | Fields Used |
|--------|-------|-------------|
| Order books | `order_books` | market_id, bids, asks, time_exchange |
| Market mappings | `market_mappings` | source_id, exchange_id, market_id, outcome_side, canonical_market_id |

**Note:** `market_mappings` is a bridge table that maps (source_id, exchange_id, market_id, outcome_side) → canonical_market_id. This table must be populated for the feature to work correctly.

---

## Output Data

| Table | Field | Type | Description |
|-------|-------|------|-------------|
| `market_latest_data` | reference_price | NUMERIC(10,4) | Mid-price from eligible levels |
| `market_latest_data` | best_ask | NUMERIC(10,4) | Best ask within band (existing column) |
| `market_latest_data` | best_bid | NUMERIC(10,4) | Best bid within band (existing column) |
| `market_latest_data` | band_liquidity_qty_ask | NUMERIC(12,2) | Total ask liquidity in band (capped at execution_cap_qty) |
| `market_latest_data` | band_liquidity_qty_bid | NUMERIC(12,2) | Total bid liquidity in band (capped at execution_cap_qty) |
| `market_latest_data` | band_vwap_ask | NUMERIC(10,4) | VWAP for ask side within band |
| `market_latest_data` | band_vwap_bid | NUMERIC(10,4) | VWAP for bid side within band |
| `market_latest_data` | band_delta_used | NUMERIC(6,4) | The execution_band_delta value used for this calculation |

---

## Database Migration

The following columns must be added to `market_latest_data`:

```sql
ALTER TABLE direct_exchanges_data.market_latest_data
ADD COLUMN IF NOT EXISTS reference_price NUMERIC(10,4),
ADD COLUMN IF NOT EXISTS band_liquidity_qty_ask NUMERIC(12,2),
ADD COLUMN IF NOT EXISTS band_liquidity_qty_bid NUMERIC(12,2),
ADD COLUMN IF NOT EXISTS band_vwap_ask NUMERIC(10,4),
ADD COLUMN IF NOT EXISTS band_vwap_bid NUMERIC(10,4),
ADD COLUMN IF NOT EXISTS band_delta_used NUMERIC(6,4);
```

**Prerequisites:**
- `market_mappings` table must be populated with mapping data before metrics can flow correctly
- See `technical.md` for full migration details

---

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| Empty order book | All metrics = NULL |
| One-sided market | All metrics = NULL (rejected) |
| Spread > max_reference_spread | All metrics = NULL (rejected) |
| All orders are dust | All metrics = NULL |
| No orders in band | best_ask/best_bid = NULL, liquidity = 0 |
| Reference outside VWAP band | reference_price clamped to [vwap_bid, vwap_ask] |
| Inverted VWAPs (bid > ask) | VWAP and liquidity metrics = NULL |

---

## Acceptance Criteria

- [x] Dust orders never affect reference price
- [x] Wide-spread books are rejected (spread > 0.20)
- [x] One-sided books are rejected
- [x] VWAP calculation is mathematically correct
- [x] Configuration parameters are tunable without code changes
- [x] Metrics are deterministic and reproducible
- [x] Reference price is always within VWAP band (clamped if necessary)
- [x] Inverted VWAPs (bid > ask) are nulled out as invalid

---

## Verification

```sql
-- 1. Verify columns exist
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'direct_exchanges_data'
  AND table_name = 'market_latest_data'
  AND column_name IN ('reference_price', 'band_liquidity_qty_ask', 'band_liquidity_qty_bid',
                      'band_vwap_ask', 'band_vwap_bid', 'band_delta_used');

-- 2. Check reference prices are being calculated
SELECT
    market_id,
    reference_price,
    best_ask,
    best_bid,
    band_liquidity_qty_ask,
    band_liquidity_qty_bid,
    band_vwap_ask,
    band_vwap_bid,
    band_delta_used
FROM direct_exchanges_data.market_latest_data
WHERE updated_at > NOW() - INTERVAL '5 minutes'
  AND reference_price IS NOT NULL
LIMIT 10;

-- 3. Check rejection rate by exchange
SELECT
    exchange_id,
    COUNT(*) FILTER (WHERE reference_price IS NOT NULL) as valid,
    COUNT(*) FILTER (WHERE reference_price IS NULL) as rejected,
    COUNT(*) as total
FROM direct_exchanges_data.market_latest_data
WHERE updated_at > NOW() - INTERVAL '1 hour'
GROUP BY exchange_id;

-- 4. Verify data flowing (recent updates with metrics)
SELECT COUNT(*)
FROM direct_exchanges_data.market_latest_data
WHERE reference_price IS NOT NULL
  AND updated_at > NOW() - INTERVAL '5 minutes';
```

---

## Examples

### Example 1: Normal Market

**Input:**
```json
{
  "asks": [
    {"price": 0.50, "quantity": 100},
    {"price": 0.51, "quantity": 200}
  ],
  "bids": [
    {"price": 0.49, "quantity": 150},
    {"price": 0.48, "quantity": 100}
  ]
}
```

**Expected Output:**
```json
{
  "reference_price": 0.495,
  "best_ask": 0.50,
  "best_bid": 0.49,
  "band_liquidity_qty_ask": 100,
  "band_vwap_ask": 0.50
}
```

### Example 2: Wide Spread (Rejected)

**Input:**
```json
{
  "asks": [{"price": 0.70, "quantity": 100}],
  "bids": [{"price": 0.30, "quantity": 150}]
}
```

**Expected Output:**
```json
{
  "reference_price": null,
  "best_ask": null,
  "best_bid": null,
  "reason": "Spread 0.40 exceeds max_reference_spread 0.20"
}
```

### Example 3: Anchoring Attack (Filtered)

**Input:**
```json
{
  "asks": [
    {"price": 0.01, "quantity": 5},
    {"price": 0.50, "quantity": 100}
  ],
  "bids": [{"price": 0.49, "quantity": 150}]
}
```

**Expected Output:**
```json
{
  "reference_price": 0.495,
  "best_ask": 0.50,
  "best_bid": 0.49,
  "note": "0.01 ask filtered as dust (qty 5 < 25)"
}
```

---

## Notes

- Full PRD available in `expirements/PRD - creation of best price, band liquidity and band vwap.docx`
- Algorithm validation report: `expirements/PRD-best-price-algorithm-validation-v2.html`
- Phase-2 may include: dynamic delta, per-market config, liquidity scoring
