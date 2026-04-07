# Technical: Arb Expire Grace Period

Technical implementation details for the expire grace period fix.

---

## Database Schema Changes

### New Columns

```sql
ALTER TABLE direct_exchanges_data.arb_opportunities
ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ DEFAULT NOW();
```

| Column | Type | Description |
|--------|------|-------------|
| `last_checked_at` | TIMESTAMPTZ | When the scanner last confirmed this arb exists (set every cycle) |

### New Config Row

```sql
INSERT INTO direct_exchanges_data.arb_config (config_key, config_value, description)
VALUES ('expire_grace_sec', '30', 'Seconds an arb can go without refresh before expiring. Prevents flickering from momentary data gaps.')
ON CONFLICT (config_key) DO NOTHING;
```

---

## Data Flow

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ arb_config       │     │ arb_opportunities │     │ arb_opportunities │
│ expire_grace_sec │ --> │ Scanner reads     │ --> │ EXPIRE where     │
│ = 30             │     │ last_checked_at   │     │ last_checked_at  │
└──────────────────┘     └──────────────────┘     │ < NOW() - 30s    │
                                                   └──────────────────┘
```

**Changed steps in scan cycle:**

1. Read `expire_grace_sec` from config (alongside existing config params)
2. Upsert arbs — always set `last_checked_at = NOW()`, conditionally set `updated_at`
3. Expire — use `last_checked_at < NOW() - INTERVAL 'X seconds'` instead of `updated_at < scanTimestamp`

---

## Files to Modify

### 1. `packages/shared/src/db/types.ts` — Add `last_checked_at` to ArbOpportunity

**Current** (line 232-233):
```typescript
updated_at: Date;
expired_at: Date | null;
```

**New:**
```typescript
updated_at: Date;
last_checked_at: Date;
expired_at: Date | null;
```

### 2. `packages/shared/src/db/queries.ts` — Three changes

#### a. `upsertArbOpportunities()` (lines 1323-1387)

**Change the ON CONFLICT DO UPDATE to:**
- Always set `last_checked_at = NOW()`
- Only set `updated_at` when metrics change

**Current** (line 1383):
```sql
updated_at = NOW()
```

**New:**
```sql
last_checked_at = NOW(),
updated_at = CASE
  WHEN arb_opportunities.gross_spread_pct IS DISTINCT FROM EXCLUDED.gross_spread_pct
    OR arb_opportunities.executable_qty IS DISTINCT FROM EXCLUDED.executable_qty
  THEN NOW()
  ELSE arb_opportunities.updated_at
END
```

Also add `last_checked_at` to the INSERT columns list with value `NOW()` (can use `DEFAULT` since column default is `NOW()`).

#### b. `expireStaleArbs()` (lines 1389-1397)

**Current:**
```typescript
export async function expireStaleArbs(scanTimestamp: Date): Promise<number> {
  const sql = `
    UPDATE arb_opportunities
    SET status = 'EXPIRED', expired_at = NOW()
    WHERE status = 'ACTIVE' AND updated_at < $1
  `;
  const result = await query(sql, [scanTimestamp]);
  return result.rowCount ?? 0;
}
```

**New:**
```typescript
export async function expireStaleArbs(expireGraceSec: number): Promise<number> {
  const sql = `
    UPDATE direct_exchanges_data.arb_opportunities
    SET status = 'EXPIRED', expired_at = NOW()
    WHERE status = 'ACTIVE'
      AND last_checked_at < NOW() - INTERVAL '1 second' * $1
  `;
  const result = await query(sql, [expireGraceSec]);
  return result.rowCount ?? 0;
}
```

**Key change:** Parameter changes from `scanTimestamp: Date` to `expireGraceSec: number`. The query compares `last_checked_at` against a grace window instead of exact cycle boundary.

### 3. `packages/homepage-api/src/services/arbScanner.ts` — Two changes

#### a. Read `expire_grace_sec` from config (after line 42)

```typescript
const expireGraceSec = getConfigNum(config, 'expire_grace_sec', 30);
```

#### b. Change `expireStaleArbs` call (line 212)

**Current:**
```typescript
const expired = await expireStaleArbs(scanTimestamp);
```

**New:**
```typescript
const expired = await expireStaleArbs(expireGraceSec);
```

The `scanTimestamp` variable at line 23 is no longer needed for expiration but doesn't need to be removed (no harm if kept for logging).

---

## Dependencies

### Prerequisites

1. Database migration must be run (add `last_checked_at` column, insert config row)
2. Existing `arb_opportunities` and `arb_config` tables must exist

### Runtime Dependencies

| Component | Required For |
|-----------|-------------|
| `arb_config` table | Reading `expire_grace_sec` value |
| `arb_opportunities.last_checked_at` column | Grace period expire logic |

---

## Migration Checklist

- [ ] SSH to server and run migration SQL (add column + insert config)
- [ ] Build shared package (`pnpm build`)
- [ ] Deploy homepage-api (which includes arb scanner)
- [ ] Verify active arb count stability over 2 minutes

---

## Migration SQL

```sql
-- 1. Add last_checked_at column
ALTER TABLE direct_exchanges_data.arb_opportunities
ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ DEFAULT NOW();

-- 2. Backfill existing rows: set last_checked_at = updated_at
UPDATE direct_exchanges_data.arb_opportunities
SET last_checked_at = updated_at
WHERE last_checked_at IS NULL OR last_checked_at = updated_at;

-- 3. Add config
INSERT INTO direct_exchanges_data.arb_config (config_key, config_value, description)
VALUES ('expire_grace_sec', '30', 'Seconds an arb can go without refresh before expiring. Prevents flickering from momentary data gaps.')
ON CONFLICT (config_key) DO NOTHING;
```

---

## Rollback Plan

If issues arise:

```sql
-- Revert expire config
DELETE FROM direct_exchanges_data.arb_config WHERE config_key = 'expire_grace_sec';

-- Column can be left (harmless) or dropped:
ALTER TABLE direct_exchanges_data.arb_opportunities
DROP COLUMN IF EXISTS last_checked_at;
```

Code rollback: revert the 3 file changes and redeploy. The old `expireStaleArbs(scanTimestamp)` will work as before.

---

## Testing Strategy

### Unit Tests

| Test Case | Input | Expected Output |
|-----------|-------|-----------------|
| Arb refreshed this cycle | `last_checked_at` = 2s ago, grace = 30s | NOT expired |
| Arb missed 1 cycle (10s) | `last_checked_at` = 12s ago, grace = 30s | NOT expired |
| Arb missed 3 cycles (30s) | `last_checked_at` = 32s ago, grace = 30s | EXPIRED |
| Metrics unchanged | Same spread/qty as before | `updated_at` unchanged, `last_checked_at` updated |
| Metrics changed | Different spread | Both `updated_at` and `last_checked_at` updated |

### Integration Tests

- Run scanner for 2 minutes, verify count stability (±2-3, not ±20-30)
- Kill one listener briefly, verify arbs survive the gap
- Verify `arb_id` stays the same for a persistent arb across cycles

---

## Performance Considerations

- `last_checked_at` uses same DEFAULT as `updated_at` — no index needed (expire query scans ACTIVE rows only, which should be a small set)
- `IS DISTINCT FROM` in the conditional `updated_at` update handles NULL comparisons correctly
- No additional queries — same number of DB round-trips as before
- Grace period means fewer EXPIRE+INSERT churn cycles → less DB write load
