# Verification Plan: Dev Issues Backlog Fixes

Step-by-step verification for each fix, including pre-deploy checks, deployment, and post-deploy validation.

---

## Pre-Deploy: Build Verification

All packages must compile cleanly before deploying.

```bash
pnpm build
```

Expected: `shared`, `event-matcher`, `predict-listener` all pass. (`homepage-api` has a pre-existing unrelated openai type error.)

---

## Issue #8: Market Detail Query Parallelization

**Package**: `homepage-api`
**Files changed**: `packages/homepage-api/src/routes/marketDetail.ts`
**Deploy script**: `./deploy.sh` (or homepage-api deploy)

### Pre-deploy verification

Confirm no behavioral change — same response format, just faster:

```bash
# Test locally with a large event (Dem nominee 2028)
curl -s "http://localhost:3000/api/v1/market-detail/CE-xxxxxxxxxx?lang=en" | jq '.outcomes | length'
curl -s "http://localhost:3000/api/v1/market-detail/CE-xxxxxxxxxx?lang=zh" | jq '.translations'
```

### Post-deploy verification

```bash
# SSH to server and check response time
ssh root@8.216.43.26 "time curl -s http://localhost:3000/api/v1/market-detail/CE-xxxxxxxxxx > /dev/null"
```

**Pass criteria**:
- [ ] Response format unchanged (same fields, same values)
- [ ] Non-English translations still return correctly
- [ ] Cold response time for large events under 1.5s

---

## Issue #2: Predict price_close Validation

**Package**: `predict-listener`
**Files changed**: `packages/predict-listener/src/websocket/handlers.ts`
**Deploy script**: `./deploy-predict.sh`

### Pre-deploy: Check current bad data

```sql
-- Count records with invalid price_close
SELECT COUNT(*)
FROM direct_exchanges_data.market_latest_data
WHERE exchange_id = 'PREDICT' AND (price_close < 0 OR price_close > 1);

-- Sample the bad records
SELECT market_id, outcome_side, price_close
FROM direct_exchanges_data.market_latest_data
WHERE exchange_id = 'PREDICT' AND (price_close < 0 OR price_close > 1)
LIMIT 20;
```

### Post-deploy: Clean up bad data

```sql
-- Null out invalid price_close values (will be repopulated by next WS update)
UPDATE direct_exchanges_data.market_latest_data
SET price_close = NULL
WHERE exchange_id = 'PREDICT' AND (price_close < 0 OR price_close > 1);
```

### Post-deploy: Verify fix is working

```bash
# Check predict-listener logs for validation warnings
ssh root@8.216.43.26 "docker compose -f /opt/prediction-market-ingestion/docker-compose.yml logs --tail 200 predict-listener | grep -E 'Invalid lastOrderSettled|Unexpected lastOrderSettled'"
```

```sql
-- Verify no new invalid values appear (run after 10+ minutes)
SELECT COUNT(*)
FROM direct_exchanges_data.market_latest_data
WHERE exchange_id = 'PREDICT' AND (price_close < 0 OR price_close > 1);
```

**Pass criteria**:
- [ ] No new `price_close` values outside [0, 1] after deploy
- [ ] Existing bad data cleaned up (query returns 0)
- [ ] Any unexpected outcome values logged as warnings

---

## Issue #1: Predict Price Backfill

**Package**: `predict-listener`, `shared`
**Files changed**: `packages/shared/src/db/queries.ts`, `packages/predict-listener/src/services/marketSync.ts`
**Deploy script**: `./deploy-predict.sh`

### Pre-deploy: Check current state

```sql
-- Count Predict markets with NULL price
SELECT outcome_side, COUNT(*) as null_price_count
FROM direct_exchanges_data.prediction_markets
WHERE exchange_id = 'PREDICT' AND price IS NULL AND status = 'Open'
GROUP BY outcome_side;

-- Count Predict markets that HAVE market_latest_data (eligible for backfill)
SELECT COUNT(DISTINCT pm.market_id)
FROM direct_exchanges_data.prediction_markets pm
JOIN direct_exchanges_data.market_latest_data mld
  ON pm.source_id = mld.source_id AND pm.exchange_id = mld.exchange_id
  AND pm.market_id = mld.market_id AND pm.outcome_side = mld.outcome_side
WHERE pm.exchange_id = 'PREDICT' AND pm.price IS NULL
  AND COALESCE(mld.reference_price, mld.band_vwap_bid) IS NOT NULL;
```

### Post-deploy verification

