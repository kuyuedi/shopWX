# Feature: Arbitrage Page — Backend Fixes (3 Bugs)

**Status**: DEPLOYED
**Priority**: P0
**Created**: 2026-03-18

---

## Summary

Fix 3 backend issues causing the arbitrage page to display phantom arbs, duplicate entries, and expired markets.

---

## Problem

The arbitrage page at markets.17b.com/arbitrage shows unreliable data due to three backend issues:

1. **Duplicate DIRECT arbs** — Each market appears as 2 DIRECT cards (YES-side and NO-side) that are economically identical trades. 50 cards on the page represent only ~17 unique markets.
2. **Expired/resolved markets** — 7 arbs show markets that expire today or have already resolved on one exchange (e.g., Polymarket shows 0¢ or 100¢).
3. **Unrealistic spreads from bad matches** — Arbs with 40–96¢ spreads appear because the arb scanner trusts `market_mappings` without validating that the price gap is plausible.

---

## Solution

Three changes to the arb scanner and/or API query layer.

| Bug | Fix | Location |
|-----|-----|----------|
| Bug 4: Duplicate DIRECTs | Dedup DIRECT arbs per canonical_market_id, keep highest spread | `arbScanner.ts` or `fetchArbsV7` query |
| Bug 6: Expired markets | Filter `expires_at > NOW()` and exclude 0¢/100¢ legs | `fetchArbsV7` query |
| Bug 7: Unrealistic spreads | Add max spread filter, reject arbs above 30% | `arbScanner.ts` |

---

## Bug 4: Duplicate DIRECT Arbs (YES + NO Sides)

### Problem

The arb scanner creates 3 entries per market: 1 COMPLEMENT + 2 DIRECT. The two DIRECT entries are economically identical — same exchange direction, same cost, same profit — just expressed on opposite outcome sides.

### Why They Are the Same Trade

Example — Powell Gold (Kalshi YES = 8¢, Polymarket YES = 92¢):

| Card | Trade | Cost | Revenue | Profit |
|------|-------|------|---------|--------|
| DIRECT #1 | Buy K YES at 8¢, Sell P YES at 92¢ | 8¢ | 92¢ | **84¢** |
| DIRECT #2 | Buy P NO at 8¢, Sell K NO at 92¢ | 8¢ | 92¢ | **84¢** |

Same exchange, same direction, same profit. One uses YES contracts, the other NO. The user gains nothing from seeing both.

### Why COMPLEMENT vs DIRECT Should Both Stay

| Type | Mechanics | Risk |
|------|-----------|------|
| COMPLEMENT | Buy YES + Buy NO, hold until resolution | Capital locked until expiry |
| DIRECT | Buy low, Sell high | Profit locked immediately |

These are genuinely different strategies. Keep both.

### Fix

In `arbScanner.ts` or the `fetchArbsV7` API query:

```sql
-- Option A: Dedup in the API query
-- For each canonical_market_id + arb_type = 'DIRECT',
-- keep only the row with the highest gross_spread_pct
WITH ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY canonical_market_id, arb_type
      ORDER BY gross_spread_pct DESC
    ) AS rn
  FROM direct_exchanges_data.arb_opportunities
  WHERE is_active = true
)
SELECT * FROM ranked WHERE rn = 1
```

```typescript
// Option B: Dedup in arbScanner.ts before writing
// When creating DIRECT arbs for a market pair,
// only write the side with the higher spread.
// Compare YES-side and NO-side spread, keep the better one.
```

### Acceptance Criteria

- [x] Each market shows at most 2 arb cards: 1 COMPLEMENT + 1 DIRECT
- [x] The DIRECT card shown is the one with the higher spread
- [x] Total card count drops from ~50 to ~34
- [x] COMPLEMENT and DIRECT are never merged

---

## Bug 6: Expired/Resolved Markets Still Showing

### Problem

7 arbs in the current response have `expires_at = 2026-03-18` (today) or `days_to_expiry = null`. Some have already resolved on one exchange — Polymarket shows 0¢ or 100¢ while Kalshi still shows an active price.

### Evidence

| Market | Expires | Days | Poly Price | Status |
|--------|---------|------|------------|--------|
| Powell Pardon | 2026-03-18 | null | NO @ 0¢ | Already resolved on Poly |
| Liverpool vs Galatasaray | 2026-03-18 | null | active | Match already played |
| Bahia vs Bragantino | 2026-03-18 | null | active | Match already played |
| Pasto vs Boyaca Chico | 2026-03-18 | 0 | active | Expiring today |

### Fix

Add filters to `fetchArbsV7` or the arb scanner expiry logic:

```sql
-- Filter 1: Exclude expired arbs
WHERE expires_at > NOW()

-- Filter 2: Exclude resolved legs (price = 0 or 100)
AND NOT EXISTS (
  SELECT 1 FROM arb_legs al
  WHERE al.arb_id = ao.arb_id
  AND (al.price_cents <= 0 OR al.price_cents >= 100)
)
```

```typescript
// In arbScanner.ts, when evaluating legs:
if (legPrice <= 0 || legPrice >= 100) {
  // Skip — market has resolved on this exchange
  continue;
}
```

### Acceptance Criteria

