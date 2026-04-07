# Feature: Market IDs & Resolution Info

**Status**: COMPLETED
**Priority**: High
**Created**: 2026-02-12

---

## Summary

Add `event_id` to group related outcomes/markets under a parent event, and capture resolution rules (`rules_primary`, `rules_secondary`) for each market.

---

## Problem

1. **No event grouping**: There is no way to group related outcomes (e.g., YES/NO tokens of the same Polymarket question, or different Kalshi market tickers under one event). This is essential for the Markets Matching Engine to correlate equivalent markets across exchanges.

2. **Missing resolution rules**: Kalshi's `rules_primary`/`rules_secondary` are not fetched from the API. The existing `description` column stores Polymarket's description and Kalshi's `subtitle` — misleading naming and wrong Kalshi mapping.

---

## Solution

### Requirement 1: event_id

Add an `event_id` column to `prediction_markets` that groups related outcomes under a common parent.

| Exchange | event_id source | market_id (unchanged) |
|----------|----------------|----------------------|
| Polymarket | `id` field from Gamma API (e.g., "1222896") — groups YES/NO tokens | `clobTokenIds[i]` (token ID) |
| Kalshi | `event_ticker` from events API (e.g., "KXNCAAMBGAME-26FEB10MILWIUIN") — groups outcome markets | `ticker` (full market ticker) |

### Requirement 2: rules_primary / rules_secondary

Rename `description` column to `rules_primary` and add `rules_secondary` to capture resolution criteria.

| Exchange | rules_primary source | rules_secondary source |
|----------|---------------------|----------------------|
| Polymarket | `description` from Gamma API (already fetched) | N/A (NULL) |
| Kalshi | `rules_primary` from Kalshi API (NOT currently fetched) | `rules_secondary` from Kalshi API (NOT currently fetched) |

---

## Algorithm / Logic

### event_id Population

**Polymarket:**
```
1. For each market from Gamma API:
   event_id = market.id  (the Gamma market ID, e.g. "1222896")
2. Both YES and NO tokens of the same question share this event_id
```

**Kalshi:**
```
1. Fetch events with nested markets via /events?with_nested_markets=true
2. For each event, inject event.event_ticker into each nested market
3. event_id = event.event_ticker (e.g. "KXNCAAMBGAME-26FEB10MILWIUIN")
4. All markets under the same event share this event_id
```

### rules_primary / rules_secondary Population

**Polymarket:**
```
1. rules_primary = market.description (same data, renamed column)
2. rules_secondary = NULL (not applicable)
```

**Kalshi:**
```
1. rules_primary = market.rules_primary (from nested market in events API response)
2. rules_secondary = market.rules_secondary (from nested market in events API response)
3. Previously used market.subtitle — this is replaced by rules_primary from API
```

---

## Input Data

| Source | API/Endpoint | Fields Used |
|--------|-------------|-------------|
| Polymarket Gamma API | `GET /markets?active=true` | `id` (event_id), `description` (rules_primary) |
| Kalshi Events API | `GET /events?with_nested_markets=true` | `event_ticker` (event_id), nested `rules_primary`, `rules_secondary` |

---

## Output Data

| Table | Field | Type | Description |
|-------|-------|------|-------------|
| `prediction_markets` | `event_id` | VARCHAR(255) | Parent event identifier grouping related outcomes |
| `prediction_markets` | `rules_primary` | TEXT | Primary resolution rules (renamed from `description`) |
| `prediction_markets` | `rules_secondary` | TEXT | Secondary resolution rules (Kalshi only) |

---

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| Polymarket market missing `id` field | `event_id` = NULL |
| Kalshi event missing `event_ticker` | `event_id` = NULL |
| Kalshi market missing `rules_primary` | `rules_primary` = NULL |
| Kalshi market missing `rules_secondary` | `rules_secondary` = NULL |
| Polymarket `description` is empty/null | `rules_primary` = NULL |
| `event_id` exceeds 255 chars | Truncate to 255 characters |

---

## Acceptance Criteria

- [x] `event_id` is populated for Polymarket markets (from Gamma API `id` field)
- [x] `event_id` is populated for Kalshi markets (from `event_ticker` field)
- [x] `event_id` correctly groups YES/NO tokens for Polymarket
- [x] `event_id` correctly groups markets under the same Kalshi event
- [x] `rules_primary` is populated for Polymarket (from `description`)
- [x] `rules_primary` is populated for Kalshi (from API `rules_primary`, not `subtitle`)
- [x] `rules_secondary` is populated for Kalshi markets that have it
- [x] `rules_secondary` is NULL for all Polymarket markets
- [x] Existing data continues to flow without interruption after migration

---

## Verification

```sql
-- 1. Check event_id populated for both exchanges
SELECT exchange_id, COUNT(*) FILTER (WHERE event_id IS NOT NULL) as with_event_id,
       COUNT(*) FILTER (WHERE event_id IS NULL) as without_event_id
FROM direct_exchanges_data.prediction_markets
WHERE updated_at > NOW() - INTERVAL '10 minutes'
GROUP BY exchange_id;

-- 2. Check rules_primary populated
SELECT exchange_id, COUNT(*) FILTER (WHERE rules_primary IS NOT NULL) as with_rules,
       COUNT(*) FILTER (WHERE rules_primary IS NULL) as without_rules
FROM direct_exchanges_data.prediction_markets
WHERE updated_at > NOW() - INTERVAL '10 minutes'
GROUP BY exchange_id;

-- 3. Check rules_secondary for Kalshi
SELECT COUNT(*) FILTER (WHERE rules_secondary IS NOT NULL) as with_secondary
FROM direct_exchanges_data.prediction_markets
WHERE exchange_id = 'KALSHI' AND updated_at > NOW() - INTERVAL '10 minutes';

-- 4. Verify event_id groups outcomes correctly (Polymarket)
SELECT event_id, COUNT(*) as outcomes, array_agg(outcome_side)
FROM direct_exchanges_data.prediction_markets
WHERE exchange_id = 'POLYMARKET' AND event_id IS NOT NULL
GROUP BY event_id HAVING COUNT(*) = 2
LIMIT 5;

-- 5. Verify event_id groups markets correctly (Kalshi)
SELECT event_id, COUNT(DISTINCT market_id) as markets
FROM direct_exchanges_data.prediction_markets
WHERE exchange_id = 'KALSHI' AND event_id IS NOT NULL
GROUP BY event_id HAVING COUNT(DISTINCT market_id) > 1
LIMIT 5;
```

---

## Notes

- This feature supports the Markets Matching Engine PRD (Sections 1 & 2 only).
- Section 3 (Fees & Interest) is deferred — no concrete solution in PRD.
- The `description` → `rules_primary` rename is a breaking change for any downstream queries referencing the old column name.
