# Feature: Arbitrage Scanner (Type 1 — Synthetic Arbs)

**Status**: NEW
**Priority**: High
**Created**: 2026-03-06

---

## Summary

Continuously scan matched markets across exchanges, detect price discrepancies (arbitrage opportunities), and store them in a DB table for the frontend to consume.

---

## Problem

We have matched markets across Kalshi and Polymarket with live order book data and band metrics, but no automated way to detect when prices diverge enough to create an arbitrage opportunity. Users need to manually compare prices across exchanges.

---

## Solution

A backend scanner service that runs on a configurable interval (default 10s), compares VWAP prices from `market_latest_data` for all matched market pairs, and writes detected opportunities to an `arb_opportunities` table.

---

## Algorithm / Logic

### Arb Types

**Type A — Direct Arb:** Same outcome side, different exchanges. Buy low, sell high.
```
spread = ExB.vwap_bid - ExA.vwap_ask
Action: Buy YES on A, Sell YES on B
```

**Type B — Complement Arb:** Opposite sides, different exchanges. Combined cost < 1.00 = guaranteed profit.
```
combined_cost = ExA.vwap_ask(YES) + ExB.vwap_ask(NO)
spread = 1.00 - combined_cost
Action: Buy YES on A, Buy NO on B → guaranteed $1 payout at settlement
```

### Scan Algorithm

```
FOR each canonical_market_id with 2+ exchanges:

  1. LOAD all exchange legs:
     (exchange, outcome_side, vwap_ask, vwap_bid, liq_ask, liq_bid, updated_at)

  2. FILTER: Skip if any leg has:
     - reference_price IS NULL (invalid book)
     - updated_at older than max_staleness_sec (default 30s)
     - confidence_score < min_confidence (default 0.95)

  3. CHECK Type A (Direct):
     For every pair (ExA, ExB) where both have same outcome_side:
       spread = ExB.vwap_bid - ExA.vwap_ask
       spread_pct = spread / ExA.vwap_ask
       IF spread_pct >= min_arb_pct → RECORD opportunity

  4. CHECK Type B (Complement):
     For every pair (ExA YES, ExB NO):
       combined_cost = ExA.vwap_ask(YES) + ExB.vwap_ask(NO)
       spread = 1.00 - combined_cost
       spread_pct = spread / combined_cost
       IF spread_pct >= min_arb_pct → RECORD opportunity

  5. EXECUTABLE SIZE:
     Type A: MIN(liq_ask_A, liq_bid_B)
     Type B: MIN(liq_ask_A_yes, liq_ask_B_no)

  6. GROSS PROFIT:
     spread * executable_qty
```

### Upsert Logic

- **Key:** `(canonical_market_id, arb_type, leg1_exchange_id, leg2_exchange_id)`
- Same arb still qualifies → UPDATE spread, qty, profit, updated_at
- Same arb no longer qualifies → SET status = 'EXPIRED', expired_at = NOW()
- New arb → INSERT status = 'ACTIVE'
- Any ACTIVE arb not refreshed in a scan cycle → mark EXPIRED

---

## Configuration

| Parameter | Description | Default | Production (2026-03-13) |
|-----------|-------------|---------|------------------------|
| `max_staleness_sec` | Max age of orderbook data before excluding a leg | `30` | `900` (15 min) |
| `min_arb_pct` | Minimum gross spread % to flag as opportunity | `0.02` (2%) | `0.01` (1%) |
| `min_executable_qty` | Minimum contracts to qualify | `10` | `5` |
| `min_liquidity_usd` | Minimum gross_profit USD to qualify | `5` | `2` |
| `min_confidence` | Minimum market_mappings confidence_score | `0.95` | `0.95` |
| `scan_interval_sec` | How often the scanner runs | `10` | `10` |
| `expire_grace_sec` | Grace period for arbs whose market was evaluated this cycle | `30` | `902` |
| `expire_long_grace_sec` | Grace period for arbs whose market could NOT be evaluated (stale legs) | `90` | `600` |
| `kalshi_fee_rate` | Kalshi fee rate (on profit, not trade) | `0.07` | `0.07` |
| `polymarket_fee_rate` | Polymarket taker fee rate | `0.02` | `0.02` |
| `default_fee_rate` | Default fee rate for unknown exchanges | `0.03` | `0.01` |

**Tuning rationale (2026-03-13):**
- `max_staleness_sec` increased from 120→900 because Kalshi low-volume markets may not receive orderbook deltas for 15+ minutes. At 120s, only ~12 markets had both legs fresh simultaneously.
- `min_arb_pct` lowered from 0.02→0.01 because real cross-exchange spreads are typically 1-1.5%.
- `expire_grace_sec` must be ≥ `max_staleness_sec` so arbs don't expire just because one leg briefly went stale.

**Steady-state behavior (2026-03-14):**
- After a Kalshi restart, arb count spikes to ~346 (all markets get fresh snapshots).
- Within 15-30 min, arbs decay to steady state of ~200-260 as low-volume Kalshi markets age past `max_staleness_sec` without receiving new orderbook deltas.
- This is expected — only ~35% of matched Kalshi legs stay fresh within 15 min. Polymarket stays at ~99% freshness thanks to `price_change` delta accumulation.
- The post-restart spike then decay to steady state is normal, not a bug.

---

## Input Data

