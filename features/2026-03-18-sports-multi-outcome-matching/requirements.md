# Feature: Sports Multi-Outcome Matching Fix

**Status**: COMPLETE
**Priority**: P0
**Created**: 2026-03-18

---

## Summary

Fix the substring matcher to correctly disambiguate Win/Draw/Lose outcomes in 3-way sports events, clean up existing wrong matches, and re-run matching for affected events.

---

## Problem

The substring matcher (Tier 1) pairs Kalshi sports markets to the WRONG Polymarket outcome. 95% of arbs on the arbitrage page (46/48) are phantom arbs caused by this bug.

**Root cause:** For 3-way sports events (Win / Draw / Lose), ALL outcomes contain the same team name. The substring matcher extracts the team name and picks the first Polymarket market that contains it — which may be the Draw market instead of the Win market.

**Traced example — Rangers vs Aberdeen:**

| | Kalshi Market | Matched To (WRONG) | Should Match (CORRECT) |
|---|---|---|---|
| Market | Rangers vs Aberdeen? — Rangers | Will Rangers vs Aberdeen end in a draw? | Will Rangers FC win? |
| Price | YES = 78¢ | YES = 14¢ | YES = 78¢ |
| Result | | 62¢ fake spread shown as arb | 0¢ spread — no arb |

**Verified via database:** Polymarket prices in `market_latest_data` are fresh (updated within seconds). The `market_mappings` table has `confidence_score = 1.0, model_id = 'substring-v1'` — the matcher was certain it was correct, but it matched to the wrong outcome.

**Scale:** 43 sports markets, 3 non-sports, all with wrong matches. Only 2 out of 48 arbs on the page are plausibly real.

---

## Solution

Add outcome-type disambiguation to the substring matcher when the entity matches multiple Polymarket markets in the same event. No dedicated sports model needed — this fits within the existing framework.

---

## Algorithm / Logic

### Current Logic (broken)

```
1. Extract entity from Kalshi title: "Rangers vs Aberdeen? — Rangers" → "Rangers"
2. Find first Poly market containing "Rangers" → picks Draw (WRONG)
3. Auto-accept at confidence 1.0
```

### Fixed Logic

```
1. Extract entity from Kalshi title: "Rangers"
2. Find ALL Poly markets containing "Rangers" → [Win, Draw, Lose]
3. If only 1 match → use it (current behavior, no change)
4. If multiple matches → classify outcome type for BOTH sides:
   a. Kalshi: "Rangers vs Aberdeen? — Rangers" → WIN (entity after dash = winner)
   b. Poly candidates:
      - "Will Rangers FC win?" → WIN ✓ MATCH
      - "Will Rangers vs Aberdeen end in draw?" → DRAW ✗
      - "Will Aberdeen FC win?" → OTHER_WIN ✗
5. Pick the candidate with matching outcome type
6. If no type match → fall through to Jaccard/AI (don't guess)
```

### classifyOutcome Function

```typescript
function classifyOutcome(title: string, entity: string): 'WIN' | 'DRAW' | 'OTHER_WIN' | 'UNKNOWN' {
  const lower = title.toLowerCase();
  const entityLower = entity.toLowerCase();

  // Title contains draw/tie keywords
  if (/\b(draw|tie|tied)\b/.test(lower)) return 'DRAW';
  if (/end in a draw/.test(lower)) return 'DRAW';

  // Entity is the subject of "will X win" → WIN
  if (lower.includes(entityLower) && /\b(win|winner)\b/.test(lower))
    return 'WIN';

  // Kalshi pattern: entity after dash = that team wins
  const dashMatch = title.match(/\u2014\s*(.+)$/);
  if (dashMatch && dashMatch[1].trim().toLowerCase() === entityLower)
    return 'WIN';

  // Another team is the subject of "win" → this is about the other team winning
  if (!lower.includes(entityLower) && /\b(win|winner)\b/.test(lower))
    return 'OTHER_WIN';

  return 'UNKNOWN';
}
```

### Integration in marketMatcher.ts

```typescript
// In substring matching section, replace single .find() with:

const candidates = polyMarkets.filter(pm =>
  pm.title.toLowerCase().includes(entity.toLowerCase())
);

if (candidates.length === 1) {
  // Current behavior — single match, use it
  return candidates[0];
}

if (candidates.length > 1) {
  // Multiple matches — disambiguate by outcome type
  const kalshiOutcomeType = classifyOutcome(kalshiTitle, entity);

  const best = candidates.find(pm => {
    const polyOutcomeType = classifyOutcome(pm.title, entity);
    return polyOutcomeType === kalshiOutcomeType;
  });

  if (best) return best;
  // No type match → fall through to Jaccard/AI (safety)
}
```

---

## Configuration

No new configuration. Uses existing matching config.

---

## Input Data