```bash
# Check predict-listener logs for backfill message
ssh root@8.216.43.26 "docker compose -f /opt/prediction-market-ingestion/docker-compose.yml logs --tail 100 predict-listener | grep 'Backfilled prediction_markets.price'"
```

```sql
-- After one sync cycle (~5 min), verify prices are populated
SELECT outcome_side, COUNT(*) as null_price_count
FROM direct_exchanges_data.prediction_markets
WHERE exchange_id = 'PREDICT' AND price IS NULL AND status = 'Open'
GROUP BY outcome_side;

-- Verify the backfilled prices look reasonable
SELECT pm.market_id, pm.outcome_side, pm.price, mld.reference_price, mld.band_vwap_bid
FROM direct_exchanges_data.prediction_markets pm
JOIN direct_exchanges_data.market_latest_data mld
  ON pm.source_id = mld.source_id AND pm.exchange_id = mld.exchange_id
  AND pm.market_id = mld.market_id AND pm.outcome_side = mld.outcome_side
WHERE pm.exchange_id = 'PREDICT' AND pm.price IS NOT NULL
ORDER BY pm.updated_at DESC
LIMIT 20;

-- Confirm YES + NO prices sum to ~1.0 for same market
SELECT pm1.market_id, pm1.price as yes_price, pm2.price as no_price,
       pm1.price + pm2.price as total
FROM direct_exchanges_data.prediction_markets pm1
JOIN direct_exchanges_data.prediction_markets pm2
  ON pm1.market_id = pm2.market_id AND pm1.exchange_id = pm2.exchange_id
WHERE pm1.exchange_id = 'PREDICT'
  AND pm1.outcome_side = 'YES' AND pm2.outcome_side = 'NO'
  AND pm1.price IS NOT NULL AND pm2.price IS NOT NULL
ORDER BY pm1.updated_at DESC
LIMIT 20;
```

**Pass criteria**:
- [ ] Log message shows "Backfilled prediction_markets.price" with count > 0 on first run
- [ ] NULL price count drops significantly after first sync
- [ ] Backfilled prices match `reference_price` or `band_vwap_bid` values
- [ ] YES + NO prices for same market sum to approximately 1.0
- [ ] Markets without `market_latest_data` still have NULL price (no fake values)
- [ ] Subsequent sync cycles show fewer updates (only changed prices)

---

## Issue #6: Post-Match Validation Layer

**Package**: `event-matcher`
**Files changed**: `packages/event-matcher/src/services/postMatchValidator.ts` (new), `marketMatcher.ts`, `matchingCycle.ts`
**Deploy script**: `./deploy-event-matcher.sh`

### Pre-deploy: Unit test the validator

Run these test cases manually or in a script to validate the logic:

```typescript
import { validateMatch } from './postMatchValidator.js';

// Year mismatch — should REJECT
console.assert(!validateMatch('Trump before 2028', 'Trump before 2027').valid);
console.assert(validateMatch('Trump before 2028', 'Trump before 2027').check === 'YEAR_MISMATCH');

// Same year — should PASS
console.assert(validateMatch('Trump 2028 election', 'Will Trump win 2028?').valid);

// Year in only one title — should PASS (could be implicit)
console.assert(validateMatch('Trump 2028', 'Will Trump win?').valid);

// Entity inversion — should REJECT
console.assert(!validateMatch('Democrats win 51 seats', 'Republicans win 51 seats').valid);
console.assert(validateMatch('Democrats win 51 seats', 'Republicans win 51 seats').check === 'ENTITY_INVERSION');

// Same entity — should PASS
console.assert(validateMatch('Democrats win 51 seats', 'Democrats win 51 seats').valid);

// Superlative mismatch — should REJECT
console.assert(!validateMatch('Hottest year on record', 'Third-hottest year on record').valid);
console.assert(validateMatch('Hottest year on record', 'Third-hottest year on record').check === 'SUPERLATIVE_MISMATCH');

// Same superlative — should PASS
console.assert(validateMatch('Hottest year ever', 'Record hottest year').valid);

// Threshold mismatch — should REJECT
console.assert(!validateMatch('Fed rate above 3.5%', 'Fed rate above 4%').valid);
console.assert(validateMatch('Fed rate above 3.5%', 'Fed rate above 4%').check === 'THRESHOLD_MISMATCH');

// Same threshold — should PASS
console.assert(validateMatch('Bitcoin above 100%', 'BTC over 100%').valid);

// Generic titles — should PASS
console.assert(validateMatch('Will it rain tomorrow', 'Will it rain tomorrow').valid);

console.log('All post-match validator tests passed');
```

### Post-deploy: Monitor for rejections

