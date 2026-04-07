# Usage: Arb Scanner Bug Fixes

How to verify the arb scanner bug fixes.

---

## Deployed Results (2026-03-16)

All three fixes deployed and verified in production.

### Before vs After

| Metric | Before | After |
|--------|--------|-------|
| Active arb count | ~270 | ~31 |
| Max DIRECT spread % | 6000%+ (penny markets) | 96.1% |
| Low-profit arbs (<$50) | ~259 | 0 |
| Low-qty arbs (<50 contracts) | many | 0 |
| APY for <14-day markets | absurd (1000%+) | `null` |

### Bug 2A — Spread % (PASS)

No DIRECT arb has >100% spread. Max DIRECT spread is 96.1%. Note: COMPLEMENT arbs can legitimately exceed 100% when both legs are cheap (e.g., buy both sides for $0.185, resolve to $1.00 = 440% return).

### Bug 2B — APY Guard (PASS)

Markets with <14 days to expiry return `apy: null`. Markets with >=14 days show normal APY values (e.g., 44 days to expiry = 6.49 APY).

### Bug 2C — Liquidity Thresholds (PASS)

Config updated to `min_liquidity_usd = 50`, `min_executable_qty = 50`. 259 existing low-liquidity arbs expired on deploy. Minimum profit in active arbs: $53.56. Minimum qty: 65.56.

### Arb Monitor History

Arb count trend after deploy: 273 → 27 → 30 → 35 → 31. Stabilized around 30-35 high-quality arbs.

---

## Verification Queries

### 1. Check arb_config values (Bug 2C)

```sql
SELECT config_key, config_value, updated_at
FROM direct_exchanges_data.arb_config
WHERE config_key IN ('min_liquidity_usd', 'min_executable_qty');
```

**Expected:**
- `min_liquidity_usd = 50`
- `min_executable_qty = 50`

### 2. Check no spread > 100% (Bug 2A)

```sql
SELECT COUNT(*) FILTER (WHERE gross_spread_pct > 1.0) as over_100pct,
       MAX(gross_spread_pct) as max_spread_pct,
       AVG(gross_spread_pct) as avg_spread_pct
FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE';
```

**Expected:** `over_100pct = 0` for DIRECT arbs. COMPLEMENT arbs can legitimately exceed 100% when both legs are cheap.

### 3. Check no low-liquidity arbs (Bug 2C)

```sql
SELECT COUNT(*) FILTER (WHERE gross_profit < 50) as low_profit,
       COUNT(*) FILTER (WHERE executable_qty < 50) as low_qty
FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE';
```

**Expected:** Both = 0

### 4. Check APY null for short-term markets (Bug 2B)

After deploy, query the API and verify markets with <14 days to expiry return `apy: null`:

```bash
curl -s "https://marketsapi.17b.com/api/v1/arb?limit=20" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for a in d['arbs']:
    days = a.get('days_to_expiry')
    apy = a.get('apy')
    if days and days < 14 and apy is not None:
        print(f'BUG: {a[\"market_title\"][:40]} days={days} apy={apy}')
print('APY check complete')
"
```

### 5. Full verification (all bugs)

```sql
SELECT
  COUNT(*) as total_active,
  COUNT(*) FILTER (WHERE gross_spread_pct > 1.0) as spread_over_100pct,
  COUNT(*) FILTER (WHERE gross_profit < 50) as low_profit,
  COUNT(*) FILTER (WHERE executable_qty < 50) as low_qty,
  AVG(gross_spread_pct) as avg_spread_pct,
  MAX(gross_spread_pct) as max_spread_pct
FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE';
```

**Expected:**
- `spread_over_100pct = 0` for DIRECT arbs (COMPLEMENT can legitimately exceed 100%)
- `low_profit = 0`
- `low_qty = 0`

---

## API Testing

### Check arb list has correct values

```bash
curl -s "https://marketsapi.17b.com/api/v1/arb?limit=5" | python3 -m json.tool
```

**Verify:**
- `gross_spread_pct` values are between 0 and 1.0
- Short-term markets (< 14 days to expiry) have `apy: null`
- No arbs with very low liquidity

### Check specific arb spread

```bash
curl -s "https://marketsapi.17b.com/api/v1/arb?limit=10" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for a in d['arbs']:
    print(f\"{a['market_title'][:40]:40s} spread_pct={a['gross_spread_pct']:.4f} apy={a.get('apy')} days={a.get('days_to_expiry')}\")
"
```

---

## Troubleshooting

### Arbs still showing > 100% spread after fix

The scanner runs every 10 seconds. Wait for a full cycle and check again. If persists, verify the code change was deployed:

```bash
ssh root@8.216.43.26 "docker compose -f /opt/prediction-market-ingestion/docker-compose.yml logs --tail 5 homepage-api"
```

### Config not taking effect

Scanner reloads config every ~5 minutes (30 cycles x 10s). Force restart if urgent:

```bash
ssh root@8.216.43.26 "cd /opt/prediction-market-ingestion && docker compose restart homepage-api"
```
