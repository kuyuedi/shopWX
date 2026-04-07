# Usage: Arbitrage Scanner

How to use and verify the arb scanner.

---

## Database Tables

### `arb_opportunities`

Stores detected arbitrage opportunities.

| Column | Type | Description |
|--------|------|-------------|
| `arb_id` | BIGINT | Auto-increment primary key |
| `canonical_market_id` | VARCHAR(50) | Links to market_mappings |
| `canonical_event_id` | VARCHAR(50) | For event grouping in UI |
| `arb_type` | VARCHAR(20) | 'DIRECT' or 'COMPLEMENT' |
| `leg1_exchange_id` | VARCHAR(50) | Buy side exchange |
| `leg1_market_id` | VARCHAR(255) | Buy side market |
| `leg1_side` | VARCHAR(3) | 'YES' or 'NO' |
| `leg1_vwap` | NUMERIC | VWAP price used |
| `leg1_liquidity_qty` | NUMERIC | Available quantity |
| `leg2_exchange_id` | VARCHAR(50) | Sell/second buy exchange |
| `leg2_market_id` | VARCHAR(255) | Sell/second buy market |
| `leg2_side` | VARCHAR(3) | 'YES' or 'NO' |
| `leg2_vwap` | NUMERIC | VWAP price used |
| `leg2_liquidity_qty` | NUMERIC | Available quantity |
| `gross_spread` | NUMERIC | Raw price difference |
| `gross_spread_pct` | NUMERIC | Spread as percentage |
| `executable_qty` | NUMERIC | Min of both legs' liquidity |
| `gross_profit` | NUMERIC | spread * executable_qty |
| `status` | VARCHAR(20) | ACTIVE / EXPIRED / EXECUTED / DISMISSED |
| `detected_at` | TIMESTAMPTZ | When first detected |
| `updated_at` | TIMESTAMPTZ | Last refreshed |

### `arb_config`

Runtime-configurable parameters. Updated via direct SQL on the production database.

| Key | Production Value | Description |
|-----|-----------------|-------------|
| `max_staleness_sec` | `900` | Max age of orderbook data before excluding a leg (15 min) |
| `min_arb_pct` | `0.01` | Min spread % to flag (1%) |
| `min_confidence` | `0.95` | Min mapping confidence |
| `scan_interval_sec` | `10` | Scanner loop interval |
| `min_executable_qty` | `5` | Min contracts to qualify |
| `min_liquidity_usd` | `2` | Min gross profit USD |
| `expire_grace_sec` | `902` | Grace period for evaluated arbs (must be ≥ max_staleness_sec) |
| `expire_long_grace_sec` | `600` | Grace period for arbs when market legs are stale |
| `kalshi_fee_rate` | `0.07` | Kalshi fee rate (on profit) |
| `polymarket_fee_rate` | `0.02` | Polymarket taker fee rate |
| `default_fee_rate` | `0.01` | Default fee for unknown exchanges |

---

## Verification Queries

### 1. Verify scanner is detecting arbs

```sql
SELECT COUNT(*), status
FROM direct_exchanges_data.arb_opportunities
GROUP BY status;
```

**Expected:** Non-zero ACTIVE count if arbs exist.

### 2. View top active opportunities

```sql
SELECT arb_type, market_title, category,
       leg1_exchange_id, leg1_vwap, leg2_exchange_id, leg2_vwap,
       gross_spread_pct, executable_qty, gross_profit,
       detected_at, updated_at
FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE'
ORDER BY gross_spread_pct DESC
LIMIT 20;
```

### 3. Check data freshness

```sql
SELECT arb_id, market_title,
       EXTRACT(EPOCH FROM NOW() - leg1_data_at) AS leg1_age_sec,
       EXTRACT(EPOCH FROM NOW() - leg2_data_at) AS leg2_age_sec,
       EXTRACT(EPOCH FROM NOW() - updated_at) AS last_scan_age_sec
FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE'
ORDER BY updated_at DESC
LIMIT 10;
```

**Expected:** `last_scan_age_sec` should be < scan_interval_sec for active arbs.

---

## Statistics Queries

### Summary by type and category

```sql
SELECT arb_type, category,
       COUNT(*) as count,
       ROUND(AVG(gross_spread_pct), 4) as avg_spread_pct,
       ROUND(SUM(gross_profit), 2) as total_profit
FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE'
GROUP BY arb_type, category
ORDER BY total_profit DESC;
```

### Arb lifecycle stats

