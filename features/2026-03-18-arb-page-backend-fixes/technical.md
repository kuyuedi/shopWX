# Arb Page Backend Fixes — Technical Details

## Changes

### Bug 4: Duplicate DIRECT Arbs (arbScanner.ts)

The YES/NO loop generates mirror DIRECT arbs for the same canonical_market_id (e.g., buy K_YES/sell P_YES and buy P_NO/sell K_NO). These have different upsert keys so both persist.

**Fix:** After generating all opportunities, dedup DIRECT arbs by `canonical_market_id + sorted exchange pair`, keeping only the one with the highest `gross_spread_pct`.

**One-time cleanup SQL** (run after deploy):
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

### Bug 6: Expired/Resolved Markets (arbScanner.ts)

Two new filters in both DIRECT and COMPLEMENT loops:
1. **Expiry check**: `if (leg.expires_at && leg.expires_at <= new Date()) continue;`
2. **Resolved check**: Skip legs where VWAP is <= 0.01 or >= 0.99 (market has effectively settled)

**Safety net in fetchArbsV7** (queries.ts): Added `(ao.expires_at IS NULL OR ao.expires_at > NOW())` to both data and count WHERE clauses.

### Bug 7: Unrealistic Spreads (arbScanner.ts)

New `max_plausible_spread_pct` config (default 0.30 / 30%). Arbs exceeding this threshold are logged as warnings and skipped.

**DB migration** (run after deploy):
```sql
INSERT INTO direct_exchanges_data.arb_config (config_key, config_value, description)
VALUES ('max_plausible_spread_pct', '0.30', 'Max gross spread % before rejecting as implausible (likely bad match)')
ON CONFLICT (config_key) DO NOTHING;
```

## Files Modified

| File | Changes |
|------|---------|
| `packages/homepage-api/src/services/arbScanner.ts` | Bug 4 dedup, Bug 6 expiry/resolved filters, Bug 7 max spread check |
| `packages/shared/src/db/queries.ts` | Bug 6 expiry safety net in `fetchArbsV7` WHERE clause |

## Verification SQL

```sql
-- Duplicate DIRECTs (should be 0)
SELECT canonical_market_id, COUNT(*) FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE' AND arb_type = 'DIRECT'
GROUP BY canonical_market_id HAVING COUNT(*) > 1;

-- Expired arbs (should be 0)
SELECT COUNT(*) FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE' AND expires_at <= NOW();

-- Unrealistic spreads (should be 0)
SELECT COUNT(*) FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE' AND gross_spread_pct > 0.30;

-- Resolved legs (should be 0)
SELECT COUNT(*) FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE'
AND (leg1_vwap <= 0.01 OR leg1_vwap >= 0.99 OR leg2_vwap <= 0.01 OR leg2_vwap >= 0.99);

-- Total active arb count
SELECT arb_type, COUNT(*) FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE' GROUP BY arb_type;
```
