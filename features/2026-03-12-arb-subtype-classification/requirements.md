# Feature: Arb Sub-Type Classification

**Status**: DEPLOYED
**Priority**: High
**Created**: 2026-03-12

---

## Summary

Classify each arb opportunity into a sub-type (CROSS_PLATFORM, TIME_DECAY, LIQUIDITY_GAP) and track spread direction for the v7 Arb Page UI.

---

## Problem

The current arb scanner only distinguishes DIRECT vs COMPLEMENT arb types. The v7 Arb Page needs finer-grained sub-type tabs (Cross-Platform, Time Decay, Liquidity Gap) with per-tab counts, and a spread direction indicator (up/down/flat) showing whether the spread is widening or narrowing. Neither field exists in the database today.

---

## Solution

1. Add `arb_subtype` and `prev_gross_spread_pct` columns to the `arb_opportunities` table.
2. Classify each arb during the scanner's upsert cycle based on arb_type, expiry proximity, and depth.
3. Compute spread direction by comparing `gross_spread_pct` to `prev_gross_spread_pct`.
4. Backfill existing rows with appropriate sub-types.

---

## Algorithm / Logic

### Sub-Type Classification

Run during the scanner's opportunity detection, before upsert:

```
IF arb_type = 'DIRECT':
  arb_subtype = 'LIQUIDITY_GAP'
  subtype_note = 'Same-side price discrepancy across exchanges'

ELSE IF arb_type = 'COMPLEMENT':
  IF expires_at IS NOT NULL
     AND expires_at - NOW() <= 14 days
     AND expires_at > NOW():
    arb_subtype = 'TIME_DECAY'
    subtype_note = 'Complement arb expiring within 14 days — spread may compress as expiry approaches'
  ELSE:
    arb_subtype = 'CROSS_PLATFORM'
    subtype_note = NULL
```

### Spread Direction

Computed during upsert by comparing the new `gross_spread_pct` to the stored `prev_gross_spread_pct`:

```
-- In the upsert ON CONFLICT clause:
prev_gross_spread_pct = EXCLUDED.gross_spread_pct   -- save current as "previous" for next cycle

-- At query time (API layer):
IF prev_gross_spread_pct IS NULL:
  spread_direction = 'flat'
ELSE IF gross_spread_pct > prev_gross_spread_pct:
  spread_direction = 'up'
ELSE IF gross_spread_pct < prev_gross_spread_pct:
  spread_direction = 'down'
ELSE:
  spread_direction = 'flat'
```

Note: `spread_direction` is derived at query time, not stored. The DB only stores `prev_gross_spread_pct` to enable the comparison.

---

## Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `time_decay_threshold_days` | Max days-to-expiry to classify as TIME_DECAY | `14` |

This can be added to the existing `arb_config` table. Hardcoded initially is fine.

---

## Input Data

| Source | Table | Fields Used |
|--------|-------|-------------|
| Arb scanner output | (in-memory) | `arb_type`, `expires_at` |
| Existing arb row | `arb_opportunities` | `gross_spread_pct` (becomes prev) |

---

## Output Data

### DB Migration

```sql
ALTER TABLE direct_exchanges_data.arb_opportunities
  ADD COLUMN arb_subtype VARCHAR(20),
  ADD COLUMN prev_gross_spread_pct NUMERIC;

COMMENT ON COLUMN direct_exchanges_data.arb_opportunities.arb_subtype
  IS 'CROSS_PLATFORM | TIME_DECAY | LIQUIDITY_GAP';
COMMENT ON COLUMN direct_exchanges_data.arb_opportunities.prev_gross_spread_pct
  IS 'Previous cycle gross_spread_pct, used to derive spread direction';
```

### Backfill

```sql
UPDATE direct_exchanges_data.arb_opportunities
SET arb_subtype = CASE
  WHEN arb_type = 'DIRECT' THEN 'LIQUIDITY_GAP'
  WHEN arb_type = 'COMPLEMENT' AND expires_at IS NOT NULL
       AND expires_at - NOW() <= INTERVAL '14 days'
       AND expires_at > NOW() THEN 'TIME_DECAY'
  WHEN arb_type = 'COMPLEMENT' THEN 'CROSS_PLATFORM'
END
WHERE arb_subtype IS NULL;
```

