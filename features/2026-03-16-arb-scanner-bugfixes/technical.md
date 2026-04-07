# Technical: Arb Scanner Bug Fixes

Technical implementation details for the three arb scanner bug fixes.

---

## Files Modified

| File | Bug | Changes |
|------|-----|---------|
| `packages/homepage-api/src/services/arbScanner.ts` | 2A | Fix `gross_spread_pct` formula for DIRECT arbs (line 125) |
| `packages/homepage-api/src/routes/arb.ts` | 2A | Fix spread % in refresh endpoint (line 310) |
| `packages/shared/src/db/queries.ts` | 2B | APY null for <14 days in `fetchArbsV7` SQL (lines 1599-1602) |
| `arb_config` table | 2C | Update `min_liquidity_usd` and `min_executable_qty` to 50 |

---

## Bug 2A: Spread % Formula Fix

### Root Cause

DIRECT arbs computed `spreadPct = spread / askPrice` where `askPrice` is the buy (low) side. For penny markets (e.g., askPrice=0.01, bidPrice=0.03), this inflates spread to 200% instead of the correct 66%.

### Fix: arbScanner.ts (line 125)

```typescript
// Before:
const spreadPct = spread / askPrice;
// After:
const spreadPct = spread / Math.max(askPrice, bidPrice);
```

COMPLEMENT arbs already used `spread / combinedCost` — no change needed.

### Fix: arb.ts refresh endpoint (line 310)

```typescript
// Before:
gross_spread_pct: leg1Price > 0 ? spread / leg1Price : 0,
// After:
gross_spread_pct: arb.arb_type === 'DIRECT'
  ? (Math.max(leg1Price, leg2Price) > 0 ? spread / Math.max(leg1Price, leg2Price) : 0)
  : (leg1Price + leg2Price > 0 ? spread / (leg1Price + leg2Price) : 0),
```

### DB Migration (historical fix)

```sql
UPDATE direct_exchanges_data.arb_opportunities
SET gross_spread_pct = CASE
  WHEN arb_type = 'DIRECT' THEN
    gross_spread / GREATEST(leg1_vwap, leg2_vwap)
  WHEN arb_type = 'COMPLEMENT' THEN
    gross_spread / (leg1_vwap + leg2_vwap)
  END
WHERE status = 'ACTIVE'
  AND GREATEST(leg1_vwap, leg2_vwap) > 0;
```

---

## Bug 2B: APY Null for Short-Term Markets

### Root Cause

APY is computed in SQL in `fetchArbsV7` (`packages/shared/src/db/queries.ts` lines 1599-1602). Markets expiring in <14 days produce absurdly high APY values (e.g., 1000%+). The API layer (`arb.ts` line 85) just reads and rounds the DB value — no TypeScript computation.

### Fix: queries.ts (lines 1599-1602)

```sql
-- Before:
CASE
  WHEN ao.expires_at IS NULL OR ao.expires_at <= NOW() THEN NULL
  ELSE ao.gross_spread_pct * 365.0 / GREATEST(EXTRACT(EPOCH FROM (ao.expires_at - NOW())) / 86400.0, 1)
END AS apy

-- After:
CASE
  WHEN ao.expires_at IS NULL OR ao.expires_at <= NOW() THEN NULL
  WHEN EXTRACT(EPOCH FROM (ao.expires_at - NOW())) / 86400.0 < 14 THEN NULL
  ELSE ao.gross_spread_pct * 365.0 / GREATEST(EXTRACT(EPOCH FROM (ao.expires_at - NOW())) / 86400.0, 1)
END AS apy
```

---

## Bug 2C: Liquidity Thresholds (DB Only)

### Config Changes

```sql
UPDATE direct_exchanges_data.arb_config
SET config_value = '50', updated_at = NOW()
WHERE config_key = 'min_liquidity_usd';

UPDATE direct_exchanges_data.arb_config
SET config_value = '50', updated_at = NOW()
WHERE config_key = 'min_executable_qty';
```

### Cleanup Existing Low-Liquidity Arbs

```sql
UPDATE direct_exchanges_data.arb_opportunities
SET status = 'EXPIRED', expired_at = NOW(), updated_at = NOW()
WHERE status = 'ACTIVE'
  AND (gross_profit < 50 OR executable_qty < 50);
```

No code deploy needed — scanner reloads config every ~5 minutes (30 cycles × 10s).

---

## Data Flow

```
Bug 2C (DB config)          Bug 2A (code)              Bug 2B (code)
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ arb_config table │    │ arbScanner.ts    │    │ queries.ts SQL   │
│ min_liquidity=50 │    │ spreadPct fix    │    │ APY null < 14d   │
│ min_exec_qty=50  │    │ + arb.ts fix     │    │                  │
└────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘
         │                       │                       │
         └───────────┬───────────┘───────────────────────┘
                     ▼
           ┌──────────────────┐
           │  arb_opportunities│
           │  (clean data)     │
           └────────┬─────────┘
                    ▼
           ┌──────────────────┐
           │  GET /api/v1/arb │
           │  (correct values)│
           └──────────────────┘
```

---

## Deployment Order

| Step | Bug | Action | Deploy? |
|------|-----|--------|---------|
| 1 | 2C | Run SQL to update arb_config + expire low-liquidity arbs | No |
| 2 | 2A | Modify arbScanner.ts + arb.ts spread formula | Yes |
| 3 | 2B | Modify queries.ts APY calculation to null for <14 days | Yes |
| 4 | All | Deploy homepage-api | Yes |
| 5 | 2A | Run SQL to fix historical gross_spread_pct | No |
| 6 | All | Run final verification query | No |

---

## Rollback Plan

```sql
-- Rollback Bug 2C config
UPDATE direct_exchanges_data.arb_config
SET config_value = '2', updated_at = NOW()
WHERE config_key = 'min_liquidity_usd';

UPDATE direct_exchanges_data.arb_config
SET config_value = '5', updated_at = NOW()
WHERE config_key = 'min_executable_qty';
```

Bug 2A/2B rollback: revert git commit and redeploy.

---

## Performance Considerations

- Bug 2C config change takes effect within ~5 minutes (scanner config reload cycle)
- Bug 2A DB UPDATE only affects ACTIVE rows (typically ~200-300), runs in <1 second
- No new indexes needed
- No additional query complexity — formulas are computed inline in the scanner loop