- [x] No arbs with `expires_at <= NOW()` appear in API response
- [x] No arbs with any leg at 0¢ or 100¢ appear (resolved markets)
- [x] `days_to_expiry = null` arbs are excluded

---

## Bug 7: Unrealistic Spreads from Bad Matches

### Problem

Arbs with 40–96¢ spreads appear on the page. These are not real arbitrage opportunities — a 77¢ gap on a known topic would be arbitraged instantly by real traders. They exist because the arb scanner trusts `market_mappings` at confidence 1.0 without validating that the resulting price gap is plausible.

### Evidence — Current Arbs with Unrealistic Spreads

| Market | K Price | P Price | Gap | Likely Cause |
|--------|---------|---------|-----|-------------|
| Powell Pardon (DIRECT) | NO 96¢ | NO 0¢ | 96¢ | Poly already resolved |
| Bank of America / SpaceX IPO | YES 83¢ | YES 6¢ | 77¢ | Bad match or stale Poly |
| Rangers vs Aberdeen — TIE | YES 17¢ | YES 77¢ | 60¢ | Bad match — different TIE definitions? |
| Drake Iceman album | YES 53¢ | YES 6¢ | 47¢ | Bad match or stale Poly |

All have `mapping_confidence = 1` (substring matcher, no AI verification). A real arb is typically 1–5%. Anything above 15–20% on any market is almost certainly:
1. A bad match (different resolution criteria)
2. A stale price on a thin market
3. An already-resolved market

### Fix

Add a maximum spread filter in `arbScanner.ts`:

```typescript
// After calculating spread, reject implausible arbs
const MAX_PLAUSIBLE_SPREAD_PCT = 0.30; // 30%

if (spreadPct > MAX_PLAUSIBLE_SPREAD_PCT) {
  logger.warn({
    kalshiMarket: kalshiLeg.market_id,
    polyMarket: polyLeg.market_id,
    spreadPct,
    kalshiPrice: kalshiLeg.price,
    polyPrice: polyLeg.price,
  }, 'Arb rejected: spread exceeds maximum plausible threshold — likely bad match');
  continue;
}
```

### Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `max_plausible_spread_pct` | Maximum gross spread before flagging as implausible | `0.30` (30%) |

Add to `arb_config` table so it can be tuned without redeployment.

### Important: Log Rejected Arbs for Match Quality

These rejected arbs are a valuable signal for improving the matching engine. When an arb is rejected due to `spreadPct > MAX_PLAUSIBLE_SPREAD_PCT`, log:
- Both market IDs
- Both prices
- The `canonical_market_id` from `market_mappings`
- The `model_id` that created the match

This log can be reviewed periodically to find and fix bad matches in `market_mappings`.

### Acceptance Criteria

- [x] No arbs with gross_spread_pct > 30% appear in API response
- [x] Rejected arbs are logged with both market IDs and prices for match review
- [x] `max_plausible_spread_pct` is configurable in `arb_config` table
- [x] Bank of America/SpaceX (77¢ gap) no longer appears as an arb

---

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| Legitimate large spread (new market, one exchange just listed) | Filtered by max spread — acceptable false positive, will appear once spread normalizes |
| Market expires in < 1 hour | Filtered by `expires_at > NOW()` |
| Both DIRECT sides have identical spread | Keep either one (arbitrary, both are the same trade) |
| COMPLEMENT arb has spread > 30% | Also filtered — if the complement is implausible, so is the arb |
| Market resolves on Poly (100¢) but Kalshi still shows 95¢ | Filtered by 100¢ leg detection |

---

## Verification Queries

```sql
-- 1. Check for duplicate DIRECTs (should be 0 after fix)
SELECT canonical_market_id, arb_type, COUNT(*) as cnt
FROM direct_exchanges_data.arb_opportunities
WHERE is_active = true AND arb_type = 'DIRECT'
GROUP BY canonical_market_id, arb_type
HAVING COUNT(*) > 1;

-- 2. Check for expired arbs (should be 0 after fix)
SELECT COUNT(*) as expired_arbs
FROM direct_exchanges_data.arb_opportunities
WHERE is_active = true AND expires_at <= NOW();

-- 3. Check for unrealistic spreads (should be 0 after fix)
SELECT COUNT(*) as implausible_arbs
FROM direct_exchanges_data.arb_opportunities
WHERE is_active = true AND gross_spread_pct > 0.30;

-- 4. Check for 0/100 price legs (should be 0 after fix)
SELECT ao.arb_id, ao.market_title, al.price_cents
FROM direct_exchanges_data.arb_opportunities ao
JOIN direct_exchanges_data.arb_legs al ON ao.arb_id = al.arb_id
WHERE ao.is_active = true
AND (al.price_cents <= 0 OR al.price_cents >= 100);
```

---

## Notes

- Bug 4 dedup is recommended at the scanner level (Option B) so the DB stays clean, but can also be done at the API query level (Option A) for a faster fix.
- Bug 7's `max_plausible_spread_pct = 0.30` is conservative. Real arbs are almost always under 5%. The 30% threshold catches only the most egregious cases. Can be tightened later.
- The rejected arb logs from Bug 7 should feed back into matching quality reviews — see `features/2026-03-16-matching-investigation-fixes/` for the related matching fixes.
- Frontend bugs (profit % calculation, APY display) are tracked separately in the frontend PRD.