| Source | Table/API | Fields Used |
|--------|-----------|-------------|
| Kalshi markets | `prediction_markets` | `title` (entity extraction + outcome classification) |
| Polymarket markets | `prediction_markets` | `title` (outcome classification) |
| Existing matches | `market_mappings` | For cleanup of bad matches |
| Arb opportunities | `arb_opportunities` | For cleanup of phantom arbs |

---

## Output Data

| Table | Field | Type | Description |
|-------|-------|------|-------------|
| `market_mappings` | All existing fields | — | Corrected Win↔Win, Draw↔Draw pairings |
| `market_titles` | `generated_title` | varchar | Updated display titles |

---

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| Entity = "Tie" (Kalshi "X vs Y? — Tie") | classifyOutcome checks title content — returns DRAW only if title contains draw/tie keyword, not just because entity is "Tie" |
| Entity matches only 1 Poly market | No change — current single-match behavior |
| Entity matches 0 Poly markets | No change — falls through to Jaccard/AI |
| Entity matches 2+ but no outcome type match | Skip substring, fall through to Jaccard/AI for safety |
| Non-sports event with entity in multiple markets | classifyOutcome returns UNKNOWN, falls through to Jaccard/AI — no false matches |
| "First Half Winner" sub-events | Same logic applies — Win/Draw/Lose within first half |
| Future: bookies with odds format (2.5, 1/3) | Not affected — this fix is for YES/NO binary format only |

---

## Acceptance Criteria

- [ ] Rangers — Rangers (WIN) matched to "Will Rangers FC win?" not to draw market
- [ ] Rangers — Tie matched to "end in a draw?" not to Rangers win
- [ ] All existing Win↔Draw mismatches deleted from market_mappings
- [ ] Phase 1.5 backfill re-matches affected sports events with correct pairings
- [ ] Arb page shows only real spreads (< 15¢ for sports, not 60¢+)
- [ ] Non-sports events unaffected by the change
- [ ] classifyOutcome falls through to UNKNOWN for ambiguous cases (no false matches)

---

## Examples

### Example 1: Win Market (current bug → fixed)

**Kalshi:** `Rangers vs Aberdeen Winner? — Rangers`
**Entity extracted:** `Rangers`
**Poly candidates:**
- `Will Rangers FC win on 2026-03-21?` → classifyOutcome = WIN
- `Will Rangers FC vs. Aberdeen FC end in a draw?` → classifyOutcome = DRAW
- `Will Aberdeen FC win on 2026-03-21?` → classifyOutcome = OTHER_WIN

**Kalshi classifyOutcome:** `Rangers` after dash → WIN
**Match:** WIN ↔ WIN → `Will Rangers FC win?` ✅

**Before fix:** Matched to Draw (14¢). Fake 62¢ arb.
**After fix:** Matched to Win (78¢). No arb (correct).

### Example 2: Tie Market

**Kalshi:** `Rangers vs Aberdeen Winner? — Tie`
**Entity extracted:** `Tie`
**classifyOutcome:** entity is `Tie` → DRAW

**Poly candidates:**
- `Will Rangers FC win?` → WIN
- `Will Rangers FC vs. Aberdeen FC end in a draw?` → DRAW ✅
- `Will Aberdeen FC win?` → OTHER_WIN

**Match:** DRAW ↔ DRAW → `end in a draw?` ✅

### Example 3: Non-sports (no change)

**Kalshi:** `Who will win LA Mayor? — Adam Miller`
**Entity:** `Adam Miller`
**Poly candidates containing "Adam Miller":** only 1 → single match, current behavior, no disambiguation needed.

---

## Backwards Compatibility

**CRITICAL:** Deploying the code fix alone will NOT fix existing bad matches. The wrong `market_mappings` rows will persist. Must clean up and re-run matching.

### Step 1: Deploy code fix

```bash
./deploy-event-matcher.sh
```

### Step 2: Count affected matches (read-only, verify scope)

```sql
SELECT COUNT(*) AS win_draw_mismatches
FROM direct_exchanges_data.market_mappings mm1
JOIN direct_exchanges_data.market_mappings mm2
  ON mm1.canonical_market_id = mm2.canonical_market_id
  AND mm2.exchange_id = 'POLYMARKET'
JOIN direct_exchanges_data.prediction_markets pm1
  ON mm1.source_id = pm1.source_id AND mm1.exchange_id = pm1.exchange_id
  AND mm1.market_id = pm1.market_id
JOIN direct_exchanges_data.prediction_markets pm2
  ON mm2.source_id = pm2.source_id AND mm2.exchange_id = pm2.exchange_id
  AND mm2.market_id = pm2.market_id
WHERE mm1.exchange_id = 'KALSHI' AND mm1.outcome_side = 'YES'
  AND (
    (pm2.title ~* '(draw|tie)' AND pm1.title !~* '(draw|tie)')
    OR (pm1.title ~* '(draw|tie)' AND pm2.title !~* '(draw|tie)')
  );
```

