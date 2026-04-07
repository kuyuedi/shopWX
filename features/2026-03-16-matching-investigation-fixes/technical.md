# Technical Documentation: Matching Investigation Fixes

## Overview

Seven fixes addressing 43.6% unmatched cross-exchange markets and incorrect low-confidence matches. Changes span SQL migrations, configuration, pre-filter logic, GPT prompts, and a new Phase 2 cross-event matching module.

---

## Group A: Data Cleanup (SQL only)

### Fix 1: Delete Bad Matches (confidence < 0.80)

**File:** `scripts/fix-1-delete-bad-matches.sql`

Removes incorrect matches where GPT confused threshold markets ("above X%") with exact-value markets ("be X%"), producing confidence scores around 0.55. These pollute the homepage display.

```sql
DELETE FROM direct_exchanges_data.market_mappings
WHERE confidence_score < 0.80;
```

The script includes pre-check (grouped counts of low-confidence rows) and post-check (remaining count, min/avg confidence) steps.

### Fix 4: Backfill Missing NO-Side Market Mappings

**File:** `scripts/fix-4-backfill-no-sides.sql`

Old matches only wrote YES-side rows. The current code (`writeMarketMapping` in `crossEventMatcher.ts:254` and `matchMarketsForSinglePair` in `marketMatcher.ts`) already writes 4 rows (YES+NO per exchange). This script backfills historical data:

```sql
INSERT INTO direct_exchanges_data.market_mappings (...)
SELECT mm_yes.source_id, mm_yes.exchange_id, pm_no.market_id, 'NO', ...
FROM direct_exchanges_data.market_mappings mm_yes
JOIN prediction_markets pm_yes ON ... AND pm_yes.outcome_side = 'YES'
JOIN prediction_markets pm_no ON ... AND pm_no.outcome_side = 'NO' AND pm_yes.title = pm_no.title
WHERE mm_yes.outcome_side = 'YES'
AND NOT EXISTS (SELECT 1 FROM market_mappings mm_no WHERE mm_no.canonical_market_id = mm_yes.canonical_market_id AND mm_no.exchange_id = mm_yes.exchange_id AND mm_no.outcome_side = 'NO')
ON CONFLICT DO NOTHING;
```

Joins YES mappings → YES prediction_markets → NO prediction_markets (same event + title) to derive the NO-side market_id.

---

## Group B: Pre-Filter Improvements (code)

All changes in `packages/event-matcher/src/services/preFilter.ts`.

### Fix 2: Raise Jaccard Auto-Accept Threshold 0.50 → 0.85

**File:** `packages/event-matcher/src/config.ts:12`

```typescript
marketMatchThreshold: parseFloat(process.env.MARKET_MATCH_THRESHOLD || '0.85'),
```

Previously `0.5`. This means market pairs need Jaccard ≥ 0.85 for automatic acceptance without AI verification. Pairs with Jaccard 0.3–0.85 now go through AI verification instead of being auto-accepted at 0.5+.

### Fix 3a: Entity Name Extraction

**File:** `packages/event-matcher/src/services/preFilter.ts:62-69`

Extracts entity names from Kalshi's "Question? — Entity" title pattern:

```typescript
export function extractEntity(title: string): string | null {
  const dashMatch = title.match(/\s*[—–-]\s*(.+)$/);
  if (dashMatch) return dashMatch[1]!.trim();
  return null;
}
```

Handles em-dash (`—`), en-dash (`–`), and regular dash (`-`).

**Usage in `findCandidates()`** (`preFilter.ts:186-200`): If the extracted entity name appears in a Polymarket event title, adds +3 to the overlap score, forcing the pair to GPT evaluation even when keyword overlap is otherwise low.

```typescript
// preFilter.ts:186-191
const kalshiEntity = extractEntity(kalshiEvent.title || '');
const kalshiEntityNorm = kalshiEntity
  ? stripAccents(kalshiEntity).toLowerCase()
  : null;

// preFilter.ts:211-217 — Entity name bonus
if (kalshiEntityNorm) {
  const polyTitleNorm = stripAccents(polyEvent.title || '').toLowerCase();
  if (polyTitleNorm.includes(kalshiEntityNorm)) {
    overlap += 3; // Strong boost
  }
}
```

