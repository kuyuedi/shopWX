# Feature: Phase 1.5 — Market Re-Match Backfill

**Status**: NEW
**Priority**: P0
**Created**: 2026-03-18

---

## Summary

Re-run `matchMarketsForSinglePair()` for all existing matched event pairs that still have unmatched markets, using the improved matching code (Fix 3: synonym normalization, accent stripping, entity extraction).

---

## Problem

Market matching only runs at the exact moment an event pair is first matched (inline in `matchingCycle.ts` line 196). There is no mechanism to re-run it later. Events matched weeks ago used the old matching code, so hundreds of markets within correctly-matched events failed to pair due to:

1. **Synonym mismatches** — "cut" vs "decrease", "hike" vs "increase" produce Jaccard = 0.0, falling below the 0.3 AI threshold. Pair silently dropped.
2. **Accent mismatches** — "São Paulo" vs "Sao Paulo" fails substring match due to Unicode differences.
3. **Entity extraction missing** — Kalshi "Question? — Adam Miller" pattern wasn't extracted and matched against Poly titles.

Fix 3 (deployed) solves all three, but only for newly matched events. Old event pairs never get re-processed.

---

## Solution

A one-time backfill script that:

1. Queries `event_mappings` to find all matched event pairs where both sides still have unmatched markets
2. Calls `matchMarketsForSinglePair()` for each pair — the same function used during normal matching
3. The improved code (Fix 3) is already deployed, so substring/Jaccard/AI tiers now handle synonyms, accents, and entity names

No new matching logic needed. Just re-running the existing function over old event pairs.

---

## Algorithm / Logic

```
1. Query event_mappings joined with prediction_markets and market_mappings
2. Find pairs where:
   - Both Kalshi and Polymarket sides have unmatched YES-side open markets
   - The event pair already exists in event_mappings (canonical_event_id links them)
3. Sort by most unmatched markets first (biggest impact)
4. For each pair, call matchMarketsForSinglePair(kalshiSourceId, kalshiEventId, polySourceId, polyEventId, config)
5. matchMarketsForSinglePair runs the existing 4-tier pipeline:
   - Tier 0: Binary (1:1) — auto-match if single market per side
   - Tier 1: Substring — extract name after "—", check if in Poly title (NOW with accent stripping)
   - Tier 2: Jaccard ≥ 0.85 — auto-accept (NOW with synonym normalization)
   - Tier 3: Jaccard 0.3–0.85 — AI verify (NOW with improved GPT rejection criteria)
6. Already-matched markets are automatically skipped (fetchExistingMappedMarketIds)
7. Each match writes 4 rows to market_mappings (YES+NO per exchange)
```

---

## Configuration

No new configuration. Uses existing event-matcher config:

| Parameter | Description | Default |
|-----------|-------------|---------|
| `MARKET_MATCH_THRESHOLD` | Jaccard auto-accept threshold | `0.85` |
| `MARKET_MATCH_AI_THRESHOLD` | Min Jaccard to trigger AI verification | `0.3` |
| `OPENAI_MODEL` | Model for AI verification | `gpt-5-nano` |

---

## Input Data

| Source | Table/API | Fields Used |
|--------|-----------|-------------|
| Matched event pairs | `event_mappings` | `event_id`, `exchange_id`, `source_id`, `canonical_event_id` |
| Markets in those events | `prediction_markets` | `market_id`, `event_id`, `title`, `outcome_name`, `outcome_side`, `status`, `price` |
| Already-matched markets | `market_mappings` | `market_id`, `outcome_side` (for dedup) |

---

## Output Data

| Table | Field | Type | Description |
|-------|-------|------|-------------|
| `market_mappings` | 4 rows per match | — | YES+NO per exchange, linked by `canonical_market_id` |
| `market_mappings` | `model_id` | varchar | `substring-v1`, `algorithmic-v1`, or `ai-verified-v1` |
| `market_mappings` | `confidence_score` | numeric | 1.0 for substring/binary, Jaccard score for algorithmic, AI confidence for verified |
| `market_titles` | `generated_title` | varchar | Display title from Kalshi outcome_name or title |

---

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| Event pair has unmatched markets only on one side | Skip — both sides must have unmatched markets |
| All markets already matched in a pair | Skip — fetchExistingMappedMarketIds filters them out |
| Script interrupted mid-run | Safe to re-run — already-matched markets are skipped, no duplicates |
| AI rate limit hit during Tier 3 | Existing rate limiter in aiComparer.ts handles this automatically |
| Market closed between event match and backfill | fetchMarketsForEvent filters by status = 'Open' |
| Jaccard auto-accept produces false positive | Mitigated by threshold raised to 0.85 (Fix 2) |

---

## Acceptance Criteria

