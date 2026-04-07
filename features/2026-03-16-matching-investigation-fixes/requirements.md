# Feature: Market Matching Investigation Fixes (7 Fixes)

**Status**: IMPLEMENTED
**Priority**: P0
**Created**: 2026-03-16

---

## Summary

Fix 7 matching quality issues causing 43.6% of cross-exchange markets to be unmatched and some incorrect matches polluting the homepage display.

---

## Problem

Market matching quality across the platform has significant issues affecting data accuracy on both the homepage and arbitrage pages.

| Metric | Value | Assessment |
|--------|-------|------------|
| Total markets in multi-exchange events | 25,884 | |
| Matched markets | 14,590 | |
| Unmatched markets | 11,294 | 43.6% missing |
| Match rate | 56.4% | POOR - should be >90% |

**Five root causes identified:**

1. **Title Structure Mismatch** — Kalshi uses "Question? — Entity" pattern while Polymarket uses full sentences. The keyword pre-filter rejects these due to low word overlap, so they never reach GPT.
2. **Wrong Matches at Low Confidence** — GPT confused threshold markets ("above X%") with exact-value markets ("be X%") at confidence 0.55, polluting the homepage.
3. **Asymmetric Side Matching** — YES-side matches exist but NO-side is missing, causing duplicate split rows in the UI.
4. **Cross-Event Date-Variant Mismatch** — Kalshi groups date variants under one event; Polymarket creates separate events per date. Markets never compared across events.
5. **Mega-Event Structure Mismatch** — Kalshi groups 20-60+ entity markets under one event; Polymarket splits each entity into its own event. Only one Poly event gets matched.

---

## Solution

Seven fixes across SQL migrations, configuration, pre-filter logic, GPT prompts, and a new Phase 2 cross-event matching module.

| Fix | Type | Impact |
|-----|------|--------|
| Fix 1: Delete bad matches < 0.80 | SQL migration | Removes incorrect matches from homepage |
| Fix 2: Raise Jaccard auto-accept 0.50 → 0.85 | Config change | Prevents future low-quality matches |
| Fix 3: Improve pre-filter (entity, synonyms, Unicode) | Code | Raises match rate from 56% to ~85%+ |
| Fix 4: Backfill NO-side mappings | SQL migration + code (already handled) | Fixes split-row display bug |
| Fix 5: Add GPT rejection criteria | Prompt engineering | Prevents threshold/date/entity mismatches |
| Fix 6: Cross-event date-variant matching | New module | Matches markets across different events |
| Fix 7: Mega-event decomposition | New module | Handles Kalshi events with 20+ entity markets |

---

## Algorithm / Logic

### Phase 1: Existing Within-Event Matching (improved)

```
1. Fetch open events from both exchanges
2. Pre-filter with keyword overlap (now with synonym normalization, accent stripping, entity extraction)
3. Send candidates to GPT with explicit rejection criteria
4. On match: write event_mappings, then match markets inline
5. Market matching uses 4 tiers: Binary → Substring → Jaccard (≥0.85) → AI verify
6. Always write both YES and NO sides (4 rows per match)
```

### Phase 2: Cross-Event Matching (new)

```
1. Fetch all unmatched Kalshi YES markets with event info
2. For each market, extract entity name (text after "—" in title)
3. Group markets by normalized entity name
4. For each entity, search Polymarket markets by entity substring
5. For each Kalshi-Poly candidate pair, run AI verification
6. If AI confirms (confidence ≥ 0.8), write market_mappings (4 rows)
7. Log mega-events (20+ markets) for visibility
```

### Pre-Filter Improvements (Fix 3)

```
3a. Extract entity: "Who will win X? — Adam Miller" → entity = "Adam Miller"
    If entity appears in Polymarket title → +3 overlap bonus → force GPT evaluation

3b. Synonym normalization before keyword comparison:
    cut/slash/lower → decrease
    hike/raise/boost → increase
    buy/purchase/obtain → acquire
    win/beat/defeat → victory
    leave/resign/quit → depart
    maintain/unchanged/steady → nochange

3c. Unicode accent stripping: "São Paulo" → "Sao Paulo", "González" → "Gonzalez"
    Applied via NFD normalization + diacritics removal
```

### GPT Rejection Criteria (Fix 5)

```
MUST return confidence = 0 if ANY of these are true:
1. THRESHOLD vs EXACT: "above X%" != "be X%"
2. DIFFERENT DATES: "Oct meeting" != "end of 2026"
3. DIFFERENT ENTITIES: "Adam Miller" != "Jessica Rodriguez"
4. DIFFERENT METRICS: total/cumulative != incremental/change
```

---

## Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `MARKET_MATCH_THRESHOLD` | Jaccard auto-accept threshold (raised from 0.50) | `0.85` |
| `MARKET_MATCH_AI_THRESHOLD` | Min Jaccard to trigger AI verification | `0.3` |
| `MATCHER_CONFIDENCE_THRESHOLD` | Min confidence for event match | `0.85` |
| `OPENAI_MODEL` | Model for AI comparisons | `gpt-5-nano` |

