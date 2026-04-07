# Band Metrics Feature - Usage Guide

## Quick Dashboard

**Copy-paste this single query to see everything at once:**

```sql
SELECT
    exchange_id,
    COUNT(*) as total_markets,
    COUNT(reference_price) as with_band_metrics,
    ROUND(100.0 * COUNT(reference_price) / COUNT(*), 1) as metrics_pct,
    ROUND(AVG(band_liquidity_qty_ask), 0) as avg_ask_liq,
    ROUND(AVG(band_liquidity_qty_bid), 0) as avg_bid_liq,
    MAX(updated_at) as last_update
FROM direct_exchanges_data.market_latest_data
WHERE updated_at > NOW() - INTERVAL '5 minutes'
GROUP BY exchange_id
ORDER BY total_markets DESC;
```

**Expected output:**
```
 exchange_id | total_markets | with_band_metrics | metrics_pct | avg_ask_liq | avg_bid_liq |       last_update
-------------+---------------+-------------------+-------------+-------------+-------------+-------------------------
 POLYMARKET  |         85000 |             30000 |        35.0 |         367 |         368 | 2026-02-05 05:53:00
 KALSHI      |         25000 |               100 |         0.4 |         260 |         240 | 2026-02-05 05:53:00
```

**Note:** Kalshi typically shows lower `metrics_pct` (~0.5-5%) because:
- Kalshi orderbooks have smaller quantities (many filtered by dust filter with min 25 qty)
- Kalshi prices are in cents (1-100) and normalized to 0-1 before calculation
- Many Kalshi markets have wide spreads (>20%) which invalidates reference price

---

## Data Flow Check

### Is data flowing?

```sql
SELECT exchange_id, COUNT(*), MAX(updated_at) as latest
FROM direct_exchanges_data.market_latest_data
WHERE updated_at > NOW() - INTERVAL '1 minute'
GROUP BY exchange_id;
```

### Table health (should be ~100k rows, not millions)

```sql
SELECT
    COUNT(*) as rows,
    pg_size_pretty(pg_total_relation_size('direct_exchanges_data.market_latest_data')) as size
FROM direct_exchanges_data.market_latest_data;
```

### outcome_side distribution (should have NO nulls)

```sql
SELECT outcome_side, COUNT(*) FROM direct_exchanges_data.market_latest_data GROUP BY 1;
```

---

## View Sample Data

### Markets with band metrics

```sql
SELECT
    market_id,
    exchange_id,
    outcome_side,
    reference_price,
    band_vwap_ask,
    band_vwap_bid,
    band_liquidity_qty_ask as ask_liq,
    band_liquidity_qty_bid as bid_liq,
    updated_at
FROM direct_exchanges_data.market_latest_data
WHERE reference_price IS NOT NULL
ORDER BY updated_at DESC
LIMIT 20;
```

### Markets WITHOUT band metrics (to investigate why)

```sql
SELECT
    market_id,
    exchange_id,
    outcome_side,
    price_close,
    updated_at
FROM direct_exchanges_data.market_latest_data
WHERE reference_price IS NULL
  AND updated_at > NOW() - INTERVAL '5 minutes'
ORDER BY updated_at DESC
LIMIT 20;
```

### Kalshi markets WITH full band metrics (liquidity populated)

```sql
SELECT
    market_id,
    reference_price,
    band_vwap_ask,
    band_vwap_bid,
    band_liquidity_qty_ask,
    band_liquidity_qty_bid
FROM direct_exchanges_data.market_latest_data
WHERE exchange_id = 'KALSHI'
  AND reference_price IS NOT NULL
  AND band_liquidity_qty_ask IS NOT NULL
ORDER BY updated_at DESC
LIMIT 5;
```

**Example output (all columns populated):**
```
          market_id           | reference_price | band_vwap_ask | band_vwap_bid | band_liquidity_qty_ask | band_liquidity_qty_bid
------------------------------+-----------------+---------------+---------------+------------------------+------------------------
 KXUSAEXPANDTERRITORY-28JAN01 |          0.4350 |        0.4400 |        0.4300 |                  36.00 |                 190.00
 KXUSAEXPANDTERRITORY-26JUL01 |          0.0800 |        0.0900 |        0.0700 |                  40.00 |                 244.00
 KXUSAEXPANDTERRITORY-26MAR01 |          0.0250 |        0.0300 |        0.0200 |                 500.00 |                 500.00
 KXUSAEXPANDTERRITORY-27JAN01 |          0.1900 |        0.2000 |        0.1800 |                 195.00 |                 500.00
 KXUSAEXPANDTERRITORY-29JAN21 |          0.4600 |        0.4700 |        0.4500 |                 500.00 |                 500.00
```

### Kalshi markets with reference price but NO liquidity (dust filtered)

```sql
SELECT
    market_id,
    reference_price,
    band_vwap_ask,
    band_vwap_bid,
    band_liquidity_qty_ask,
    band_liquidity_qty_bid
FROM direct_exchanges_data.market_latest_data
WHERE exchange_id = 'KALSHI'
  AND reference_price IS NOT NULL
  AND band_liquidity_qty_ask IS NULL
ORDER BY updated_at DESC
LIMIT 5;
```

