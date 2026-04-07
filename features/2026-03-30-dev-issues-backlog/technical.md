# Technical: Dev Issues Backlog - Remaining Fixes

Technical implementation details for the four remaining issues.

---

## Issue #1: Predict price backfill

### Data Flow

```
┌─────────────────────┐     ┌──────────────────────┐     ┌────────────────────┐
│ Predict Categories  │ --> │ normalizeMarkets()   │ --> │ prediction_markets │
│ API (/v1/categories)│     │ (price = undefined)  │     │ (price = NULL)     │
└─────────────────────┘     └──────────────────────┘     └────────┬───────────┘
                                                                  │
┌─────────────────────┐                                           │
│ market_latest_data  │ ─── backfillPredictPrices() ──────────────┘
│ (reference_price,   │     UPDATE pm SET price = COALESCE(...)
│  band_vwap_bid)     │
└─────────────────────┘
```

### Implementation

**File: `packages/shared/src/db/queries.ts`**

Add new query function:

```typescript
export async function backfillPredictPrices(pool: Pool): Promise<number> {
  const result = await pool.query(`
    UPDATE direct_exchanges_data.prediction_markets pm
    SET price = COALESCE(mld.reference_price, mld.band_vwap_bid)
    FROM direct_exchanges_data.market_latest_data mld
    WHERE pm.source_id = mld.source_id
      AND pm.exchange_id = mld.exchange_id
      AND pm.market_id = mld.market_id
      AND pm.outcome_side = mld.outcome_side
      AND pm.exchange_id = 'PREDICT'
      AND pm.price IS DISTINCT FROM COALESCE(mld.reference_price, mld.band_vwap_bid)
      AND COALESCE(mld.reference_price, mld.band_vwap_bid) IS NOT NULL
  `);
  return result.rowCount ?? 0;
}
```

**File: `packages/predict-listener/src/services/marketSync.ts`**

Add after the `upsertPredictionMarketsBatch()` call in `refreshMarkets()`:

```typescript
import { backfillPredictPrices } from '@prediction-market/shared';

// After market upsert:
const priceUpdates = await backfillPredictPrices(pool);
if (priceUpdates > 0) {
  logger.info({ updated: priceUpdates }, 'Backfilled prediction_markets.price from market_latest_data');
}
```

### Performance

- Single UPDATE query, no loop
- `IS DISTINCT FROM` prevents unnecessary writes on re-runs
- Expected: ~2000-4000 rows updated on first run, <100 on subsequent syncs

---

## Issue #2: Predict price_close validation

### Implementation

**File: `packages/predict-listener/src/websocket/handlers.ts`**

Replace lines 112-135 with validated version:

```typescript
if (data.lastOrderSettled) {
  const tradePrice = parseFloat(data.lastOrderSettled.price);
  const outcome = data.lastOrderSettled.outcome;

  // Validate price is in valid range
  if (isNaN(tradePrice) || tradePrice < 0 || tradePrice > 1) {
    logger.warn({
      marketId,
      price: data.lastOrderSettled.price,
      outcome,
    }, 'Invalid lastOrderSettled price, skipping price_close write');
  } else {
    // Normalize outcome to determine YES price
    const isNo = outcome === 'No' || outcome === 'NO';
    const isYes = outcome === 'Yes' || outcome === 'YES';

    if (!isYes && !isNo) {
      logger.warn({ marketId, outcome }, 'Unexpected lastOrderSettled outcome value');
    }

    const yesPrice = isNo ? 1 - tradePrice : tradePrice;
    const noPrice = 1 - yesPrice;

    for (const [side, price] of [['YES', yesPrice], ['NO', noPrice]] as const) {
      const priceData: MarketLatestData = {
        source_id: PREDICT_SOURCE_ID,
        exchange_id: PREDICT_EXCHANGE_ID,
        market_id: marketId,
        outcome_side: side,
        price_close: price,
        entry_time: exchangeTime,
      };
      marketDataWriter.add(priceData).catch((err) => {
        logger.error({ err }, 'Failed to add last trade price to batch');
      });
    }
  }
}
```