- [ ] Backfill script finds all matched event pairs with unmatched markets on both sides
- [ ] Script calls `matchMarketsForSinglePair()` for each pair (no custom matching logic)
- [ ] Already-matched markets are not duplicated
- [ ] Script logs progress every 50 pairs and final totals
- [ ] Match rate increases from ~56% to 85%+ after backfill
- [ ] YES and NO side counts remain roughly equal
- [ ] Script can be safely re-run without side effects

---

## Examples

### Example 1: Synonym Match (Fed Rate — "cut" vs "decrease")

**Event pair:** Fed Rate Decision (Kalshi) ↔ Fed Rate Decision (Polymarket) — already matched

**Kalshi market:** `Federal Funds Rate Decision: Cut 25bps`
**Polymarket market:** `Will the Fed decrease interest rates by 25 bps?`

**Old run (weeks ago):** No synonym normalization. Jaccard("cut 25bps", "decrease interest rates 25 bps") = 0.0. Below 0.3 threshold. Silently dropped. **NOT MATCHED.**

**Backfill with Fix 3:** "cut" → "decrease" via synonym map. Jaccard jumps to ~0.40. Enters Tier 3. AI verifies → **MATCHED.** Cost: $0.001.

### Example 2: Accent Match (Sports — "São" vs "Sao")

**Event pair:** São Paulo vs Palmeiras (Kalshi) ↔ São Paulo match (Polymarket) — already matched

**Kalshi market:** `Sao Paulo vs Palmeiras? — Sao Paulo`
**Polymarket market:** `Will São Paulo FC win on 2026-03-21?`

**Old run:** Substring extracts "Sao Paulo", checks Poly title. "Sao" ≠ "São" in Unicode. **NOT MATCHED.**

**Backfill with Fix 3:** `stripAccents("São")` → "Sao". Substring match succeeds. **MATCHED.** Cost: FREE.

### Example 3: Entity Extraction (LA Mayor — "Adam Miller")

**Event pair:** LA Mayor Race (Kalshi) ↔ LA Mayoral Election (Polymarket) — already matched

**Kalshi market:** `Who will win Los Angeles Mayoral Election? — Adam Miller`
**Polymarket market:** `Will Adam Miller win the 2026 Los Angeles mayoral election?`

**Old run:** Sentence structures too different. Jaccard = 0.15. Below 0.3. Silently dropped. **NOT MATCHED.**

**Backfill with Fix 3:** Substring extracts "Adam Miller", found in Poly title. **MATCHED.** Cost: FREE.

---

## Cost Estimate

| Matching tier | % of markets | Cost per match | Subtotal |
|---|---|---|---|
| Tier 0: Binary (1:1) | ~10% | Free | $0 |
| Tier 1: Substring (entity match) | ~50% | Free | $0 |
| Tier 2: Jaccard ≥ 0.85 auto-accept | ~20% | Free | $0 |
| Tier 3: Jaccard 0.3–0.85 + AI verify | ~20% | ~$0.001 | ~$10–30 |
| **Total** | | | **$10–30** |

Compare with full event re-match from scratch: $200–500+.

---

## Verification Queries

```sql
-- 1. Match rate after backfill
SELECT
  COUNT(*) AS total_markets,
  COUNT(mm.canonical_market_id) AS matched,
  ROUND(100.0 * COUNT(mm.canonical_market_id) / NULLIF(COUNT(*), 0), 1) AS match_rate_pct
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

-- 2. Matches by model (shows which tier resolved them)
SELECT model_id, COUNT(*) AS matches
FROM direct_exchanges_data.market_mappings
GROUP BY model_id ORDER BY matches DESC;
-- Expect growth in substring-v1 and algorithmic-v1

-- 3. YES/NO balance
SELECT outcome_side, COUNT(*) FROM direct_exchanges_data.market_mappings
GROUP BY outcome_side;
-- YES and NO counts should be roughly equal
```

---

## What This Does NOT Fix

Phase 1.5 re-runs matching within existing event pairs. These cross-event problems still need Phase 2:

| Problem | Example | Why Phase 1.5 can't fix |
|---|---|---|
| Mega-events | Kalshi "World Leaders" (66 markets) → Poly splits per leader | Petro's Poly event is not paired with Kalshi's mega-event |
| Date variants across events | Kalshi "Greenland before 2027" → Poly has separate event per date | Different events on each exchange, no event pair exists |

**Execution order:** Phase 1.5 first (cheap, ~80% of unmatched), then Phase 2 for remaining cross-event cases (~20%).

---

## Notes

- The backfill script is safe to re-run multiple times — `matchMarketsForSinglePair` skips already-matched markets via `fetchExistingMappedMarketIds()`.
- No database migrations required. Uses existing `market_mappings` and `market_titles` tables.
- Fix 3 (synonym normalization, accent stripping, entity extraction) must be deployed before running the backfill. It was merged in commit `ade086a`.
- The script processes pairs sequentially (not concurrent) to respect AI rate limits. For ~200-500 pairs, expected runtime is 10-30 minutes.
