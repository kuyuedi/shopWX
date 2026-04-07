# Feature: Arb Expire Grace Period

**Status**: NEW
**Priority**: HIGH — must deploy before frontend launch
**Created**: 2026-03-09

---

## Summary

Add a grace period to arb expiration logic so arbs are only expired after N consecutive seconds without refresh, preventing flickering caused by momentary data gaps.

---

## Problem

The active arb count in `arb_opportunities` swings dramatically between scan cycles (e.g., 40 → 12 → 38 → 8 → 35). Arbs "flicker" — expiring and re-appearing constantly.

**Root cause:** The expire logic is too aggressive. At the end of each 10-second scan cycle:

1. `fetchMatchedMarketLegs()` filters out any leg where `market_latest_data.updated_at` is older than `max_staleness_sec` (30s)
2. If one leg's data is momentarily 31 seconds old (WebSocket reconnect, listener hiccup), the scanner skips that leg → the arb doesn't get upserted this cycle
3. `expireStaleArbs(scanTimestamp)` then expires every ACTIVE arb where `updated_at < scanTimestamp` — i.e., anything not refreshed THIS cycle
4. Next cycle (10s later), the data is fresh again → the arb is re-detected with a **new** `arb_id`

**Current expire code** (`queries.ts:1389-1397`):
```sql
UPDATE arb_opportunities
SET status = 'EXPIRED', expired_at = NOW()
WHERE status = 'ACTIVE' AND updated_at < $1
```

**This causes:**
- Active count fluctuations (±20-30 between cycles)
- Loss of `arb_id` continuity (new IDs for the same arb)
- Broken frontend animations (mass expire + mass slide-in every cycle)
- False expires from: WebSocket reconnects, listener hiccups, query timing variations, momentary data staleness

**Additional problem:** `updated_at` serves double duty — "when metrics changed" AND "when scanner last verified this arb". This makes it impossible to distinguish between "arb is stale" and "arb is alive but metrics unchanged".

---

## Solution

1. **Add `last_checked_at` column** — set every cycle the scanner confirms an arb exists, regardless of whether metrics changed
2. **Add `expire_grace_sec` config** — configurable grace period (default: 30s = ~3 scan cycles)
3. **Change expire query** — use `last_checked_at` instead of `updated_at`, with grace period instead of exact cycle boundary
4. **Separate `updated_at` semantics** — only update `updated_at` when metrics actually change (for frontend animation triggers)

---

## Algorithm / Logic

### Current flow (broken):
```
1. scanTimestamp = NOW()
2. Fetch legs (filters out stale data > 30s)
3. Detect arbs → UPSERT (sets updated_at = NOW())
4. EXPIRE all ACTIVE where updated_at < scanTimestamp
   → Anything missed THIS cycle dies immediately
```

### New flow (fixed):
```
1. scanTimestamp = NOW()
2. Read expire_grace_sec from arb_config (default: 30)
3. Fetch legs (filters out stale data > 30s)
4. Detect arbs → UPSERT:
   - ALWAYS set last_checked_at = NOW()
   - Only set updated_at = NOW() when metrics actually changed
5. EXPIRE all ACTIVE where last_checked_at < NOW() - expire_grace_sec
   → Arb survives up to 3 missed cycles before dying
```

---

## Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `expire_grace_sec` | Seconds an arb can go without refresh before expiring | `30` |

---

## Input Data

| Source | Table/API | Fields Used |
|--------|-----------|-------------|
| Arb config | `arb_config` | `expire_grace_sec` value |
| Active arbs | `arb_opportunities` | `last_checked_at`, `status` |

---

## Output Data

| Table | Field | Type | Description |
|-------|-------|------|-------------|
| `arb_opportunities` | `last_checked_at` | TIMESTAMPTZ | When scanner last confirmed this arb exists |
| `arb_opportunities` | `updated_at` | TIMESTAMPTZ | When metrics actually changed (spread, qty, etc.) |
| `arb_config` | `expire_grace_sec` | TEXT | Grace period config value |

---

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| Listener has 5s WebSocket reconnect | Arbs stay ACTIVE. `last_checked_at` stale but within 30s grace. Resumes normally. |
| One market's data is 32s old (just over staleness) | Arb stays ACTIVE. Scanner skips refreshing metrics but doesn't kill it. |
| Exchange down for 2 minutes | All arbs EXPIRE after 30s (correct — graceful) |
| Scanner query takes longer than usual | No effect — 30s grace covers timing variation |
| Metrics unchanged between cycles | `last_checked_at` updates, `updated_at` does NOT — frontend sees no false flashes |
| Config changed at runtime | Picked up next config reload (every 30 cycles) |

---

## Acceptance Criteria

- [ ] `last_checked_at` column exists on `arb_opportunities`
- [ ] `expire_grace_sec` config exists in `arb_config` with default 30
- [ ] Expire query uses `last_checked_at < NOW() - expire_grace_sec` instead of `updated_at < scanTimestamp`
- [ ] Upsert always sets `last_checked_at = NOW()`
- [ ] Upsert only sets `updated_at = NOW()` when metrics change
- [ ] Active arb count is stable across 10+ cycles (±2-3, not ±20-30)
- [ ] `arb_id` continuity maintained (same arb keeps same ID across cycles)

---

## Examples

### Example 1: Momentary data gap (was broken, now fixed)

**Cycle 1:** Arb detected, upserted. `last_checked_at = 10:00:00`, `updated_at = 10:00:00`
**Cycle 2 (10s later):** One leg's data is 32s old → filtered out → arb not upserted.
- OLD: `updated_at (10:00:00) < scanTimestamp (10:00:10)` → **EXPIRED** ✗
- NEW: `last_checked_at (10:00:00)` vs `NOW() - 30s (09:59:40)` → still within grace → **STAYS ACTIVE** ✓

**Cycle 3 (20s later):** Data fresh again → arb upserted → `last_checked_at = 10:00:20`

### Example 2: Genuine disappearance

**Cycle 1:** Arb detected. `last_checked_at = 10:00:00`
**Cycles 2-4:** Arb no longer qualifies (spread closed).
**After 30s:** `last_checked_at (10:00:00) < NOW() - 30s` → **EXPIRED** ✓

---

## Three Timestamp Fields — Clear Semantics

| Field | When it updates | Meaning |
|-------|----------------|---------|
| `updated_at` | Only when metrics actually change | "The data changed" — triggers green/red flash on frontend |
| `last_checked_at` | Every scan cycle that confirms the arb exists | "Scanner verified this arb is still alive" — used for expire logic |
| `expired_at` | Once, when arb dies | NULL = still active. Timestamp = when it died. |

---

## Notes

- Backend-only change. No frontend changes needed.
- The frontend API response format stays exactly the same.
- The frontend does not need to know about `last_checked_at` vs `updated_at` — it just sees stable data with fewer false expires.