---

## Input Data

| Source | Table/API | Fields Used |
|--------|-----------|-------------|
| Kalshi markets | `prediction_markets` | `title`, `outcome_name`, `outcome_side`, `price`, `expires_at`, `event_id` |
| Polymarket markets | `prediction_markets` | `title`, `outcome_name`, `outcome_side`, `price`, `expires_at`, `event_id` |
| Events | `events` | `event_id`, `title`, `category`, `market_count`, `end_date` |
| Existing mappings | `market_mappings` | `market_id`, `outcome_side`, `confidence_score` |
| Event mappings | `event_mappings` | `event_id`, `canonical_event_id` |

---

## Output Data

| Table | Field | Type | Description |
|-------|-------|------|-------------|
| `market_mappings` | `canonical_market_id` | varchar | Links matched market pair |
| `market_mappings` | `confidence_score` | numeric | Match confidence (0-1) |
| `market_mappings` | `model_id` | varchar | `algorithmic-v1`, `substring-v1`, `ai-verified-v1`, or `cross-event-ai-v1` |
| `market_titles` | `generated_title` | varchar | Display title for matched market |

---

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| Threshold vs exact value market ("above X%" vs "be X%") | Reject with confidence = 0 |
| Different dates ("Oct meeting" vs "end of 2026") | Reject with confidence = 0 |
| Different entities in same event type | Reject with confidence = 0 |
| Accented characters ("São" vs "Sao") | Strip accents, match normally |
| Synonym differences ("cut" vs "decrease") | Normalize to canonical form, match normally |
| Kalshi mega-event with 60+ entity markets | Decompose by entity, search Poly individually |
| Polymarket splits dates across events | Cross-event Phase 2 matches by entity search |
| Entity name too short (< 3 chars) | Skip to avoid false matches |
| No Polymarket candidates found for entity | Skip, log debug |
| Multiple Poly candidates for one entity | AI-verify each, pick highest confidence |

---

## Acceptance Criteria

- [x] Fix 1: No market_mappings rows with confidence_score < 0.80
- [x] Fix 2: `MARKET_MATCH_THRESHOLD` default is 0.85 (was 0.50)
- [x] Fix 3a: Entity names extracted from Kalshi "Question? — Entity" titles and used for +3 overlap boost
- [x] Fix 3b: Synonym normalization applied before keyword comparison (cut→decrease, buy→acquire, etc.)
- [x] Fix 3c: Unicode accents stripped before comparison (São→Sao, González→Gonzalez)
- [x] Fix 4: SQL backfill script creates missing NO-side mappings for existing YES-only matches
- [x] Fix 5: GPT prompts include explicit rejection criteria for threshold/date/entity/metric mismatches
- [x] Fix 6: Phase 2 cross-event matching runs after Phase 1 in each cycle
- [x] Fix 7: Mega-events (20+ markets) detected and logged; entity-based cross-event search handles decomposition
- [x] All changes build successfully (`pnpm -r build`)
- [x] Both YES and NO sides written for all new matches (4 rows per market pair)

---

## Examples

### Example 1: Entity Extraction Match (Fix 3a)

**Kalshi title:** `Who will win Los Angeles Mayoral Election? — Adam Miller`
**Polymarket title:** `Will Adam Miller win the 2026 Los Angeles mayoral election?`

Before fix: Pre-filter rejects due to low keyword overlap. **NOT MATCHED.**
After fix: Entity "Adam Miller" extracted, found in Poly title → +3 boost → sent to GPT → **MATCHED.**

### Example 2: Synonym Match (Fix 3b)

**Kalshi title:** `Federal Funds Rate Decision: Cut 25bps`
**Polymarket title:** `Will the Fed decrease interest rates by 25 bps?`

Before fix: "cut" and "decrease" are different tokens. **NOT MATCHED.**
After fix: Both normalize to "decrease" → keyword overlap increases → **MATCHED.**

### Example 3: Threshold vs Exact Rejection (Fix 5)

**Kalshi market:** `above 3.25% following Oct meeting`
**Polymarket market:** `be 3.25% at end of 2026`

Before fix: Matched at confidence 0.55, pollutes homepage.
After fix: GPT rejection rule fires (threshold vs exact + different dates) → confidence = 0 → **REJECTED.**

### Example 4: Cross-Event Mega-Event Match (Fix 6 + 7)

**Kalshi mega-event:** "Which world leaders will leave office in 2026?" (66 markets)
**Kalshi market:** `GPETCOL — Gustavo Petro` (94%)
**Polymarket event:** "Gustavo Petro out as leader of Colombia by...?" → "By Dec 31" (93.5%)

Before fix: Kalshi mega-event mapped to one Poly event (Iran). Petro **NOT MATCHED.**
After fix: Entity "Gustavo Petro" extracted → Poly search finds event 143568 → AI confirms → **MATCHED.** Both prices show side by side.