### One-time cleanup SQL

Run on server after deploying the fix:

```sql
-- Identify bad records
SELECT market_id, outcome_side, price_close
FROM direct_exchanges_data.market_latest_data
WHERE exchange_id = 'PREDICT' AND (price_close < 0 OR price_close > 1);

-- Fix by nulling invalid values (will be repopulated by next WS update)
UPDATE direct_exchanges_data.market_latest_data
SET price_close = NULL
WHERE exchange_id = 'PREDICT' AND (price_close < 0 OR price_close > 1);
```

---

## Issue #6: Post-match validation layer

### New File

**`packages/event-matcher/src/services/postMatchValidator.ts`**

```typescript
import { createLogger } from '@prediction-market/shared';

const logger = createLogger('post-match-validator');

export interface ValidationResult {
  valid: boolean;
  check?: string;
  reason?: string;
}

// Extracts all 4-digit years from a string
function extractYears(text: string): number[] {
  return [...text.matchAll(/\b(20\d{2})\b/g)].map(m => parseInt(m[1]));
}

// Extracts ordinal/superlative terms
const SUPERLATIVES = [
  'first', 'second', 'third', 'fourth', 'fifth',
  '1st', '2nd', '3rd', '4th', '5th',
  'hottest', 'coldest', 'warmest', 'coolest',
  'most', 'least', 'highest', 'lowest',
  'best', 'worst', 'top', 'bottom',
];

function extractSuperlatives(text: string): string[] {
  const lower = text.toLowerCase();
  return SUPERLATIVES.filter(s => lower.includes(s));
}

// Known opposing entity pairs
const OPPOSING_PAIRS: [RegExp, RegExp][] = [
  [/\bdemocrat/i, /\brepublican/i],
  [/\bdem\b/i, /\brep\b/i],
  [/\bgop\b/i, /\bdem/i],
  [/\byes\b/i, /\bno\b/i],
  [/\bbull/i, /\bbear/i],
  [/\bover\b/i, /\bunder\b/i],
];

function hasEntityInversion(a: string, b: string): boolean {
  for (const [pat1, pat2] of OPPOSING_PAIRS) {
    const aHas1 = pat1.test(a), aHas2 = pat2.test(a);
    const bHas1 = pat1.test(b), bHas2 = pat2.test(b);
    // Inversion: A has entity1 but not entity2, B has entity2 but not entity1
    if (aHas1 && !aHas2 && bHas2 && !bHas1) return true;
    if (aHas2 && !aHas1 && bHas1 && !bHas2) return true;
  }
  return false;
}

// Extracts numeric thresholds like "51 seats", "above 3.5%"
function extractThresholds(text: string): { value: number; context: string }[] {
  const results: { value: number; context: string }[] = [];
  const patterns = [
    /(\d+(?:\.\d+)?)\s*%/g,           // "3.5%"
    /(\d+(?:\.\d+)?)\s+seats/gi,       // "51 seats"
    /above\s+(\d+(?:\.\d+)?)/gi,       // "above 80"
    /below\s+(\d+(?:\.\d+)?)/gi,       // "below 50"
    /over\s+(\d+(?:\.\d+)?)/gi,        // "over 100"
    /under\s+(\d+(?:\.\d+)?)/gi,       // "under 50"
  ];
  for (const pat of patterns) {
    for (const m of text.matchAll(pat)) {
      results.push({ value: parseFloat(m[1]), context: m[0] });
    }
  }
  return results;
}

export function validateMatch(sourceTitle: string, targetTitle: string): ValidationResult {
  // 1. Year mismatch
  const sourceYears = extractYears(sourceTitle);
  const targetYears = extractYears(targetTitle);
  if (sourceYears.length > 0 && targetYears.length > 0) {
    const sourceSet = new Set(sourceYears);
    const targetSet = new Set(targetYears);
    const overlap = [...sourceSet].some(y => targetSet.has(y));
    if (!overlap) {
      return {
        valid: false,
        check: 'YEAR_MISMATCH',
        reason: `Years differ: source=[${[...sourceSet]}] target=[${[...targetSet]}]`,
      };
    }
  }

  // 2. Entity inversion
  if (hasEntityInversion(sourceTitle, targetTitle)) {
    return {
      valid: false,
      check: 'ENTITY_INVERSION',
      reason: `Opposing entities detected between titles`,
    };
  }

  // 3. Superlative mismatch
  const sourceSup = extractSuperlatives(sourceTitle);
  const targetSup = extractSuperlatives(targetTitle);
  if (sourceSup.length > 0 && targetSup.length > 0) {
    const sourceKey = sourceSup.sort().join(',');
    const targetKey = targetSup.sort().join(',');
    if (sourceKey !== targetKey) {
      return {
        valid: false,
        check: 'SUPERLATIVE_MISMATCH',
        reason: `Superlatives differ: source=[${sourceSup}] target=[${targetSup}]`,
      };
    }
  }

  // 4. Threshold mismatch (only when same unit/context pattern)
  const sourceThresh = extractThresholds(sourceTitle);
  const targetThresh = extractThresholds(targetTitle);
  if (sourceThresh.length === 1 && targetThresh.length === 1) {
    if (sourceThresh[0].value !== targetThresh[0].value) {
      return {
        valid: false,
        check: 'THRESHOLD_MISMATCH',
        reason: `Thresholds differ: "${sourceThresh[0].context}" vs "${targetThresh[0].context}"`,
      };
    }
  }

  return { valid: true };
}
```

