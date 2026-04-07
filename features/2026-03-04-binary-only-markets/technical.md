# Technical: Binary-Only Polymarket Market Ingestion

Technical implementation details for this feature.

---

## Database Schema Changes

### New Tables

None.

### New Columns

None.

---

## Data Flow

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Gamma API   │ --> │ normalizeMarket() │ --> │ prediction_  │
│  /events     │     │ (binary filter)   │     │ markets      │
└──────────────┘     └──────────────────┘     └──────────────┘
                            │
                     Skip if outcomes
                     not ["Yes","No"]
```

### Filter logic in normalizeMarket()

```typescript
const hasYes = outcomes.some(o => o?.toUpperCase() === 'YES');
const hasNo = outcomes.some(o => o?.toUpperCase() === 'NO');
if (!hasYes || !hasNo) {
  return results; // empty array, skip non-binary
}
```

### Binary market count in fetchEventsWithMarkets()

```typescript
const binaryMarketCount = event.markets?.filter(m => {
  try {
    const outcomes = m.outcomes ? JSON.parse(m.outcomes) as string[] : [];
    return outcomes.some(o => o?.toUpperCase() === 'YES')
      && outcomes.some(o => o?.toUpperCase() === 'NO');
  } catch {
    return false;
  }
}).length ?? 0;
```

### 0-market event filter in matchingCycle

```typescript
const filteredPolyEvents = polyEvents.filter(
  e => e.market_count == null || e.market_count > 0
);
```

---

## Dependencies

### Prerequisites

1. No migrations needed — no schema changes

### Runtime Dependencies

| Component | Required For |
|-----------|-------------|
| polymarket-listener | Filtering non-binary markets at ingestion |
| event-matcher | Skipping 0-market events in matching |

---

## Migration Checklist

- [x] Deploy polymarket-listener with binary filter
- [x] Deploy event-matcher with 0-market event filter
- [x] Run DB cleanup: delete NO-only markets from prediction_markets
- [x] Run DB cleanup: delete orphaned market_latest_data
- [ ] Verify market_count on events is correct (self-corrects on next sync cycle)

---

## Rollback Plan

If issues arise:

1. Revert the three code changes (normalize.ts, gammaApi.ts, matchingCycle.ts)
2. Redeploy polymarket-listener and event-matcher
3. Non-binary markets will be re-ingested on the next sync cycle (5 min)
4. No DB rollback needed — deleted data will be recreated by the listener

---

## Testing Strategy

### Unit Tests

**File:** `packages/polymarket-listener/src/transformers/__tests__/normalize.test.ts`

| Test Case | Input | Expected Output |
|-----------|-------|-----------------|
| Binary market (Yes/No) | `outcomes: '["Yes","No"]'` | 2 NormalizedMarket records |
| Non-binary market | `outcomes: '["Kings","Blue Jackets"]'` | Empty array |
| Mixed case | `outcomes: '["yes","no"]'` | 2 NormalizedMarket records |
| Single outcome | `outcomes: '["Yes"]'` | Empty array |

### Integration Tests

- Verify equal YES/NO counts in prediction_markets after sync
- Verify no NO-only markets exist
- Verify event-matcher logs show `polyEventsSkippedNoBinaryMarkets > 0`

---

## Performance Considerations

- Binary filter in `normalizeMarket()` runs per-market — negligible overhead (simple string comparison)
- Binary count in `fetchEventsWithMarkets()` parses outcomes JSON per market per event — adds ~50ms to the full event fetch (8k+ events)
- Event matcher filter reduces Poly candidate pool by ~39% (3,182 of 8,123 events), saving AI API calls
- DB cleanup deleted ~16,416 rows from each of prediction_markets and market_latest_data