### Fix 3b: Synonym Normalization

**File:** `packages/event-matcher/src/services/preFilter.ts:17-59`

Synonym map (`SYNONYMS` constant, lines 19-39) normalizes financial/political terms to canonical forms before keyword comparison:

| Synonyms | Canonical |
|----------|-----------|
| cut, slash, lower | decrease |
| hike, raise, boost | increase |
| buy, purchase, obtain | acquire |
| win, beat, defeat | victory |
| maintain, unchanged, steady | nochange |
| leave, resign, quit, step down | depart |

Applied via `normalizeSynonyms()` (lines 53-59) using word-boundary regex replacement. Called inside `extractKeywords()` (line 138) before tokenization.

### Fix 3c: Unicode Accent Stripping

**File:** `packages/event-matcher/src/services/preFilter.ts:41-47`

```typescript
export function stripAccents(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
```

Uses Unicode NFD normalization to decompose accented characters, then strips combining diacritical marks. "São Paulo" → "Sao Paulo", "González" → "Gonzalez".

**Applied in three places:**
1. `extractKeywords()` (`preFilter.ts:138`) — before keyword tokenization
2. Entity name normalization in `findCandidates()` (`preFilter.ts:188`)
3. `normalizeOutcomeName()` (`marketMatcher.ts:102-103`) — for market-level matching

---

## Group C: AI Quality (code)

### Fix 5: GPT Rejection Criteria

**File:** `packages/event-matcher/src/services/aiComparer.ts`

Added explicit rejection rules to both GPT prompts:

**Event comparison prompt** (lines 135-142):
```
- Ignore wording differences like "buy" vs "acquire", "cut" vs "decrease", "leave office" vs "out as leader"
...
IMPORTANT REJECTION CRITERIA — return confidence = 0 if:
1. THRESHOLD vs EXACT: "above X%" != "exactly X%"
2. DIFFERENT TIME PERIODS: "Oct meeting" != "end of 2026", "before Jul 2026" != "in 2026"
3. DIFFERENT ENTITIES: Different people, teams, or countries
4. DIFFERENT METRICS: Cumulative vs incremental measures
```

**Market verification prompt** (lines 255-259):
```
IMPORTANT REJECTION CRITERIA — You MUST return confidence = 0 if ANY of these are true:
1. THRESHOLD vs EXACT VALUE: "above X%" or "at least X" != "exactly X%" or "be X%"
2. DIFFERENT DATES: Different time periods or meetings
3. DIFFERENT CANDIDATES/ENTITIES: Different people, teams, or entities
4. DIFFERENT METRICS: total/cumulative != incremental/change
```

The market verification prompt uses more detailed examples and stronger language ("You MUST") since it's the final gate for borderline matches.

---

## Group D: Cross-Event Matching (new module)

### Fix 6: Cross-Event Date-Variant Matching
### Fix 7: Mega-Event Decomposition

Both handled by the same module since the approach is identical: extract entity from unmatched Kalshi markets, search all Polymarket markets by entity name, AI-verify matches.

**New file:** `packages/event-matcher/src/services/crossEventMatcher.ts` (340 lines)

#### Architecture

Phase 2 runs after Phase 1 in each matching cycle (`matchingCycle.ts:211-221`):

```typescript
// matchingCycle.ts:216-218
crossEventMatched = await runCrossEventMatching(config);
await runMegaEventMatching(config);
```

#### `runCrossEventMatching()` (line 86)

1. Fetches all unmatched Kalshi YES markets via `fetchUnmatchedMarketsWithEvents()` (`queries.ts:1732`)
2. Extracts entity name from each market title using `extractEntity()` from preFilter
3. Groups markets by normalized entity name (skips entities < 3 chars)
4. For each entity group, searches Polymarket via `searchPolymarketMarketsByEntity()` (`queries.ts:1801`)
5. For each Kalshi market, calls `findBestPolyMatch()` (line 208)
6. On match: writes 4 mapping rows via `writeMarketMapping()` (line 254) with `model_id = 'cross-event-ai-v1'`

#### `findBestPolyMatch()` (line 208)