### Integration Points

**File: `packages/event-matcher/src/services/marketMatcher.ts`**

Insert after AI verification in tier 4 (Jaccard 0.3-0.85 with AI verification):

```typescript
import { validateMatch } from './postMatchValidator.js';

// After verifyMarketMatch() returns positive, before writing:
const validation = validateMatch(sourceMarket.title, targetMarket.title);
if (!validation.valid) {
  logger.info({
    source: sourceMarket.title,
    target: targetMarket.title,
    check: validation.check,
    reason: validation.reason,
  }, 'Post-match validator rejected market match');
  continue;
}
```

**File: `packages/event-matcher/src/services/aiComparer.ts`**

Insert after `compareEvents()` returns a match, before returning the result:

```typescript
import { validateMatch } from './postMatchValidator.js';

// After AI says events match, validate:
const validation = validateMatch(sourceEvent.title, candidateEvent.title);
if (!validation.valid) {
  logger.info({
    source: sourceEvent.title,
    target: candidateEvent.title,
    check: validation.check,
    reason: validation.reason,
  }, 'Post-match validator rejected event match');
  return null; // treat as no match
}
```

### Data Flow

```
┌──────────────┐     ┌──────────────┐     ┌────────────────────┐     ┌──────────────┐
│ AI Comparer  │ --> │ Post-Match   │ --> │ DB Write           │ --> │ market_      │
│ (event/mkt)  │     │ Validator    │     │ (if valid)         │     │ mappings     │
│ confidence   │     │ - years      │     │                    │     │ event_       │
│ >= 0.85      │     │ - entities   │     │                    │     │ mappings     │
│              │     │ - superlat.  │     │                    │     │              │
│              │     │ - thresholds │     │                    │     │              │
└──────────────┘     └──────────────┘     └────────────────────┘     └──────────────┘
                           │ REJECT
                           ▼
                     ┌──────────────┐
                     │ Log + skip   │
                     └──────────────┘
```

### Testing Strategy

Test cases for `validateMatch()`:

| Source | Target | Expected | Check |
|--------|--------|----------|-------|
| "Trump before 2028" | "Trump before 2027" | REJECT | YEAR_MISMATCH |
| "Trump 2028 election" | "Trump 2028 election" | PASS | — |
| "Dem wins 51 seats" | "Rep wins 51 seats" | REJECT | ENTITY_INVERSION |
| "Hottest year on record" | "Third-hottest year" | REJECT | SUPERLATIVE_MISMATCH |
| "Fed rate above 3.5%" | "Fed rate above 4%" | REJECT | THRESHOLD_MISMATCH |
| "Bitcoin above $100k" | "Bitcoin above $100k" | PASS | — |
| "Will it rain tomorrow" | "Will it rain tomorrow" | PASS | — |

---

## Issue #8: Market detail parallelization

### Implementation

**File: `packages/homepage-api/src/routes/marketDetail.ts`**

**Change 1: Parallelize primary queries (lines 147-211)**

Replace sequential:
```typescript
const allMarkets = await queryWithPool(...);
// ... early return check ...
const eventResult = await queryWithPool(...);
```

With parallel:
```typescript
const [allMarkets, eventResult] = await Promise.all([
  queryWithPool<{...}>(fastify.apiPool, `WITH open_markets AS ...`, [eventId]),
  queryWithPool<{...}>(fastify.apiPool, `SELECT e.exchange_id ...`, [eventId]),
]);

if (allMarkets.rows.length === 0) {
  return reply.status(404).send({ error: 'No matched markets found for this event' });
}
```

Note: The early-return check for empty `allMarkets` moves after both queries complete. This means `eventResult` runs even when `allMarkets` is empty, but both queries are <1ms so the wasted work is negligible.

**Change 2: Parallelize translation queries (lines 319-336)**

Replace sequential:
```typescript
const titleTranslations = await getTranslations('market_titles', cmIds, lang);
const ruleTranslations = await getTranslations('prediction_markets', ruleKeys, lang);
const eventTitleTranslations = await getTranslations('events', [eventId], lang);
```

With parallel:
```typescript
const [titleTranslations, ruleTranslations, eventTitleTranslations] = await Promise.all([
  getTranslations('market_titles', cmIds, lang),
  getTranslations('prediction_markets', ruleKeys, lang),
  getTranslations('events', [eventId], lang),
]);
```

### Performance Impact

| Scenario | Before | After | Savings |
|----------|--------|-------|---------|
| Cold, English | ~2ms (2 sequential queries) | ~1ms (parallel) | ~1ms |
| Cold, non-English | ~5ms (5 sequential queries) | ~2ms (2 parallel batches) | ~3ms |

The savings are small because individual queries are fast (~1ms each). The major performance wins were already achieved in Phase 1+2 (CTE optimization, cache, removing orderbook query). This change is primarily about code quality and future-proofing for when query latency increases.

---

## Migration Checklist

- [ ] **Issue #2**: Deploy predict-listener with price validation
- [ ] **Issue #2**: Run cleanup SQL for existing `price_close >= 1.0`
- [ ] **Issue #1**: Add `backfillPredictPrices` to shared queries
- [ ] **Issue #1**: Deploy predict-listener with price backfill
- [ ] **Issue #1**: Verify `prediction_markets.price` populated for Predict
- [ ] **Issue #8**: Deploy homepage-api with parallelized queries
- [ ] **Issue #6**: Implement and test postMatchValidator
- [ ] **Issue #6**: Deploy event-matcher with validator
- [ ] **Issue #6**: Monitor logs for false positive rejections

---

## Rollback Plan

All changes are backward-compatible:
- **Issue #1**: If backfill query causes issues, remove the call — API COALESCE fallback still works
- **Issue #2**: If price validation is too strict, loosen the range check
- **Issue #6**: If validator blocks legitimate matches, disable by returning `{ valid: true }` unconditionally
- **Issue #8**: If Promise.all causes issues, revert to sequential awaits