```sql
SELECT status,
       COUNT(*) as count,
       AVG(EXTRACT(EPOCH FROM COALESCE(expired_at, NOW()) - detected_at)) as avg_duration_sec
FROM direct_exchanges_data.arb_opportunities
GROUP BY status;
```

---

## API Endpoints

### List active arbs

```bash
curl -s 'http://8.216.43.26:3100/api/v1/arb?sort=spread&limit=10'
```

### Refresh a specific arb

```bash
curl -s 'http://8.216.43.26:3100/api/v1/arb/123/refresh'
```

---

## Example Output

### Sample active opportunity

```
arb_type          | COMPLEMENT
market_title      | Will BTC hit $100k by June?
leg1_exchange_id  | KALSHI
leg1_side         | YES
leg1_vwap         | 0.42
leg1_liquidity_qty| 300
leg2_exchange_id  | POLYMARKET
leg2_side         | NO
leg2_vwap         | 0.51
leg2_liquidity_qty| 450
gross_spread      | 0.07
gross_spread_pct  | 0.0753
executable_qty    | 300
gross_profit      | 21.00
status            | ACTIVE
```

### Interpretation

- **arb_type = COMPLEMENT**: Buy YES on Kalshi + Buy NO on Polymarket = guaranteed $1 payout
- **gross_spread_pct = 7.53%**: Attractive opportunity
- **executable_qty = 300**: Can execute 300 contracts (limited by Kalshi's ask liquidity)
- **gross_profit = $21.00**: Expected gross profit before fees

---

## Troubleshooting

### No arbs detected

1. Check `market_mappings` has entries: `SELECT COUNT(*) FROM market_mappings`
2. Check `market_latest_data` has fresh data: `SELECT exchange_id, COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '900 seconds') as fresh FROM market_latest_data GROUP BY exchange_id`
3. Check config isn't too restrictive: `SELECT * FROM arb_config`
4. Lower `min_arb_pct` temporarily to see if opportunities exist at smaller spreads
5. Check the arb funnel — how many markets have both exchanges fresh:
```sql
SELECT COUNT(*) FROM (
  SELECT canonical_market_id FROM market_mappings mm
  JOIN market_latest_data mld ON mm.source_id = mld.source_id
    AND mm.exchange_id = mld.exchange_id AND mm.market_id = mld.market_id
    AND mm.outcome_side = mld.outcome_side
  WHERE mld.reference_price IS NOT NULL
    AND mld.updated_at > NOW() - INTERVAL '900 seconds'
    AND mm.confidence_score >= 0.95
  GROUP BY canonical_market_id
  HAVING COUNT(DISTINCT mm.exchange_id) >= 2
) sub;
```

### Arb count decays after restart then stabilizes

This is expected behavior. After a Kalshi restart, all markets get fresh `orderbook_snapshot` messages, spiking arb count to ~346. Within 15-30 min, low-volume Kalshi markets age past `max_staleness_sec` (900s) without receiving any `orderbook_delta`, and the arb count settles to steady state of ~200-260. Polymarket stays fresh (~99%) thanks to `price_change` delta accumulation.

### All arbs immediately expire (oscillation)

Data staleness issue. `updated_at` in `market_latest_data` only refreshes on **orderbook updates** (when `band_delta_used IS NOT NULL`), not on price-only updates. Low-volume Kalshi markets may go 15+ minutes between orderbook deltas. Polymarket markets stay fresh via `price_change` delta accumulation.

**Fix:** Increase `max_staleness_sec` (currently 900 = 15 min). Also increase `expire_grace_sec` to match (must be ≥ `max_staleness_sec`). Increase `expire_long_grace_sec` proportionally.

### Dead mappings (orphaned rows)

Over time, `market_mappings` rows can point to `prediction_markets` rows that no longer exist (markets closed/removed). Clean up with:
```sql
DELETE FROM market_mappings mm
USING (
  SELECT mm2.source_id, mm2.exchange_id, mm2.market_id, mm2.outcome_side
  FROM market_mappings mm2
  LEFT JOIN prediction_markets pm ON mm2.source_id = pm.source_id
    AND mm2.exchange_id = pm.exchange_id AND mm2.market_id = pm.market_id
    AND mm2.outcome_side = pm.outcome_side
  WHERE pm.market_id IS NULL
) dead
WHERE mm.source_id = dead.source_id
  AND mm.exchange_id = dead.exchange_id
  AND mm.market_id = dead.market_id
  AND mm.outcome_side = dead.outcome_side;
```

### Scanner not running

Check homepage-api logs: `docker compose logs --tail 50 homepage-api | grep arb`
