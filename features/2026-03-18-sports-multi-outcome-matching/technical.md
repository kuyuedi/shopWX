# Sports Multi-Outcome Matching Fix — Technical Details

## Problem

The market matcher incorrectly paired Kalshi sports markets to the wrong Polymarket outcome for 3-way events (Win/Draw/Lose). When entity "Rangers" matched multiple Polymarket markets (e.g., "Rangers Win" and "Rangers vs Opponents Draw"), the code picked the closest price — which often selected the Draw market instead of the Win market. This produced phantom arbs (Win↔Draw mismatches show ~50% spread).

## Root Cause

The bug existed in **four separate code paths** in `marketMatcher.ts`:

1. **`greedySubstringMatch()` multi-candidate** (line ~81) — used price tiebreaker when multiple Polymarket candidates matched
2. **`greedySubstringMatch()` single-candidate** (line ~79) — accepted sole match without outcome-type check
3. **`greedyMatch()` Jaccard tier** (line ~449) — no outcome-type filtering on candidate pairs
4. **Binary 1:1 auto-match** (line ~278) — when exactly 1 unmatched market remained on each side, blindly matched at confidence 1.0. This was the source of the majority of persistent mismatches (86 out of 86 remaining after fixing paths 1-3 had `confidence_score = 1.0`).

## Fix

### `classifyOutcome(title, entity)` → `'WIN' | 'DRAW' | 'OTHER_WIN' | 'UNKNOWN'`

New function that classifies a market's outcome type using title heuristics:

1. **DRAW**: Entity itself is a draw keyword (`tie`, `draw`, `tied`), or title contains draw/tie keywords
2. **WIN**: Entity appears in a title with "win"/"winner", or entity is the text after an em-dash (Kalshi pattern: "Will X win? — TeamName")
3. **OTHER_WIN**: Title contains "win"/"winner" but for a different entity
4. **UNKNOWN**: Cannot classify (non-sports markets)

### Outcome-type guard (applied in all four paths)

```typescript
const kType = classifyOutcome(kalshi.title, entity);
const pType = classifyOutcome(poly.title, entity);
if (kType !== 'UNKNOWN' && pType !== 'UNKNOWN' && kType !== pType) {
  // Reject — incompatible outcome types (e.g., WIN vs DRAW)
}
```

Key design decisions:
- **UNKNOWN passes through**: Non-sports markets that can't be classified still use the original logic (price tiebreaker or Jaccard similarity)
- **Both sides must classify**: Only reject when BOTH sides have a known type and they differ
- Uses `normalizeOutcomeName()` for accent-safe comparison in the em-dash check

## Files Changed

| File | Change |
|------|--------|
| `packages/event-matcher/src/services/marketMatcher.ts` | Added `classifyOutcome()`, added outcome-type guards to all 4 matching paths |

## Cleanup SQL

After deploying the fix, bad matches created by the old logic must be deleted and re-matched. See `usage.md` for the full cleanup and backfill procedure.