```bash
# Watch for post-match validator rejections in real-time
ssh root@8.216.43.26 "docker compose -f /opt/prediction-market-ingestion/docker-compose.yml logs -f event-matcher | grep 'post-match validator'"
```

```bash
# After 1 hour, count rejections
ssh root@8.216.43.26 "docker compose -f /opt/prediction-market-ingestion/docker-compose.yml logs --since 1h event-matcher | grep -c 'rejected by post-match validator'"
```

### Post-deploy: Check for false negatives

```sql
-- Look at recently created event_mappings to spot any that should have been blocked
SELECT a.event_id as source_event, b.event_id as target_event,
       ea.title as source_title, eb.title as target_title,
       a.confidence_score, a.model_id, a.matched_at
FROM direct_exchanges_data.event_mappings a
JOIN direct_exchanges_data.event_mappings b
  ON a.canonical_event_id = b.canonical_event_id AND a.exchange_id < b.exchange_id
JOIN direct_exchanges_data.events ea
  ON a.source_id = ea.source_id AND a.exchange_id = ea.exchange_id AND a.event_id = ea.event_id
JOIN direct_exchanges_data.events eb
  ON b.source_id = eb.source_id AND b.exchange_id = eb.exchange_id AND b.event_id = eb.event_id
WHERE a.matched_at > NOW() - INTERVAL '24 hours'
  AND a.is_active = TRUE
ORDER BY a.matched_at DESC
LIMIT 50;
```

Review titles manually — if any look like false positives that should have been caught, expand the validator patterns.

```sql
-- Check recently created market_mappings for false positives
SELECT mm1.market_id as source_market, mm2.market_id as target_market,
       mm1.exchange_id as source_exchange, mm2.exchange_id as target_exchange,
       mt.kalshi_title, mt.polymarket_title,
       mm1.confidence_score, mm1.model_id, mm1.matched_at
FROM direct_exchanges_data.market_mappings mm1
JOIN direct_exchanges_data.market_mappings mm2
  ON mm1.canonical_market_id = mm2.canonical_market_id
  AND mm1.exchange_id < mm2.exchange_id AND mm1.outcome_side = 'YES' AND mm2.outcome_side = 'YES'
LEFT JOIN direct_exchanges_data.market_titles mt
  ON mm1.canonical_market_id = mt.canonical_market_id
WHERE mm1.matched_at > NOW() - INTERVAL '24 hours'
ORDER BY mm1.matched_at DESC
LIMIT 50;
```

**Pass criteria**:
- [ ] Validator compiles and builds without errors
- [ ] All unit test assertions pass
- [ ] Rejections appear in logs with correct check names and reasons
- [ ] No legitimate matches are being incorrectly blocked (check recent matches)
- [ ] Known false positive patterns (year mismatch, entity inversion) are caught

---

## Deployment Order

Execute in this order to minimize risk:

1. **predict-listener** (Issues #1 + #2): `./deploy-predict.sh`
   - Run cleanup SQL for price_close after deploy
   - Wait for one sync cycle (~5 min) to verify price backfill
2. **event-matcher** (Issue #6): `./deploy-event-matcher.sh`
   - Monitor logs for 30 min to check rejection patterns
3. **homepage-api** (Issue #8): Deploy when ready
   - Verify response times

---

## Rollback Procedures

### Issue #1 (price backfill)
No rollback needed — the `backfillPredictPrices` call is wrapped in try/catch and failure just means prices stay NULL (API COALESCE fallback still works).

### Issue #2 (price_close validation)
If validation is too strict (rejecting valid prices), revert the single if-block in `handlers.ts` to the original `if (!isNaN(tradePrice))` check.

### Issue #6 (post-match validator)
If blocking legitimate matches, quick disable:
```typescript
// In postMatchValidator.ts, make validateMatch always pass:
export function validateMatch(_s: string, _t: string): ValidationResult {
  return { valid: true };
}
```
Rebuild and redeploy event-matcher.

### Issue #8 (parallelization)
Revert `Promise.all` to sequential awaits if any unexpected behavior. Low risk — same queries, just concurrent.

---

## Monitoring Checklist (24h post-deploy)

- [ ] **Arb count** stable (check Telegram monitor — should be ~200-260)
- [ ] **Predict price_close** — no invalid values (`price_close >= 1.0` count = 0)
- [ ] **Predict price** — NULL count reduced for open markets
- [ ] **Event matcher** — no spike in false positives or missed matches
- [ ] **Post-match rejections** — reasonable count (a few per day, not hundreds)
- [ ] **API response times** — no regressions on market detail endpoint
- [ ] **No error spikes** in any service logs
