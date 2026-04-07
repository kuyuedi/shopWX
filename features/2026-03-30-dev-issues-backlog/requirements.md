# Feature: Dev Issues Backlog - Remaining Fixes

**Status**: NEW
**Priority**: High
**Created**: 2026-03-30

---

## Summary

Four issues from the dev issues backlog require permanent fixes: two predict-listener data quality bugs (hotfixed), one new post-match validation feature, and one API performance optimization.

---

## Issue Triage

| # | Issue | Severity | Current Status | Action |
|---|-------|----------|---------------|--------|
| #1 | predict-listener does not populate `prediction_markets.price` | High | Hotfix (COALESCE fallback in API) | Permanent fix in predict-listener |
| #2 | Predict `price_close` in `market_latest_data` is inverted/unreliable | High | Hotfix (API uses `reference_price` instead) | Root cause fix in predict-listener |
| #3 | Markets API missing Predict in exchangeMap | Medium | **Fixed and deployed** | None |
| #4 | Events API wrong exchange key (pred vs pre) | High | **Fixed and deployed** | None |
| #5 | Predict+Polymarket-only markets missing from market_titles | Medium | **Resolved** | None |
| #6 | Post-match validation layer for false positive detection | High | Open | Design + implement |
| #7 | NRFI baseball markets incorrectly matched | Medium | **Fixed and deployed** | None |
| #8 | Market detail page slow for large events | Medium | Partially fixed | Parallelize remaining queries |

---

## Issue #1: Predict price not populated

### Problem

All Predict markets have `NULL` in `prediction_markets.price`. Kalshi and Polymarket listeners populate this field during market sync from their REST APIs, but predict-listener's `normalizeMarkets()` sets `price: undefined` with a comment "filled by WS". The Predict categories API does not include price data, and the WS only provides orderbook data — there is no mechanism that actually fills this field.

### Current Hotfix

API endpoints use `COALESCE(pm.price, mld.reference_price, mld.band_vwap_bid)` fallback in `events.ts`, `outcomeAssembler.ts`, `tickerBuilder.ts`, and `marketDetail.ts`.

### Solution

Populate `prediction_markets.price` during each market sync cycle using the best available price from `market_latest_data`. After upserting markets, query `market_latest_data` for all Predict markets and update `prediction_markets.price` with `COALESCE(reference_price, band_vwap_bid)`.

### Algorithm

```
1. normalizeMarkets() runs as-is (price stays undefined for initial upsert)
2. After upsertPredictionMarketsBatch(), run a SQL UPDATE:
   UPDATE prediction_markets pm
   SET price = COALESCE(mld.reference_price, mld.band_vwap_bid)
   FROM market_latest_data mld
   WHERE pm.source_id = mld.source_id
     AND pm.exchange_id = mld.exchange_id
     AND pm.market_id = mld.market_id
     AND pm.outcome_side = mld.outcome_side
     AND pm.exchange_id = 'PREDICT'
     AND pm.price IS DISTINCT FROM COALESCE(mld.reference_price, mld.band_vwap_bid)
     AND COALESCE(mld.reference_price, mld.band_vwap_bid) IS NOT NULL
3. Log how many rows were updated
```

### Files to Modify

| File | Change |
|------|--------|
| `packages/predict-listener/src/services/marketSync.ts` | Add price backfill query after market upsert |
| `packages/shared/src/db/queries.ts` | Add `backfillPredictPrices()` query function |

### API Limitation

Unlike Kalshi (`last_price`) and Polymarket (`outcomePrices`), the Predict REST API (`/v1/categories`) does not return any price fields. The backfill from `market_latest_data` is the best available approach. Markets that have never received a WS orderbook update will retain `NULL` price — these are typically inactive/illiquid markets.

### Acceptance Criteria

- [x] `prediction_markets.price` is populated for Predict YES and NO markets after each sync
- [x] Price uses `reference_price` (orderbook midpoint), falling back to `band_vwap_bid`
- [x] Markets with no `market_latest_data` retain `NULL` price (no fake values)
- [x] Existing COALESCE hotfixes in API can be kept as defense-in-depth

---

## Issue #2: Predict price_close inverted/unreliable

### Problem

`price_close` for Predict markets stores inverted or incorrect values. Example: OKC Thunder YES shows `price_close=0.63` when correct is ~0.37. Additionally, 86 markets have `price_close >= 1.0`.

### Root Cause

In `handlers.ts` lines 112-135, `handleOrderbookPush` writes `price_close` from `lastOrderSettled`:

```typescript
const outcome = data.lastOrderSettled.outcome;
const yesPrice = outcome === 'No' ? 1 - tradePrice : tradePrice;
```