### Step 3: Delete bad matches

```sql
-- Delete Win↔Draw mismatched market_mappings
DELETE FROM direct_exchanges_data.market_mappings
WHERE canonical_market_id IN (
  SELECT mm1.canonical_market_id
  FROM direct_exchanges_data.market_mappings mm1
  JOIN direct_exchanges_data.market_mappings mm2
    ON mm1.canonical_market_id = mm2.canonical_market_id
    AND mm2.exchange_id = 'POLYMARKET'
  JOIN direct_exchanges_data.prediction_markets pm1
    ON mm1.source_id = pm1.source_id AND mm1.exchange_id = pm1.exchange_id
    AND mm1.market_id = pm1.market_id
  JOIN direct_exchanges_data.prediction_markets pm2
    ON mm2.source_id = pm2.source_id AND mm2.exchange_id = pm2.exchange_id
    AND mm2.market_id = pm2.market_id
  WHERE mm1.exchange_id = 'KALSHI' AND mm1.outcome_side = 'YES'
    AND (
      (pm2.title ~* '(draw|tie)' AND pm1.title !~* '(draw|tie)')
      OR (pm1.title ~* '(draw|tie)' AND pm2.title !~* '(draw|tie)')
    )
);

-- Also clean up phantom arbs
DELETE FROM direct_exchanges_data.arb_opportunities
WHERE canonical_market_id IN (
  -- same subquery as above
);
```

### Step 4: Re-run Phase 1.5 backfill

```bash
cd packages/event-matcher
pnpm backfill:markets
```

### Step 5: Verify

```sql
-- 1. No Win↔Draw mismatches remaining
SELECT COUNT(*) AS win_draw_mismatches
FROM direct_exchanges_data.market_mappings mm1
JOIN direct_exchanges_data.market_mappings mm2
  ON mm1.canonical_market_id = mm2.canonical_market_id
  AND mm2.exchange_id = 'POLYMARKET'
JOIN direct_exchanges_data.prediction_markets pm1
  ON mm1.source_id = pm1.source_id AND mm1.exchange_id = pm1.exchange_id
  AND mm1.market_id = pm1.market_id
JOIN direct_exchanges_data.prediction_markets pm2
  ON mm2.source_id = pm2.source_id AND mm2.exchange_id = pm2.exchange_id
  AND mm2.market_id = pm2.market_id
WHERE mm1.exchange_id = 'KALSHI' AND mm1.outcome_side = 'YES'
  AND (
    (pm2.title ~* '(draw|tie)' AND pm1.title !~* '(draw|tie)')
    OR (pm1.title ~* '(draw|tie)' AND pm2.title !~* '(draw|tie)')
  );
-- Expected: 0

-- 2. No unrealistic arbs
SELECT COUNT(*) AS unrealistic_arbs
FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE' AND gross_spread_pct > 0.20;
-- Expected: 0 or near-zero

-- 3. Sports match rate
SELECT COUNT(*) AS total,
  COUNT(mm.canonical_market_id) AS matched,
  ROUND(100.0 * COUNT(mm.canonical_market_id) / NULLIF(COUNT(*), 0), 1) AS pct
FROM direct_exchanges_data.prediction_markets pm
JOIN direct_exchanges_data.events e
  ON pm.source_id = e.source_id AND pm.exchange_id = e.exchange_id AND pm.event_id = e.event_id
LEFT JOIN direct_exchanges_data.market_mappings mm
  ON pm.source_id = mm.source_id AND pm.exchange_id = mm.exchange_id
  AND pm.market_id = mm.market_id AND pm.outcome_side = mm.outcome_side
WHERE e.category IN ('Sports', 'Games') AND pm.status = 'Open';
-- Target: > 85%
```

---

## Files Changed

| File | Change |
|------|--------|
| `packages/event-matcher/src/services/marketMatcher.ts` | Add `classifyOutcome()`, update substring matching to disambiguate when entity matches multiple Poly markets |
| `scripts/fix-sports-matching-cleanup.sql` | **NEW** — Delete Win↔Draw mismatches from market_mappings and arb_opportunities |

No new dependencies. No schema changes. No config changes.

---

## Notes

- This fix stays within the existing matching framework. No dedicated sports model needed.
- The `classifyOutcome` function only activates when `candidates.length > 1`. Single-match behavior is unchanged.
- For non-sports events, `classifyOutcome` returns `UNKNOWN` and falls through to Jaccard/AI — no risk of breaking existing matches.
- Estimated cost for re-matching: $5–15. Most will resolve at Tier 1 substring (with correct disambiguation) — no AI calls needed.
- Backwards compatibility lesson: same issue as Fix 3 deployment — always pair code fixes with a cleanup + backfill step.