| Table | Field | Type | Description |
|-------|-------|------|-------------|
| `arb_opportunities` | `arb_subtype` | VARCHAR(20) | CROSS_PLATFORM, TIME_DECAY, or LIQUIDITY_GAP |
| `arb_opportunities` | `prev_gross_spread_pct` | NUMERIC | Previous scan cycle's gross_spread_pct |

---

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| `expires_at` is NULL | Classify COMPLEMENT as CROSS_PLATFORM (not TIME_DECAY) |
| Market already expired (`expires_at < NOW()`) | Classify as CROSS_PLATFORM (TIME_DECAY only for future expiry) |
| `expires_at` exactly 14 days from now | Classify as TIME_DECAY (inclusive boundary) |
| DIRECT arb regardless of expiry | Always LIQUIDITY_GAP |
| First scan cycle (no previous spread) | `prev_gross_spread_pct` = NULL, spread_direction = 'flat' |
| Spread unchanged between cycles | spread_direction = 'flat' |

---

## Acceptance Criteria

- [ ] `arb_subtype` column exists on `arb_opportunities` table
- [ ] `prev_gross_spread_pct` column exists on `arb_opportunities` table
- [ ] Scanner classifies DIRECT arbs as LIQUIDITY_GAP
- [ ] Scanner classifies COMPLEMENT arbs as CROSS_PLATFORM (default)
- [ ] Scanner classifies COMPLEMENT arbs expiring within 14 days as TIME_DECAY
- [ ] Upsert saves current `gross_spread_pct` into `prev_gross_spread_pct` on each cycle
- [ ] Existing rows are backfilled with correct sub-types
- [ ] `subtype_note` is populated for TIME_DECAY and LIQUIDITY_GAP arbs

---

## Examples

### Example 1: Complement Arb, Expires in 10 Days

**Input:**
```
arb_type: COMPLEMENT
expires_at: 2026-03-22T00:00:00Z  (10 days from now)
```

**Expected Output:**
```
arb_subtype: TIME_DECAY
subtype_note: 'Complement arb expiring within 14 days — spread may compress as expiry approaches'
```

### Example 2: Complement Arb, Expires in 60 Days

**Input:**
```
arb_type: COMPLEMENT
expires_at: 2026-05-11T00:00:00Z  (60 days from now)
```

**Expected Output:**
```
arb_subtype: CROSS_PLATFORM
subtype_note: NULL
```

### Example 3: Direct Arb

**Input:**
```
arb_type: DIRECT
expires_at: 2026-03-15T00:00:00Z  (3 days — would be TIME_DECAY if COMPLEMENT)
```

**Expected Output:**
```
arb_subtype: LIQUIDITY_GAP
subtype_note: 'Same-side price discrepancy across exchanges'
```

### Example 4: Spread Direction

**Input:**
```
Current gross_spread_pct: 0.05
prev_gross_spread_pct: 0.03
```

**Expected Output:**
```
spread_direction: 'up'  (spread widening — opportunity improving)
```

---

## Files to Modify

| File | Change |
|------|--------|
| `packages/shared/src/db/types.ts` | Add `arb_subtype` and `prev_gross_spread_pct` to `ArbOpportunity` interface |
| `packages/shared/src/db/queries.ts` | Update upsert query to include new columns + prev spread logic |
| `packages/homepage-api/src/services/arbScanner.ts` | Add classification logic before upsert |

---

## Notes

- `subtype_note` is NOT a new DB column. It is derived at the API layer based on `arb_subtype`. This keeps the DB lean and the note text changeable without migration.
- The 14-day TIME_DECAY threshold is a starting heuristic. It can be tuned via `arb_config` later.
- Multi-Leg arbs (3+ exchanges) are documented as "Coming Soon" in the v7 API. When implemented, they will need their own sub-type logic.
