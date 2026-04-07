# Dev Issues Backlog — Final Report

**Date**: 2026-03-30
**Status**: All 8 issues addressed
**Commits**: `926e278`, `ee13662`, `ad177be`

---

## Issue Summary

| # | Issue | Severity | What Was Done | Deployed |
|---|-------|----------|---------------|----------|
| #1 | Predict price not populated | High | Added `backfillPredictPrices()` to sync cycle; populates price from `market_latest_data` after each market upsert | Yes |
| #2 | Predict price_close inverted | High | Added price range validation; identified root cause (outcome names vs "Yes"/"No"); skip write on unrecognized outcomes to prevent inversion | Yes |
| #3 | Markets API missing Predict | Medium | Added `pre`/`pred` → `PREDICT` and `opinion` → `OPINIONTRADE` to exchangeMap in `/api/v1/markets` | Previously deployed |
| #4 | Events API wrong exchange key | High | Changed EXCHANGE_KEY from `PREDICT: 'pred'` to `PREDICT: 'pre'` in `events.ts` | Previously deployed |
| #5 | Predict+Poly missing market_titles | Medium | Verified `upsertMarketTitleWithExchanges()` already handles all pair combinations; Predict+Poly titles created on next matching cycle | Previously verified |
| #6 | Post-match validation layer | High | Created `postMatchValidator.ts` with 5 deterministic checks (year, entity, superlative, threshold, expiry); integrated into both event and market matching | Yes |
| #7 | NRFI baseball false matches | Medium | Added NRFI pattern detection to `classifyMarketType()`; cleaned up stale false matches via `match_reviews` | Previously deployed |
| #8 | Market detail page slow | Medium | Parallelized `handleEventDetail` (2 query groups), CM-xxx handler (6→3 stages), and translation queries with `Promise.all` | Yes |

---

## Detailed Resolutions

### Issue #1: predict-listener does not populate prediction_markets.price

**Root cause**: The Predict REST API (`/v1/categories`) does not return any price fields — unlike Kalshi (`last_price`) and Polymarket (`outcomePrices`).

**Fix applied**:
- Added `backfillPredictPrices()` query in `packages/shared/src/db/queries.ts`
- Called after every market sync in `packages/predict-listener/src/services/marketSync.ts`
- Populates `prediction_markets.price` from `market_latest_data` using `COALESCE(reference_price, band_vwap_bid)`
- Uses `IS DISTINCT FROM` to skip unchanged rows on subsequent syncs

**Production result**: 1,164 prices populated. 842 remain NULL — these are markets that have never received a WS orderbook update (inactive/illiquid). NULL is the correct representation; the API-layer COALESCE fallback remains as defense-in-depth.

**Files changed**:
- `packages/shared/src/db/queries.ts` — new `backfillPredictPrices()` function
- `packages/predict-listener/src/services/marketSync.ts` — calls backfill after upsert

---

### Issue #2: Predict price_close inverted / unreliable

**Root cause**: `lastOrderSettled.outcome` can contain the **outcome name** (e.g., "Oklahoma City Thunder") instead of "Yes"/"No" for named-outcome markets. When unrecognized, the old code defaulted to treating the trade as YES-side, causing inversion — a NO-side trade at 0.63 would be written as YES `price_close=0.63` (should be 0.37).

**Fix applied**:
1. Price range validation: reject `tradePrice < 0` or `> 1` with warning
2. Outcome case normalization: handles "Yes"/"No"/"YES"/"NO"
3. **Unrecognized outcomes skip `price_close` write entirely** — prevents inversion
4. Diagnostic logging with `outcome`, `side`, `kind` fields for future investigation

**Production result**: 0 invalid `price_close` values. All YES+NO price pairs sum to exactly 1.0.

**Files changed**:
- `packages/predict-listener/src/websocket/handlers.ts` — validation, skip on unrecognized outcome

---

### Issue #3: Markets API endpoint missing Predict in exchangeMap

**Problem**: The `/api/v1/markets` endpoint only recognized `kal` and `poly` in its exchange filter map. Predict and Opinion markets were invisible to the API.

**Fix applied** (prior to this sprint):
- Added `pre` and `pred` → `PREDICT` to exchangeMap in `packages/homepage-api/src/routes/markets.ts`
- Added `opinion` → `OPINIONTRADE` to the same map
- Frontend can now filter markets by Predict exchange

---

### Issue #4: Events API sent wrong exchange key (pred vs pre)

**Problem**: The events API `EXCHANGE_KEY` map sent `pred` for Predict, but the frontend expects `pre`.

**Fix applied** (prior to this sprint):
- Changed `PREDICT: 'pred'` to `PREDICT: 'pre'` in `packages/homepage-api/src/routes/events.ts`
- Events API response now uses the correct exchange key matching the frontend

---

### Issue #5: Predict+Polymarket-only markets missing from market_titles

