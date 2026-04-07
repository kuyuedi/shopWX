# Usage: Use Gamma Market ID for Polymarket market_id

How to use and verify this feature.

---

## Database Tables Affected

**Tables:** `prediction_markets`, `market_latest_data`, `order_books`, `trades`

### Key Change

| Field | Before | After |
|-------|--------|-------|
| `market_id` (Polymarket) | `96826264265703...` (76-char clobTokenId) | `517310` (Gamma numeric ID) |
| `source_specific_data.token_id` | N/A | Original clobTokenId preserved here |

---

## Verification Queries

### 1. Confirm all Polymarket market_ids are Gamma IDs

```sql
SELECT
  CASE WHEN LENGTH(market_id) > 20 THEN 'clobTokenId (old)' ELSE 'Gamma ID (new)' END as id_type,
  COUNT(*) as count
FROM direct_exchanges_data.prediction_markets
WHERE exchange_id = 'POLYMARKET'
GROUP BY 1;
```

**Expected:** Only `Gamma ID (new)` rows, zero `clobTokenId (old)`.

### 2. Confirm YES/NO share the same market_id

```sql
SELECT market_id, COUNT(DISTINCT outcome_side) as sides
FROM direct_exchanges_data.prediction_markets
WHERE exchange_id = 'POLYMARKET' AND status = 'Open'
GROUP BY market_id HAVING COUNT(DISTINCT outcome_side) = 2
LIMIT 10;
```

**Expected:** Multiple rows with `sides = 2`.

### 3. Confirm clobTokenId preserved in source_specific_data

```sql
SELECT market_id, outcome_side, source_specific_data::jsonb->>'token_id' as token_id
FROM direct_exchanges_data.prediction_markets
WHERE exchange_id = 'POLYMARKET' AND status = 'Open'
LIMIT 5;
```

**Expected:** `token_id` shows the original 76-char clobTokenId.

### 4. Check market_latest_data is clean

```sql
SELECT
  CASE WHEN LENGTH(market_id) > 20 THEN 'clobTokenId (old)' ELSE 'Gamma ID (new)' END as id_type,
  COUNT(*) as count
FROM direct_exchanges_data.market_latest_data
WHERE exchange_id = 'POLYMARKET'
GROUP BY 1;
```

**Expected:** Only `Gamma ID (new)` rows.

### 5. Check recent trades use Gamma ID

```sql
SELECT
  CASE WHEN LENGTH(market_id) > 20 THEN 'clobTokenId (old)' ELSE 'Gamma ID (new)' END as id_type,
  COUNT(*) as count
FROM direct_exchanges_data.trades
WHERE exchange_id = 'POLYMARKET'
  AND created_at > NOW() - INTERVAL '10 minutes'
GROUP BY 1;
```

**Expected:** Only `Gamma ID (new)` rows.

---

## Statistics Queries

### YES/NO pairing distribution

```sql
SELECT sides, COUNT(*) as market_count
FROM (
  SELECT market_id, COUNT(DISTINCT outcome_side) as sides
  FROM direct_exchanges_data.prediction_markets
  WHERE exchange_id = 'POLYMARKET' AND status = 'Open'
  GROUP BY market_id
) sub
GROUP BY sides ORDER BY sides;
```

### Compare Polymarket vs Kalshi market_id patterns

```sql
SELECT
  exchange_id,
  AVG(LENGTH(market_id)) as avg_id_length,
  MIN(LENGTH(market_id)) as min_id_length,
  MAX(LENGTH(market_id)) as max_id_length,
  COUNT(*) as total_rows
FROM direct_exchanges_data.prediction_markets
WHERE status = 'Open'
GROUP BY exchange_id;
```

---

## Example Output

### Sample prediction_markets row

```
market_id:            517310
outcome_side:         YES
title:                Will Trump deport less than 250,000?
category:             Politics
source_specific_data: {"condition_id":"0x...","volume":1234,"liquidity":5678,"token_id":"10167699736368719972..."}
```

### Interpretation

- **market_id = 517310**: Gamma's numeric market ID, shared by YES and NO rows
- **source_specific_data.token_id**: Original clobTokenId, can be used to look up on Polymarket CLOB API if needed
- **outcome_side = YES/NO**: Distinguishes the two sides (same as Kalshi pattern)

---

## Troubleshooting

### Old clobTokenId rows reappear

This shouldn't happen since the code now writes Gamma IDs. If it does, check:
1. Is the latest code deployed? (`git log --oneline -1` on server should show `3b83fbc`)
2. Is the conditionId cache being populated? Check logs for `Updated conditionId` message

### WebSocket writes falling back to clobTokenId

If `market_id` in `order_books` or `trades` is a long hash, it means the conditionId cache missed. Check:
1. Logs for `Cache miss` warnings
2. Whether `syncMarkets()` ran successfully (populates the cache)
3. The cache is populated before WebSocket connections start (it is -- sync runs first on startup)

### Trade counts showing 0

Expected for up to 24h after migration. Historical trades still reference clobTokenId. New trades accumulate with Gamma ID. The `getTradeCounts24h()` query will show counts once enough new trades exist.
