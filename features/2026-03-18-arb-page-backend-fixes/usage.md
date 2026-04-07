# Usage: Arbitrage Page Backend Fixes

How to verify and monitor the three arb scanner fixes.

---

## Configuration

**Table:** `direct_exchanges_data.arb_config`

| Config Key | Value | Description |
|------------|-------|-------------|
| `max_plausible_spread_pct` | `0.30` | Max gross spread % before rejecting as implausible |

To update:
```sql
UPDATE direct_exchanges_data.arb_config
SET config_value = '0.25'
WHERE config_key = 'max_plausible_spread_pct';
```

Config reloads automatically every 30 scanner cycles (~5 min).

---

## Verification Queries

### 1. Duplicate DIRECTs (Bug 4) — should be 0

```sql
SELECT canonical_market_id, COUNT(*) as cnt
FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE' AND arb_type = 'DIRECT'
GROUP BY canonical_market_id
HAVING COUNT(*) > 1;
```

### 2. Expired active arbs (Bug 6) — should be 0

```sql
SELECT COUNT(*) FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE' AND expires_at <= NOW();
```

### 3. Resolved legs (Bug 6) — should be 0

```sql
SELECT COUNT(*) FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE'
AND (leg1_vwap <= 0.01 OR leg1_vwap >= 0.99
  OR leg2_vwap <= 0.01 OR leg2_vwap >= 0.99);
```

### 4. Unrealistic spreads (Bug 7) — should be 0

```sql
SELECT COUNT(*) FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE' AND gross_spread_pct > 0.30;
```

### 5. Active arb summary

```sql
SELECT arb_type, COUNT(*) FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE' GROUP BY arb_type;
```

---

## Monitoring

### Scanner logs

Check the homepage-api container for scan summaries:

```bash
ssh root@8.216.43.26 "docker logs homepage-api 2>&1 | grep 'Arb scan complete' | tail -5"
```

**Key fields in log:**
- `arbsFound` — arbs generated this cycle
- `arbsDedupRemoved` — duplicates removed by dedup (should be 0 in steady state)
- `arbsExpired` — stale arbs expired this cycle

### Rejected arb warnings

Bad matches produce warn-level logs:

```bash
ssh root@8.216.43.26 "docker logs homepage-api 2>&1 | grep 'spread exceeds max' | tail -10"
```

These logs include `canonicalMarketId`, both leg identifiers, and the spread — useful for identifying bad market mappings.

---

## One-Time Cleanup

If duplicate DIRECTs accumulate (e.g. after a rollback), run:

```sql
WITH ranked AS (
  SELECT arb_id, canonical_market_id,
    ROW_NUMBER() OVER (PARTITION BY canonical_market_id ORDER BY gross_spread_pct DESC) AS rn
  FROM direct_exchanges_data.arb_opportunities
  WHERE status = 'ACTIVE' AND arb_type = 'DIRECT'
)
UPDATE direct_exchanges_data.arb_opportunities SET status = 'EXPIRED', expired_at = NOW()
WHERE arb_id IN (SELECT arb_id FROM ranked WHERE rn > 1);
```

---

## Troubleshooting

### Stale unrealistic spreads not expiring

Old arbs with >30% spread that were created before the fix won't be refreshed by the scanner (since it now rejects them). They expire via `expire_grace_sec` (902s) or `expire_long_grace_sec` (600s) once the scanner stops upserting them. Wait ~15 minutes after deploy.

### Duplicate DIRECTs reappearing

If new duplicates appear, it means the dedup logic isn't working. Check that the deployed code includes the `directBest` Map dedup block in `arbScanner.ts` (after line 279).

### Too many arbs filtered

If `max_plausible_spread_pct = 0.30` is too aggressive, increase it:
```sql
UPDATE direct_exchanges_data.arb_config SET config_value = '0.50' WHERE config_key = 'max_plausible_spread_pct';
```