| Source | Table | Fields Used |
|--------|-------|-------------|
| Matched markets | `market_mappings` | `canonical_market_id`, `exchange_id`, `market_id`, `outcome_side`, `confidence_score` |
| Live pricing | `market_latest_data` | `band_vwap_ask`, `band_vwap_bid`, `band_liquidity_qty_ask`, `band_liquidity_qty_bid`, `reference_price`, `updated_at` |
| Market metadata | `prediction_markets` | `title`, `category`, `expires_at`, `status` |
| Event grouping | `event_mappings` | `canonical_event_id` |

### Join Logic

```sql
-- Find canonical_market_ids on 2+ exchanges
SELECT canonical_market_id
FROM market_mappings
WHERE is_active = true
GROUP BY canonical_market_id, outcome_side
HAVING COUNT(DISTINCT exchange_id) >= 2

-- For each pair, join to market_latest_data
market_mappings mm
JOIN market_latest_data mld
  ON mm.source_id = mld.source_id
 AND mm.exchange_id = mld.exchange_id
 AND mm.market_id = mld.market_id
 AND mm.outcome_side = mld.outcome_side
```

---

## Output Data

| Table | Field | Type | Description |
|-------|-------|------|-------------|
| `arb_opportunities` | `arb_id` | BIGINT | Auto-increment PK |
| | `canonical_market_id` | VARCHAR(50) | Links to market_mappings |
| | `canonical_event_id` | VARCHAR(50) | For UI grouping |
| | `arb_type` | VARCHAR(20) | 'DIRECT' or 'COMPLEMENT' |
| | `leg1_exchange_id` | VARCHAR(50) | Buy side exchange |
| | `leg1_market_id` | VARCHAR(255) | Buy side market |
| | `leg1_side` | VARCHAR(3) | 'YES' or 'NO' |
| | `leg1_action` | VARCHAR(4) | 'BUY' |
| | `leg1_vwap` | NUMERIC | Price used (vwap_ask) |
| | `leg1_liquidity_qty` | NUMERIC | Available qty |
| | `leg2_exchange_id` | VARCHAR(50) | Sell/second buy exchange |
| | `leg2_market_id` | VARCHAR(255) | Sell/second buy market |
| | `leg2_side` | VARCHAR(3) | 'YES' or 'NO' |
| | `leg2_action` | VARCHAR(4) | 'SELL' or 'BUY' |
| | `leg2_vwap` | NUMERIC | Price used |
| | `leg2_liquidity_qty` | NUMERIC | Available qty |
| | `gross_spread` | NUMERIC | Raw price difference |
| | `gross_spread_pct` | NUMERIC | Spread as % |
| | `executable_qty` | NUMERIC | MIN of both legs' liquidity |
| | `gross_profit` | NUMERIC | spread * executable_qty |
| | `market_title` | VARCHAR(500) | For display |
| | `category` | VARCHAR(100) | For filtering |
| | `expires_at` | TIMESTAMPTZ | Market expiry |
| | `mapping_confidence` | NUMERIC(5,4) | From market_mappings |
| | `status` | VARCHAR(20) | ACTIVE / EXPIRED / EXECUTED / DISMISSED |
| | `detected_at` | TIMESTAMPTZ | First detected |
| | `updated_at` | TIMESTAMPTZ | Last refreshed |
| | `expired_at` | TIMESTAMPTZ | When opportunity closed |
| | `leg1_data_at` | TIMESTAMPTZ | Freshness of leg 1 data |
| | `leg2_data_at` | TIMESTAMPTZ | Freshness of leg 2 data |

---

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| One leg has NULL reference_price | Skip this market pair |
| Data older than max_staleness_sec | Skip — stale data unreliable |
| Mapping confidence < min_confidence | Skip — uncertain match |
| Both legs on same exchange | Skip — not cross-exchange arb |
| Executable qty < min_executable_qty | Skip — too small to execute |
| Gross profit < min_liquidity_usd | Skip — not worth the effort |
| Market expired/closed | Skip — not tradeable |

---

## Acceptance Criteria

- [ ] Scanner detects Type A (direct) arbs across matched markets
- [ ] Scanner detects Type B (complement) arbs across matched markets
- [ ] Opportunities are upserted (not duplicated) on each scan cycle
- [ ] Stale opportunities are automatically expired
- [ ] Scan runs on configurable interval (default 10s)
- [ ] Staleness, confidence, and minimum size filters work correctly
- [ ] `/arb/{id}/refresh` endpoint returns fresh recalculation from order books

---

## Examples

### Example 1: Complement Arb

**Input:**
```
Kalshi YES vwap_ask: 0.42, liq: 300
Polymarket NO vwap_ask: 0.51, liq: 450
```

**Expected Output:**
```
arb_type: COMPLEMENT
gross_spread: 0.07 (1.00 - 0.42 - 0.51)
gross_spread_pct: 7.53%
executable_qty: 300 (min of both legs)
gross_profit: $21.00
```

### Example 2: Direct Arb

**Input:**
```
Kalshi YES vwap_ask: 0.45, liq: 200
Polymarket YES vwap_bid: 0.52, liq: 150
```

**Expected Output:**
```
arb_type: DIRECT
gross_spread: 0.07 (0.52 - 0.45)
gross_spread_pct: 15.56%
executable_qty: 150 (min of both legs)
gross_profit: $10.50
```

### Example 3: No Arb (Filtered Out)

**Input:**
```
Kalshi YES vwap_ask: 0.50, liq: 200
Polymarket YES vwap_bid: 0.49, liq: 150
```

**Expected Output:** No record — spread is negative (-0.01).

---

## Notes

- **v1 scope:** Detection and storage only. No fee-adjusted net profit, no depth profiling, no auto-execution.
- Fee rates stored in config for future v2 net profit calculations.
- The refresh endpoint recalculates from live order books, not cached band metrics.
