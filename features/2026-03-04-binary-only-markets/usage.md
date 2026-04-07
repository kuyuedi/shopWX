# Usage: Binary-Only Polymarket Market Ingestion

How to use and verify this feature.

---

## Affected Tables

**Tables:** `direct_exchanges_data.prediction_markets`, `direct_exchanges_data.market_latest_data`, `direct_exchanges_data.events`

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| outcome_side | VARCHAR | 'YES' or 'NO' — should always have both for each market_id |
| market_count | INTEGER | On events table — now reflects only binary markets for Polymarket |

---

## Verification Queries

### 1. Verify balanced outcome sides

```sql
SELECT outcome_side, COUNT(*)
FROM direct_exchanges_data.prediction_markets
WHERE exchange_id = 'POLYMARKET'
GROUP BY outcome_side;
```

**Expected:** Equal YES and NO counts.

### 2. Verify no NO-only markets remain

```sql
SELECT market_id, COUNT(*) as sides
FROM direct_exchanges_data.prediction_markets
WHERE exchange_id = 'POLYMARKET'
GROUP BY market_id
HAVING COUNT(DISTINCT outcome_side) = 1
  AND MAX(outcome_side) = 'NO';
```

**Expected:** 0 rows.

### 3. Verify 0-market events exist (non-binary events)

```sql
SELECT COUNT(*) as zero_market_events
FROM direct_exchanges_data.events
WHERE exchange_id = 'POLYMARKET'
  AND status = 'Open'
  AND market_count = 0;
```

**Expected:** ~3,000+ events (these are non-binary-only events correctly marked as having 0 binary markets).

---

## Statistics Queries

### Market counts by exchange and outcome side

```sql
SELECT exchange_id, outcome_side, COUNT(*) as markets
FROM direct_exchanges_data.prediction_markets
WHERE status = 'Open'
GROUP BY exchange_id, outcome_side
ORDER BY exchange_id, outcome_side;
```

### Event market_count distribution for Polymarket

```sql
SELECT
    CASE
      WHEN market_count = 0 THEN '0 (non-binary only)'
      WHEN market_count = 1 THEN '1'
      WHEN market_count BETWEEN 2 AND 5 THEN '2-5'
      WHEN market_count BETWEEN 6 AND 20 THEN '6-20'
      ELSE '21+'
    END as market_count_bucket,
    COUNT(*) as events
FROM direct_exchanges_data.events
WHERE exchange_id = 'POLYMARKET' AND status = 'Open'
GROUP BY 1
ORDER BY 1;
```

### Event matcher filter effectiveness

Check event-matcher logs for:
```
polyEventsSkippedNoBinaryMarkets
```

---

## Example Output

### Balanced market counts

```
 outcome_side | count
--------------+-------
 NO           | 22028
 YES          | 22028
```

### Interpretation

- **Equal YES/NO counts**: All Polymarket markets are binary — the filter is working correctly
- **market_count = 0 events**: These are events containing only non-binary markets (e.g. multi-outcome sports, multi-choice politics). They are correctly ingested as events but have no markets in our system
- **polyEventsSkippedNoBinaryMarkets in logs**: Shows how many Poly events the matcher skips each cycle, saving AI API calls

---

## Troubleshooting

### Unequal YES/NO counts after deployment

The DB cleanup may not have run, or new non-binary data was ingested before the code was deployed. Re-run the cleanup SQL from requirements.md.

### market_count still shows old values

The polymarket-listener rewrites `market_count` on every sync cycle (every 5 min). Wait for one cycle to complete. Check logs for `Synced all markets to database`.

### Event matcher still processing 0-market events

Verify the event-matcher container was redeployed with the latest code. Check logs for `polyEventsSkippedNoBinaryMarkets` — if absent, the old code is still running.