**Example output (reference price exists, liquidity NULL - orders filtered by dust filter):**
```
             market_id              | reference_price | band_vwap_ask | band_vwap_bid | band_liquidity_qty_ask | band_liquidity_qty_bid
------------------------------------+-----------------+---------------+---------------+------------------------+------------------------
 KXSWIFTKELCEWEDDINGLOCATION-30-RHO |          0.6350 |               |               |                        |
 KXNEXTISRAELPM-45JAN01-NBEN        |          0.4000 |               |               |                        |
 KXTRUMPPARDONS-29JAN21-BAR         |          0.5150 |               |               |                        |
 KXTRUMPPARDONS-29JAN21-BMEN        |          0.2150 |               |               |                        |
 KXTRUMPPARDONS-29JAN21-AMAS        |          0.2000 |               |               |                        |
```

**Note:** Reference prices are in 0-1 range (e.g., 0.4350 = 43.5 cents). Liquidity is NULL when orders within the band have quantity < 25 (dust filter).

### Polymarket markets WITH full band metrics

```sql
SELECT
    SUBSTRING(market_id, 1, 20) as market_id,
    reference_price,
    band_vwap_ask,
    band_vwap_bid,
    band_liquidity_qty_ask,
    band_liquidity_qty_bid
FROM direct_exchanges_data.market_latest_data
WHERE exchange_id = 'POLYMARKET'
  AND reference_price IS NOT NULL
  AND band_liquidity_qty_ask IS NOT NULL
ORDER BY band_liquidity_qty_ask DESC
LIMIT 5;
```

**Example output:**
```
      market_id       | reference_price | band_vwap_ask | band_vwap_bid | band_liquidity_qty_ask | band_liquidity_qty_bid
----------------------+-----------------+---------------+---------------+------------------------+------------------------
 10322611815556226725 |          0.9850 |        0.9900 |        0.9800 |                 500.00 |                 500.00
 73531337476119951825 |          0.0015 |        0.0034 |        0.0010 |                 500.00 |                 165.35
 87199964913122307208 |          0.0020 |        0.0045 |        0.0010 |                 500.00 |                  30.96
 62040465747133881043 |          0.0025 |        0.0048 |        0.0010 |                 500.00 |                  52.00
 21162084630798392805 |          0.0150 |        0.0200 |        0.0100 |                 500.00 |                 500.00
```

---

## Analytics

### Liquidity by exchange

```sql
SELECT
    exchange_id,
    COUNT(*) as markets,
    ROUND(AVG(band_liquidity_qty_ask), 2) as avg_ask_liq,
    ROUND(AVG(band_liquidity_qty_bid), 2) as avg_bid_liq,
    ROUND(AVG(band_vwap_ask - band_vwap_bid), 4) as avg_spread
FROM direct_exchanges_data.market_latest_data
WHERE reference_price IS NOT NULL
  AND updated_at > NOW() - INTERVAL '1 hour'
GROUP BY exchange_id;
```

### Top liquid markets

```sql
SELECT
    market_id,
    exchange_id,
    reference_price,
    COALESCE(band_liquidity_qty_ask, 0) + COALESCE(band_liquidity_qty_bid, 0) as total_liquidity,
    band_vwap_ask - band_vwap_bid as spread
FROM direct_exchanges_data.market_latest_data
WHERE reference_price IS NOT NULL
  AND band_liquidity_qty_ask IS NOT NULL
ORDER BY band_liquidity_qty_ask + band_liquidity_qty_bid DESC NULLS LAST
LIMIT 20;
```

---

## Troubleshooting

| Problem | Check | Fix |
|---------|-------|-----|
| No data flowing | `SELECT MAX(updated_at) FROM market_latest_data;` | Check service logs |
| Millions of rows | `SELECT outcome_side, COUNT(*) FROM market_latest_data GROUP BY 1;` | If NULLs exist, truncate table |
| All metrics NULL | Markets may have low liquidity or wide spreads | Check order_books table |
| Kalshi low coverage | Normal - Kalshi has smaller order sizes | Lower dust filter if needed |
| Kalshi prices > 1 | Price normalization broken | Check handlers.ts divides by 100 |

**Note on UNKNOWN values:** As of Feb 2026, UNKNOWN is no longer used. Kalshi emits dual YES/NO records per update, and Polymarket skips records on cache miss rather than writing UNKNOWN.

---

## Column Reference

| Column | Description |
|--------|-------------|
| `reference_price` | Mid-price from dust-filtered order book |
| `band_vwap_ask` | Volume-weighted avg price for asks within band |
| `band_vwap_bid` | Volume-weighted avg price for bids within band |
| `band_liquidity_qty_ask` | Total ask quantity within execution band |
| `band_liquidity_qty_bid` | Total bid quantity within execution band |
| `band_delta_used` | Band width used (default 0.01 = 1%) |
| `outcome_side` | YES or NO (UNKNOWN no longer used) |