**Problem**: Markets matched only between Predict and Polymarket (no Kalshi leg) had no `market_titles` row, meaning they could not be translated to Chinese.

**Fix verified** (prior to this sprint):
- `marketMatcher.ts` line 664 calls `upsertMarketTitleWithExchanges()` for ALL exchange pair combinations, not just Kalshi combos
- `market_titles` entries are created automatically for Predict+Polymarket-only canonical markets during matching
- Existing Predict+Polymarket markets without titles get titles on next matching cycle

---

### Issue #6: Post-match validation layer for false positive detection

**Fix applied**: Created `postMatchValidator.ts` with 5 deterministic checks:

| Check | Description | Example |
|-------|-------------|---------|
| `YEAR_MISMATCH` | Both titles contain years with no overlap | "Trump before 2028" vs "Trump before 2027" |
| `ENTITY_INVERSION` | Opposing political/financial entities | "Dem 51 seats" vs "Rep 51 seats" |
| `SUPERLATIVE_MISMATCH` | Different ordinals/superlatives | "Hottest year" vs "Third-hottest year" |
| `THRESHOLD_MISMATCH` | Different numeric thresholds | "Fed rate above 3.5%" vs "Fed rate above 4%" |
| `EXPIRY_DIVERGENCE` | End dates differ by >30 days | Event ending March vs event ending June |

**Integration points**:
- `marketMatcher.ts` — runs after modifier guard, before DB write (market-level)
- `matchingCycle.ts` — runs after `compareEvents()`, before transitive grouping (event-level, with end_date params)

**Production result**: Validator active across all 5 exchange pairs. No false rejections observed. Recent matches show max 1-day expiry difference (weather markets).

**Files changed**:
- `packages/event-matcher/src/services/postMatchValidator.ts` — new file, 5 checks
- `packages/event-matcher/src/services/marketMatcher.ts` — validator integration
- `packages/event-matcher/src/services/matchingCycle.ts` — validator integration with end_dates

---

### Issue #7: NRFI baseball markets incorrectly matched

**Problem**: NRFI (No Run First Inning) markets on Polymarket were matched to moneyline Winner markets on Kalshi. These are fundamentally different bet types — NRFI is a prop bet about the first inning, not a game outcome.

**Fix applied** (prior to this sprint):
- Added NRFI pattern detection (`/\bnrfi\b/i`, `/no run first inning/i`) to `classifyMarketType()` in `packages/event-matcher/src/services/marketMatcher.ts`
- NRFI markets are now classified as `FIRST_HALF` type, which is incompatible with `WIN` type — preventing false matches
- Existing false matches were unmatched via `match_reviews` table

---

### Issue #8: Market detail page slow for large events

**Fix applied**: Full parallelization across all handlers in `marketDetail.ts`:

**handleEventDetail (CE-xxx)**:
- Stage 1: `allMarkets` + `eventResult` in `Promise.all` (were sequential)
- Stage 2: 3 translation queries in `Promise.all` (were sequential)

**Single-market detail (CM-xxx)**:
- Stage 1: `mappingsResult` (required by all others)
- Stage 2: `marketsResult` + `mldResult` + `titleResult` in `Promise.all` (were sequential)
- Stage 3: `eventsResult` + `relResult` in `Promise.all` (were sequential)

**handleEventHistory**: Not changed — its 2 queries have a hard dependency (Q2 needs Q1 output).

**Production result**: CE-xxx (20-outcome event) responds in 29ms. CM-xxx responds in 49ms.

**Files changed**:
- `packages/homepage-api/src/routes/marketDetail.ts` — Promise.all parallelization

---

## Production Verification (2026-03-30)

| Metric | Value |
|--------|-------|
| Predict prices populated | 1,164 |
| Predict prices NULL (no WS data) | 842 |
| Invalid price_close (out of 0-1) | 0 |
| YES+NO price sum != 1.0 | 0 rows |
| CE-xxx response time | 29ms |
| CM-xxx response time | 49ms |
| Arb scanner | 15 arbs/scan, 3,464 markets, 11,484 legs |
| Smoke tests | 10/10 passed |
| All containers healthy | 6/7 (opinion-listener restarting — pre-existing, unrelated) |

---

## Files Changed (All Commits)

| File | Issues |
|------|--------|
| `packages/shared/src/db/queries.ts` | #1 |
| `packages/predict-listener/src/services/marketSync.ts` | #1 |
| `packages/predict-listener/src/websocket/handlers.ts` | #2 |
| `packages/event-matcher/src/services/postMatchValidator.ts` | #6 (new) |
| `packages/event-matcher/src/services/marketMatcher.ts` | #6 |
| `packages/event-matcher/src/services/matchingCycle.ts` | #6 |
| `packages/homepage-api/src/routes/marketDetail.ts` | #8 |