---

## Files Changed

| File | Change |
|------|--------|
| `packages/event-matcher/src/config.ts` | `MARKET_MATCH_THRESHOLD` default 0.50 → 0.85 |
| `packages/event-matcher/src/services/preFilter.ts` | Added synonym map, `stripAccents()`, `extractEntity()`, entity boost in `findCandidates()` |
| `packages/event-matcher/src/services/marketMatcher.ts` | Added accent stripping to `normalizeOutcomeName()` |
| `packages/event-matcher/src/services/aiComparer.ts` | Added 4 rejection criteria to both event and market GPT prompts |
| `packages/event-matcher/src/services/crossEventMatcher.ts` | **NEW** — Phase 2 cross-event matching + mega-event decomposition |
| `packages/event-matcher/src/services/matchingCycle.ts` | Wired Phase 2 after Phase 1 |
| `packages/shared/src/db/queries.ts` | Added `fetchUnmatchedMarketsWithEvents()`, `fetchMegaEvents()`, `searchPolymarketMarketsByEntity()` |
| `scripts/fix-1-delete-bad-matches.sql` | **NEW** — SQL to delete matches with confidence < 0.80 |
| `scripts/fix-4-backfill-no-sides.sql` | **NEW** — SQL to backfill missing NO-side mappings |

---

## Deployment

### Step 1: Run SQL migrations (one-time, on server)

```bash
ssh root@8.216.43.26
```

**Fix 1 — Delete bad matches:**
```sql
PGPASSWORD='HAH2#mwzay_8a' psql -h pgm-0iwbjigj740ve1e5.pgsql.japan.rds.aliyuncs.com -U direct_exchanges -d direct_exchanges -c "
DELETE FROM direct_exchanges_data.market_mappings WHERE confidence_score < 0.80;
"
```

**Fix 4 — Backfill NO-side mappings:**
```sql
PGPASSWORD='HAH2#mwzay_8a' psql -h pgm-0iwbjigj740ve1e5.pgsql.japan.rds.aliyuncs.com -U direct_exchanges -d direct_exchanges -f scripts/fix-4-backfill-no-sides.sql
```

### Step 2: Deploy

```bash
./deploy-event-matcher.sh
```

### Step 3: Verify

```bash
ssh root@8.216.43.26 "docker compose -f /opt/prediction-market-ingestion/docker-compose.yml logs --tail 100 event-matcher"
```

Look for: `"Starting Phase 2: cross-event matching"`, `"Cross-event market match written"`, `crossEventMatched` in cycle complete log.

---

## Validation Queries

```sql
-- 1. Verify no low-confidence matches remain
SELECT MIN(confidence_score) as min_conf,
  COUNT(*) FILTER (WHERE confidence_score < 0.80) as bad
FROM direct_exchanges_data.market_mappings;
-- Expected: min_conf >= 0.85, bad = 0

-- 2. Check match coverage rate
SELECT COUNT(*) as total,
  COUNT(mm.canonical_market_id) as matched,
  ROUND(100.0 * COUNT(mm.canonical_market_id) / NULLIF(COUNT(*), 0), 1) as match_rate_pct
FROM direct_exchanges_data.prediction_markets pm
JOIN direct_exchanges_data.event_mappings em
  ON pm.source_id = em.source_id AND pm.exchange_id = em.exchange_id AND pm.event_id = em.event_id
LEFT JOIN direct_exchanges_data.market_mappings mm
  ON pm.source_id = mm.source_id AND pm.exchange_id = mm.exchange_id
  AND pm.market_id = mm.market_id AND pm.outcome_side = mm.outcome_side
WHERE em.canonical_event_id IN (
  SELECT canonical_event_id FROM direct_exchanges_data.event_mappings
  GROUP BY canonical_event_id HAVING COUNT(DISTINCT exchange_id) > 1
) AND pm.status = 'Open';
-- Target: match_rate_pct > 85%

-- 3. Verify no asymmetric matches
SELECT outcome_side, COUNT(*) as count
FROM direct_exchanges_data.market_mappings
GROUP BY outcome_side;
-- Expected: YES and NO counts roughly equal
```

---

## Notes

- The original investigation report with full problem descriptions, real-world examples (Greenland acquisition, World Leaders mega-event, Fed rate decisions), and pseudocode is preserved in `investigation-report.md` in this same directory.
- Fix 4 (auto-match both sides) was already implemented in the existing code — `matchMarketsForSinglePair()` writes 4 rows (YES+NO per exchange). Only the SQL backfill for old asymmetric data was needed.
- Fix 3d (lower threshold for same-event markets) was not implemented separately because the existing within-event matching already bypasses the pre-filter for same-event markets.
- Phase 2 cross-event matching handles both Fix 6 (date variants) and Fix 7 (mega-events) with the same approach: extract entity from unmatched Kalshi markets, search Polymarket by entity name, AI-verify matches.
