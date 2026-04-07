# Technical: Market-Within-Event Matching

Technical implementation details.

---

## Database Schema Changes

**No schema changes required.** Reuses existing tables:
- `market_mappings` (4 rows per match: YES+NO per exchange, `canonical_market_id` as VARCHAR — no FK to `canonical_markets`)
- `market_titles` (generated title + both exchange titles)

---

## Data Flow

Market matching is called inline from `matchingCycle.ts` immediately after each event match:

```
matchingCycle.ts (worker matches event pair)
        │
        ▼
matchMarketsForSinglePair(kalshiSourceId, kalshiEventId, polySourceId, polyEventId)
        │
        ├── fetchMarketsForEvent() × 2 (YES-side from both exchanges)
        ├── fetchExistingMappedMarketIds() (skip already-mapped)
        │
        ├── Binary (1:1)? ──► auto-match (confidence=1.0, algorithmic-v1)
        │
        └── Multi-outcome? ──► greedyMatch() with Jaccard similarity
                │
                ├── Jaccard >= 0.5 ──► auto-accept (algorithmic-v1)
                ├── Jaccard 0.3–0.5 ──► verifyMarketMatch() AI call
                │       │
                │       ├── AI confidence >= 0.8 ──► accept (ai-verified-v1)
                │       └── AI confidence < 0.8 ──► reject
                └── Jaccard < 0.3 ──► reject
        │
        ▼
┌──────────────────┐
│ market_mappings  │  (4 rows: YES+NO per exchange, model_id per tier)
│ market_titles    │  (1 row: generated title)
└──────────────────┘
```

---

## Files Modified

| File | Action | Purpose |
|------|--------|---------|
| `packages/event-matcher/src/services/matchingCycle.ts` | Modified | Fix source_id bug, concurrent workers, inline market matching |
| `packages/event-matcher/src/services/marketMatcher.ts` | Created | `matchMarketsForSinglePair()` — market matching for a single event pair |
| `packages/event-matcher/src/services/aiComparer.ts` | Modified | Rate limiting via OpenAI response headers (gate at 90% capacity); `verifyMarketMatch()` for borderline market matches |
| `packages/event-matcher/src/config.ts` | Modified | Add `marketMatchThreshold` |
| `packages/shared/src/db/types.ts` | Modified | Add `MarketForMatching` type |
| `packages/shared/src/db/queries.ts` | Modified | Add `fetchMarketsForEvent()`, `fetchExistingMappedMarketIds()` |

---

## Dependencies

### Prerequisites

1. Event-level matching must be running (populates `event_mappings`)
2. Market ingestion must be running (populates `prediction_markets`)
3. `market_mappings` and `market_titles` tables must exist

### Runtime Dependencies

| Component | Required For |
|-----------|-------------|
| `event_mappings` table | Source of matched event pairs |
| `prediction_markets` table | Source of market data to match |
| `@prediction-market/shared` | Query functions, types, source ID constants |

---

## Testing Strategy

### Verification After Deploy

```sql
-- Check market mappings created by algorithmic matcher
SELECT mm.canonical_market_id, mm.exchange_id, mm.market_id,
       mm.outcome_side, mm.confidence_score, mm.model_id
FROM direct_exchanges_data.market_mappings mm
WHERE mm.model_id = 'algorithmic-v1'
ORDER BY mm.matched_at DESC LIMIT 20;

-- Verify event matches are being created (source_id fix)
SELECT COUNT(*) FROM direct_exchanges_data.event_mappings WHERE is_active = TRUE;
```

---

## Model IDs

| model_id | Used When | Description |
|----------|-----------|-------------|
| `algorithmic-v1` | Binary auto-match or Jaccard >= 0.5 | Pure algorithmic matching, no AI call |
| `ai-verified-v1` | Jaccard 0.3–0.5 with AI confidence >= 0.8 | Borderline match verified by OpenAI |

---

## Performance Considerations

- Market matching runs inline immediately after each event match (no separate batch phase)
- Each worker handles its own market matching, so it happens concurrently across workers
- Already-mapped markets are filtered out before comparison
- Jaccard similarity is O(tokens) per comparison — lightweight
- Borderline matches (Jaccard 0.3–0.5) incur an AI call via `verifyMarketMatch()` — adds latency and consumes rate limit quota
- Rate limiting uses OpenAI response headers (`x-ratelimit-remaining-*`); workers gate at 90% capacity usage to prevent 429s
- Unmatched events are skipped for 24h via `match_checked_at` column (configurable via `MATCHER_RECHECK_INTERVAL_MS`)
