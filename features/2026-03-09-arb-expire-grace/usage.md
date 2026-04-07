# Usage: Arb Expire Grace Period

How to use and verify this fix.

---

## Database Table

**Table:** `direct_exchanges_data.arb_opportunities`

### New Column

| Column | Type | Description |
|--------|------|-------------|
| `last_checked_at` | TIMESTAMPTZ | When scanner last confirmed this arb exists (set every cycle) |

### Config

**Table:** `direct_exchanges_data.arb_config`

| Key | Value | Description |
|-----|-------|-------------|
| `expire_grace_sec` | `30` | Seconds without refresh before an arb expires |

---

## Verification Queries

### 1. Stability check — run every 10s for 2 minutes

```sql
SELECT COUNT(*) AS active_count,
       MIN(last_checked_at) AS oldest_check,
       MAX(last_checked_at) AS newest_check,
       EXTRACT(EPOCH FROM MAX(last_checked_at) - MIN(last_checked_at)) AS check_range_sec
FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE';
```

**Expected:**
- `active_count` should be stable (±2-3 between runs, NOT ±20-30)
- `check_range_sec` should be small (<15s)
- `oldest_check` should never be more than `expire_grace_sec` old

### 2. Verify timestamps are separated correctly

```sql
SELECT arb_id,
       LEFT(market_title, 50) as title,
       gross_spread_pct,
       last_checked_at,
       updated_at,
       EXTRACT(EPOCH FROM last_checked_at - updated_at) AS check_vs_update_gap_sec
FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE'
ORDER BY check_vs_update_gap_sec DESC
LIMIT 10;
```

**Expected:** Rows where `last_checked_at > updated_at` — meaning the arb was checked recently but metrics didn't change, so `updated_at` was NOT bumped. This confirms the conditional update is working.

### 3. Verify config is loaded

```sql
SELECT * FROM direct_exchanges_data.arb_config
WHERE config_key = 'expire_grace_sec';
```

**Expected:** One row with `config_value = '30'`.

---

## Statistics Queries

### Arb lifecycle stats

```sql
SELECT
    status,
    COUNT(*) as count,
    AVG(EXTRACT(EPOCH FROM COALESCE(expired_at, NOW()) - detected_at)) as avg_lifetime_sec
FROM direct_exchanges_data.arb_opportunities
GROUP BY status
ORDER BY status;
```

### Recent expire activity

```sql
SELECT
    date_trunc('minute', expired_at) as minute,
    COUNT(*) as expired_count
FROM direct_exchanges_data.arb_opportunities
WHERE expired_at > NOW() - INTERVAL '10 minutes'
GROUP BY 1
ORDER BY 1 DESC;
```

**Expected:** Steady, low expire counts per minute — not spikes of 20-30 every cycle.

---

## Example Output

### Before fix (flickering)

```
time     | active_count
10:00:00 | 40
10:00:10 | 12    ← mass expire
10:00:20 | 38    ← re-detected
10:00:30 |  8    ← mass expire again
10:00:40 | 35
```

### After fix (stable)

```
time     | active_count
10:00:00 | 38
10:00:10 | 37
10:00:20 | 39
10:00:30 | 38
10:00:40 | 38
```

---

## Tuning

To adjust the grace period at runtime (no redeploy needed):

```sql
UPDATE direct_exchanges_data.arb_config
SET config_value = '45', updated_at = NOW()
WHERE config_key = 'expire_grace_sec';
```

Takes effect within ~5 minutes (next config reload cycle). Lower values = faster expire but more flickering risk. Higher values = more stable but stale arbs linger longer.

---

## Troubleshooting

### Count still flickering after deploy

**Check 1:** Verify `last_checked_at` column exists and is being set:
```sql
SELECT arb_id, last_checked_at, updated_at
FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE'
ORDER BY last_checked_at DESC
LIMIT 5;
```
If `last_checked_at` is NULL or identical to `updated_at` for all rows, the code change may not be deployed.

**Check 2:** Verify the expire query is using `last_checked_at`:
Check homepage-api logs for the `expireStaleArbs` call — it should log `expireGraceSec` not `scanTimestamp`.

### Arbs never expire (count only grows)

The `expire_grace_sec` may be too high, or `last_checked_at` is always being updated even for arbs that shouldn't exist. Check that `fetchMatchedMarketLegs` is still filtering properly.

### `updated_at` never changes

This is expected if metrics (spread, qty) are stable. The frontend should use `updated_at` for flash animations — no change means no flash, which is correct behavior.
