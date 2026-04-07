# Feature: Arb Scanner — Profit %, APY & Liquidity Bug Fixes

**Status**: NEW
**Priority**: P0 (Urgent)
**Created**: 2026-03-16

---

## Summary

Three bug fixes for the arb scanner: misleading gross_spread_pct formula, absurd APY on short-term markets, and low-liquidity arbs cluttering the list.

**Execution order**: Bug 2C (DB config, 5 min) > Bug 2A (code + DB, 30 min) > Bug 2B (code, 20 min)

---

## Bug 2A: gross_spread_pct Produces Misleading Numbers

### Problem

The current formula `spread / askPrice` produces absurd percentages when the buy price is very low (1-2 cents). This is ROI, not arbitrage profit margin.

| Market | Buy Price | Sell Price | Current | Should Be |
|--------|-----------|-----------|---------|-----------|
| Bank of America / SpaceX IPO | 1.3¢ (Poly) | 87¢ (Kalshi) | 6,592% | 98.5% |
| JPMorgan / SpaceX IPO | 1.5¢ (Poly) | 86¢ (Kalshi) | 5,484% | 98.2% |
| Yariv Levin / Israel PM | 0.2¢ (Poly) | 8¢ (Kalshi) | 3,900% | 97.5% |
| Powell says Gold | 9¢ (Kalshi) | 87¢ (Poly) | 867% | 89.7% |

### Root Cause

File: `packages/homepage-api/src/services/arbScanner.ts`

```typescript
// Current (wrong):
const spreadPct = spread / askPrice;
// Example: (0.87 - 0.013) / 0.013 = 65.92 → 6592%
```

### Fix

**DIRECT arbs** (same-side buy/sell):
```typescript
// Old: spread / askPrice
// New: spread / Math.max(askPrice, bidPrice)
// Example: (0.87 - 0.013) / Math.max(0.013, 0.87) = 0.985 (98.5%)
```

**COMPLEMENT arbs** (complementary sides): No change needed — `spread / combinedCost` is already correct.

Also fix in `packages/homepage-api/src/routes/arb.ts` if gross_spread_pct is recalculated there.

### DB Historical Data Fix

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

### Acceptance Criteria

- [ ] All ACTIVE arb gross_spread_pct between 0 and 1.0 (0%-100%)
- [ ] No spread percentages over 100%
- [ ] API returned gross_spread_pct matches database values

---

## Bug 2B: Short-Term Market APY Shows Absurd Numbers

### Problem

APY annualizes short-term returns, producing meaningless numbers for markets expiring soon.

| Market | Profit% | Days to Expiry | Current APY | Problem |
|--------|---------|---------------|------------|---------|
| Powell says Gold | 89.7% | 3 days | 100,644% | Meaningless |
| Other short-term | ~5% | 7 days | ~260% | Misleading |

### Fix

Return `null` for APY when market expires within 14 days.

**If calculated in TypeScript:**
```typescript
let apy: number | null = null;
if (daysToExpiry >= 14) {
  apy = spreadPct * (365 / daysToExpiry);
}
```

**If calculated in SQL:**
```sql
CASE
  WHEN days_to_expiry >= 14 THEN
    gross_spread_pct * (365.0 / days_to_expiry)
  ELSE NULL
END AS apy
```

Frontend already handles `null` by displaying "—".

### Acceptance Criteria

- [ ] Markets expiring within 14 days have `apy: null` in API response
- [ ] Markets 14+ days out have APY calculated using corrected gross_spread_pct
- [ ] No APY values over 999%

---

## Bug 2C: Low-Liquidity Arbs Clog the List (DB Config Only)

### Problem

Current thresholds (`min_liquidity_usd = $2`, `min_executable_qty = 5`) allow non-executable arbs to dominate the list.

| Market | Buy-side Liquidity | Executable? |
|--------|--------------------|------------|
| Bank of America / SpaceX IPO | $1.18 (Poly) | No |
| JPMorgan / SpaceX IPO | $4.53 (Poly) | No |
| Yariv Levin / Israel PM | $1.00 (Poly) | No |

### Fix (No code deploy needed)

**Step 1**: Update arb_config:
```sql
UPDATE direct_exchanges_data.arb_config
SET config_value = '50', updated_at = NOW()
WHERE config_key = 'min_liquidity_usd';

UPDATE direct_exchanges_data.arb_config
SET config_value = '50', updated_at = NOW()
WHERE config_key = 'min_executable_qty';
```

**Step 2**: Expire existing low-liquidity arbs:
```sql
UPDATE direct_exchanges_data.arb_opportunities
SET status = 'EXPIRED', expired_at = NOW(), updated_at = NOW()
WHERE status = 'ACTIVE'
  AND (gross_profit < 50 OR executable_qty < 50);
```

Scanner auto-reloads config every ~5 minutes. No deploy needed.

### Acceptance Criteria

- [ ] arb_config: `min_liquidity_usd = 50`
- [ ] arb_config: `min_executable_qty = 50`
- [ ] All ACTIVE arbs have `gross_profit >= $50`
- [ ] No low-liquidity items in API response

---

## Final Verification Query

```sql
SELECT
  COUNT(*) as total_active,
  COUNT(*) FILTER (WHERE gross_spread_pct > 1.0) as spread_over_100pct,
  COUNT(*) FILTER (WHERE gross_profit < 50) as low_profit,
  AVG(gross_spread_pct) as avg_spread_pct,
  MAX(gross_spread_pct) as max_spread_pct
FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE';

-- Expected:
-- spread_over_100pct = 0
-- low_profit = 0
-- max_spread_pct < 1.0
```

---

## Configuration Changes

| Parameter | Old Value | New Value | Description |
|-----------|-----------|-----------|-------------|
| `min_liquidity_usd` | 2 | 50 | Min gross profit USD for arb |
| `min_executable_qty` | 5 | 50 | Min contracts on both legs |
| APY cutoff | none | 14 days | Markets under 14 days → apy = null |