The bug: `lastOrderSettled.outcome` values from the Predict API are `"Yes"` and `"No"` (capitalized), but the code checks for `'No'`. This part actually works. However, the real issue is that `lastOrderSettled.price` represents the price **of the specific outcome that traded**, not the YES price. When a YES outcome trades at 0.37:
- `outcome = "Yes"`, `tradePrice = 0.37`
- `yesPrice = 0.37` (correct)

When a NO outcome trades at 0.63:
- `outcome = "No"`, `tradePrice = 0.63`
- `yesPrice = 1 - 0.63 = 0.37` (correct)

The math appears correct for "Yes"/"No" values. However, the **root cause** is that `lastOrderSettled.outcome` can contain the **outcome name** (e.g., "Oklahoma City Thunder") instead of "Yes"/"No" for named-outcome markets. When the outcome is unrecognized, the old code defaulted to treating it as YES-side, causing inversion: a NO-side trade at 0.63 would be written as YES price_close=0.63 (should be 0.37).

### Solution

1. Add price range validation: reject `price_close` values outside [0, 1]
2. **Skip `price_close` write entirely** when outcome is not "Yes"/"No"/"YES"/"NO" — prevents inversion from unrecognized outcome names
3. Add diagnostic logging with `outcome`, `side`, and `kind` fields to understand actual API behavior
4. Once diagnostic data confirms the `outcome` field format, a future fix can map outcome names to YES/NO using market metadata

### Algorithm

```
1. Parse tradePrice from lastOrderSettled.price
2. Validate: if tradePrice < 0 or tradePrice > 1, log warning and skip
3. Check outcome: if not "Yes"/"No"/"YES"/"NO", log warning with full context and SKIP
4. If recognized: calculate yesPrice / noPrice normally
5. Write price_close for both sides
```

### Files to Modify

| File | Change |
|------|--------|
| `packages/predict-listener/src/websocket/handlers.ts` | Add price validation, clamping, and logging in `handleOrderbookPush` |

### Acceptance Criteria

- [x] No `price_close` values outside [0, 1] range are written
- [x] Unexpected `outcome` values are logged as warnings with `side`, `kind` fields
- [x] Unrecognized outcomes skip `price_close` write entirely (prevents inversion)
- [x] Existing data with `price_close >= 1.0` verified clean (0 records found post-deploy)

---

## Issue #6: Post-match validation layer

### Problem

The AI event matcher produces false matches when markets have similar wording but different qualifying conditions. Making the AI prompt stricter would miss legitimate matches. A post-match validation layer is needed to catch specific patterns of false positives.

### False Positive Patterns

| Pattern | Example |
|---------|---------|
| Year/date mismatch | "Trump before 2028" vs "Trump before 2027" |
| Entity inversion | "Dem 51 seats" vs "Rep 51 seats" |
| Superlative mismatch | "Hottest year" vs "Third-hottest year" |
| Qualifier mismatch | "Orban leave PM" vs "Next leader out" |
| Expiry date divergence | Markets with same topic but different resolution dates |

### Solution

Create `postMatchValidator.ts` that runs after AI verification confirms a match but before writing to the database. The validator performs deterministic checks that catch patterns the AI tends to miss.

### Algorithm

```
1. Extract structured data from both titles:
   - Years/dates (regex: /\b(20\d{2})\b/, /\b(Q[1-4])\b/, month names)
   - Entities (party names, team names, person names)
   - Superlatives (first, second, third, hottest, coldest, most, least)
   - Numeric thresholds (e.g., "51 seats", "above 3.5%")

2. Run validation checks:
   a. YEAR_MISMATCH: If both titles contain years and they differ → REJECT
   b. ENTITY_INVERSION: If both titles contain opposing entities
      (Democrat/Republican, Yes/No team swap) → REJECT
   c. SUPERLATIVE_MISMATCH: If both contain superlatives that differ
      (hottest vs third-hottest) → REJECT
   d. THRESHOLD_MISMATCH: If both contain numeric thresholds that differ
      (51 seats vs 52 seats, above 3% vs above 4%) → REJECT
   e. EXPIRY_DIVERGENCE: If resolution dates differ by > 30 days → REJECT

3. Return: { valid: boolean, reason?: string, check?: string }

4. On REJECT: log the rejection with details, skip DB write
```

### Insertion Point

In `marketMatcher.ts`, after `verifyMarketMatch()` returns a positive result and before `upsertMarketMappingsBatch()`:

```typescript
// After AI verification says "match"
const validation = validateMatch(sourceTitle, targetTitle);
if (!validation.valid) {
  logger.info({ source: sourceTitle, target: targetTitle, reason: validation.reason },
    'Post-match validator rejected match');
  continue; // skip this match
}
```

Also insert in `matchingCycle.ts` after `compareEvents()` result for event-level matches (with end_date params).

### Files to Create/Modify

| File | Change |
|------|--------|
| `packages/event-matcher/src/services/postMatchValidator.ts` | **New** — validation logic with 5 checks |
| `packages/event-matcher/src/services/marketMatcher.ts` | Insert validator after modifier guard |
| `packages/event-matcher/src/services/matchingCycle.ts` | Insert validator after event comparison (with end_dates) |

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| No years in either title | Skip year check, pass |
| Year in only one title | Skip year check, pass (could be implicit) |
| Same year in both | Pass |
| "2028 or later" vs "2028" | Pass (contains matching year) |
| Ordinal numbers (1st, 2nd) | Treat as superlatives |
| Entity appears in both (e.g., "Biden" in both) | Pass — inversion requires opposing entities |

### Acceptance Criteria

- [x] Year/date mismatches between titles cause rejection
- [x] Entity inversions (party/team swaps) cause rejection
- [x] Superlative mismatches cause rejection
- [x] Threshold divergences cause rejection
- [x] Expiry date divergence (>30 days) causes rejection for event-level matches
- [x] Validator runs for both event-level and market-level AI matches
- [x] Rejections are logged with source/target titles and reason
- [x] Legitimate matches are not blocked (low false-negative rate)
- [x] Validator is deterministic (no AI calls)

---

## Issue #8: Market detail endpoint parallelization

### Problem

`handleEventDetail()` in `marketDetail.ts` runs 3+ independent DB queries sequentially. The `allMarkets` and `eventResult` queries are completely independent but block each other. The 3 translation queries (when `lang !== 'en'`) are also independent of each other.

### Current State

Phase 1+2 already completed:
- CTE optimization reduced query time
- 30s response cache with stale-while-revalidate
- Removed orderbook batch query (was the main bottleneck)
- Result: 29.9s → 1.45s cold, 0.37s cached for large events

### Solution

Parallelize the remaining sequential queries using `Promise.all`:

1. **Primary queries** (lines 147-211): Run `allMarkets` and `eventResult` concurrently
2. **Translation queries** (lines 319-336): Run all 3 `getTranslations()` calls concurrently

### Algorithm

```
// Before (sequential):
const allMarkets = await queryWithPool(...);     // ~1ms
const eventResult = await queryWithPool(...);    // ~1ms
// ... processing ...
const titleTranslations = await getTranslations(...);     // ~1ms
const ruleTranslations = await getTranslations(...);      // ~1ms
const eventTitleTranslations = await getTranslations(...); // ~1ms

// After (parallel):
const [allMarkets, eventResult] = await Promise.all([
  queryWithPool(...),
  queryWithPool(...)
]);
// ... processing ...
const [titleTranslations, ruleTranslations, eventTitleTranslations] = await Promise.all([
  getTranslations(...),
  getTranslations(...),
  getTranslations(...)
]);
```

### Files to Modify

| File | Change |
|------|--------|
| `packages/homepage-api/src/routes/marketDetail.ts` | Wrap independent queries in `Promise.all` |

### Acceptance Criteria

- [x] `allMarkets` and `eventResult` queries run in parallel (handleEventDetail)
- [x] All 3 translation queries run in parallel (handleEventDetail)
- [x] CM-xxx single-market: queries 2/3/4 run in parallel after mappings query
- [x] CM-xxx single-market: events + related queries run in parallel after markets query
- [x] No behavioral change — same response format
- [ ] Cold response time for large events (Dem nominee 2028) under 1s from server

**Note**: `handleEventHistory` has 2 queries with a hard dependency (Q2 needs Q1 output) — cannot be parallelized.

---

## Implementation Order

1. **Issue #8** (Quick win) — Simple `Promise.all` refactor, 15min
2. **Issue #2** (Quick win) — Add price validation/clamping, 15min
3. **Issue #1** (Medium) — Add price backfill query to marketSync, 30min
4. **Issue #6** (Large) — Design + implement postMatchValidator, 2-3hr

---

## Notes

- Issues #3, #4, #5, #7 are fully resolved and require no further action
- The COALESCE hotfixes in the API layer (#1, #2) should be kept as defense-in-depth even after permanent fixes
- Issue #6 is the most impactful — false positive matches directly affect arb quality
- Source document: `Dev Issues Backlog - Updated.docx` (March 30, 2026)
