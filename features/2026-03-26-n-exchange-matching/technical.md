# N-Exchange Matching — Technical Details

## Implementation

### Exchange Pair Configuration (`config.ts`)

The `ExchangePairConfig` interface defines each pair:

```typescript
interface ExchangePairConfig {
  source: { sourceId: string; exchangeId: string };
  target: { sourceId: string; exchangeId: string };
  strategy: 'ai' | 'derived';
  enabled: boolean;
}
```

`getExchangePairs()` returns all 6 pairs. The matching cycle filters to enabled pairs and iterates sequentially.

### Matching Cycle (`matchingCycle.ts`)

```
for each enabled pair:
  if strategy === 'ai':
    runAIPairMatching(pair, config)    → existing Phase 1, parameterized
  else:
    runDerivedPairMatching(pair, config) → infer from market_mappings

after all pairs:
  if ENABLE_PHASE2:
    runCrossEventMatching(config)       → Phase 2 (disabled in prod)
```

Each pair's errors are caught independently — one failing pair doesn't block others.

### Derived Matcher SQL (`derivedMatcher.ts`)

The core query finds event pairs linked by shared `canonical_market_id` in `market_mappings`:

```sql
SELECT DISTINCT
  sp.event_id AS source_event_id, sp.source_id AS source_source_id,
  tp.event_id AS target_event_id, tp.source_id AS target_source_id
FROM market_mappings sm
JOIN market_mappings tm
  ON sm.canonical_market_id = tm.canonical_market_id
  AND tm.exchange_id = $2 AND tm.outcome_side = 'YES'
JOIN prediction_markets sp ON sm.* = sp.*  -- source market → event_id
JOIN prediction_markets tp ON tm.* = tp.*  -- target market → event_id
LEFT JOIN event_mappings em_s             -- exclude already-mapped pairs
  ON ... AND em_s.canonical_event_id IN (
    SELECT canonical_event_id FROM event_mappings WHERE exchange_id = $2
  )
WHERE sm.exchange_id = $1 AND sm.outcome_side = 'YES'
  AND sp.event_id IS NOT NULL AND tp.event_id IS NOT NULL
  AND em_s.event_id IS NULL               -- only unmatched pairs
```

Results are deduplicated by `source_event_id:target_event_id`, then each pair goes through transitive canonical grouping before upserting to `event_mappings`.

### Canonical ID Generation (`canonicalId.ts`)

```typescript
function generateCanonicalId(
  prefix: 'CE' | 'CM',
  entries: Array<{ exchangeId: string; id: string }>
): string {
  const keys = entries.map(e => `${e.exchangeId}:${e.id}`).sort();
  const hash = createHash('sha256')
    .update(keys.join('|'))
    .digest('hex')
    .substring(0, 16);
  return `${prefix}-${hash}`;
}
```

Sorting before hashing ensures deterministic output regardless of input order. The `EXCHANGE:id` format and `|` separator match the old hardcoded functions, so existing K↔P canonical IDs are unchanged.

### Transitive Grouping Logic

In both `runAIPairMatching` and `runDerivedPairMatching`:

```typescript
const [existingSourceCanonical, existingTargetCanonical] = await Promise.all([
  findExistingCanonicalEventId(sourceId, exchangeId, eventId),
  findExistingCanonicalEventId(targetId, exchangeId, eventId),
]);

const canonicalEventId = existingSourceCanonical
  || existingTargetCanonical
  || generateCanonicalId('CE', [source, target]);
```

First match wins — if both already belong to different groups, the source's group takes precedence.

### AI Pair Matching Parameterization

The `runAIPairMatching` function receives the full `ExchangePairConfig` and passes `sourceLabel`/`targetLabel` to:
- `compareEvents()` — uses labels in AI prompts
- `matchMarketsForSinglePair()` — uses source/target IDs for DB queries
- `generateCanonicalId()` — uses exchange IDs for hash input

No exchange names are hardcoded in the matching logic.

## Key Files

| File | Purpose |
|------|---------|
| `packages/event-matcher/src/config.ts` | Exchange pair configuration and env var parsing |
| `packages/event-matcher/src/services/matchingCycle.ts` | Orchestrates pair loop + Phase 2 |
| `packages/event-matcher/src/services/derivedMatcher.ts` | Derived event matching from market_mappings |
| `packages/event-matcher/src/utils/canonicalId.ts` | Deterministic canonical ID generator |
| `packages/event-matcher/src/services/marketMatcher.ts` | Market-within-event matching (4-tier) |
| `packages/event-matcher/src/services/aiComparer.ts` | OpenAI event/market comparison |
| `packages/event-matcher/src/services/preFilter.ts` | Keyword pre-filtering for AI candidates |
| `packages/predict-listener/src/services/crossMapping.ts` | Predict API-link market_mappings creation |
| `packages/predict-listener/src/services/marketSync.ts` | Unified categories fetch (markets + events from single API) |

## Database

No schema changes were required. The existing tables support N-exchange matching:

- **`event_mappings`** — PK: `(source_id, exchange_id, event_id)`. Multiple exchanges link via shared `canonical_event_id`.
- **`market_mappings`** — PK: `(source_id, exchange_id, market_id, outcome_side)`. Multiple exchanges link via shared `canonical_market_id`.
- **`market_titles`** — `exchange_titles` JSONB column stores titles keyed by exchange (e.g., `{"KALSHI": "...", "POLYMARKET": "...", "PREDICT": "..."}`).

## Deployment

No separate deployment needed — changes are in the `event-matcher` package:

```bash
./deploy-event-matcher.sh
```

The derived matcher runs automatically in each cycle for enabled Predict pairs. No migration required.