1. Filters Polymarket candidates whose normalized title contains the Kalshi entity name
2. If 1 candidate: AI-verify with `verifyMarketMatch()`, accept if confidence ≥ 0.8
3. If multiple: AI-verify each, pick highest confidence (must be ≥ 0.8)

#### `runMegaEventMatching()` (line 165)

Fetches Kalshi events with 20+ markets via `fetchMegaEvents()` (`queries.ts:1761`). Currently a logging/metrics entry point — actual matching is handled by `runCrossEventMatching()` since it processes ALL unmatched markets (including those from mega-events).

#### `writeMarketMapping()` (line 254)

Writes 4 `market_mappings` rows (YES+NO for both exchanges) and a `market_titles` entry. Uses deterministic `CM-{sha256_prefix}` canonical IDs via `generateCanonicalMarketId()` (line 44).

#### New Database Queries

**`fetchUnmatchedMarketsWithEvents()`** (`packages/shared/src/db/queries.ts:1732`)
- Joins `prediction_markets` → `events`, LEFT JOINs `market_mappings`
- Filters: exchange match, `outcome_side = 'YES'`, `status = 'Open'`, no existing mapping
- Returns markets with event metadata (title, category, end_date)

**`fetchMegaEvents()`** (`packages/shared/src/db/queries.ts:1761`)
- Fetches Kalshi events with `market_count >= 20`
- Joins through `prediction_markets` → `market_latest_data` for volume aggregation
- Note: LEFT JOIN without `outcome_side = 'YES'` filter may double-count volume (cosmetic only — used for sorting)

**`searchPolymarketMarketsByEntity()`** (`packages/shared/src/db/queries.ts:1801`)
- `WHERE LOWER(pm.title) LIKE '%' || LOWER($1) || '%'` substring search
- Filtered to Polymarket, YES-side, Open status
- Limited to 20 results, ordered by price DESC
- Note: Bypasses indexes due to leading `%`; acceptable at ~19k Polymarket markets

---

## Known Limitations

1. **Volume double-counting in `fetchMegaEvents()`** — LEFT JOIN through `prediction_markets` → `market_latest_data` without `outcome_side = 'YES'` filter. Impact: cosmetic (volume used for sorting only).

2. **LIKE performance in `searchPolymarketMarketsByEntity()`** — Full table scan due to leading wildcard. Acceptable at current scale (~19k rows), may need `pg_trgm` index if Polymarket grows significantly.

3. **Entity substring false positives** — Common names (e.g., "Miller") could match unrelated markets. Mitigated by AI verification requiring confidence ≥ 0.8.

4. **AI threshold hardcoded** — `verifyMarketMatch()` acceptance threshold of 0.8 in `crossEventMatcher.ts` is hardcoded, not pulled from config.

---

## File Reference

| File | Lines | Changes |
|------|-------|---------|
| `packages/event-matcher/src/config.ts` | 18 | Threshold 0.50 → 0.85 (line 12) |
| `packages/event-matcher/src/services/preFilter.ts` | 242 | +78 lines: synonyms (17-39), stripAccents (45-47), normalizeSynonyms (53-59), extractEntity (66-69), keyword normalization (138), entity boost (186-217) |
| `packages/event-matcher/src/services/marketMatcher.ts` | 422 | +2 lines: import stripAccents (14), apply in normalizeOutcomeName (102-103) |
| `packages/event-matcher/src/services/aiComparer.ts` | 311 | +13 lines: event rejection criteria (135, 138-142), market rejection criteria (255-259) |
| `packages/event-matcher/src/services/crossEventMatcher.ts` | 340 | NEW: Phase 2 cross-event + mega-event matching |
| `packages/event-matcher/src/services/matchingCycle.ts` | 238 | +14 lines: Phase 2 wiring (211-221, 233) |
| `packages/shared/src/db/queries.ts` | 1818 | +93 lines: fetchUnmatchedMarketsWithEvents (1732), fetchMegaEvents (1761), searchPolymarketMarketsByEntity (1801) |
| `scripts/fix-1-delete-bad-matches.sql` | 27 | NEW: Delete confidence < 0.80 |
| `scripts/fix-4-backfill-no-sides.sql` | 58 | NEW: Backfill NO-side mappings |
