# Technical: AI-Powered Cross-Exchange Market Matching

Technical implementation details for the market matcher service.

---

## Database Schema Changes

### New Columns on `market_mappings`

```sql
ALTER TABLE direct_exchanges_data.market_mappings
ADD COLUMN IF NOT EXISTS confidence_score DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS matched_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS model_id VARCHAR(50),
ADD COLUMN IF NOT EXISTS match_version INTEGER DEFAULT 1;

-- Changed canonical_market_id from UUID to VARCHAR for flexibility
ALTER TABLE direct_exchanges_data.market_mappings
ALTER COLUMN canonical_market_id TYPE VARCHAR(50);

-- Dropped FK constraints for simplicity (canonical_markets and prediction_markets tables unused)
ALTER TABLE direct_exchanges_data.market_mappings
DROP CONSTRAINT IF EXISTS market_mappings_canonical_market_id_fkey;
ALTER TABLE direct_exchanges_data.market_mappings
DROP CONSTRAINT IF EXISTS market_mappings_source_id_exchange_id_market_id_outcome_si_fkey;
```

| Column | Type | Description |
|--------|------|-------------|
| confidence_score | DOUBLE PRECISION | AI match confidence (0.0-1.0) |
| matched_at | TIMESTAMPTZ | When the match was detected |
| model_id | VARCHAR(50) | OpenAI model used (e.g. gpt-5-nano) |
| match_version | INTEGER | Prompt/schema version for tracking |

---

## Data Flow

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ prediction_      │     │   market-matcher │     │  market_mappings │
│ markets          │ --> │   service        │ --> │  table           │
│ (Kalshi + Poly)  │     │                  │     │  (immediate      │
│ (ALL categories) │     │                  │     │   writes)        │
└──────────────────┘     └──────┬───────────┘     └──────────────────┘
                                │
                         ┌──────▼───────────┐
                         │  OpenAI API      │
                         │  (GPT-5 Nano)    │
                         │  30s timeout     │
                         └──────────────────┘
```

### Matching Cycle Flow

```
1. Fetch ALL Kalshi markets (Open, YES side) from prediction_markets — no category filter
2. Fetch ALL Polymarket markets (Open, YES side) from prediction_markets — no category filter
3. Fetch existing mapped market_ids from market_mappings -> Set<string>
4. Filter out already-matched markets
5. Pre-filter: outcome_name standard Yes/No only
6. For each unmatched Kalshi market:
   a. Extract keywords from title (lowercase, remove stop words/numbers/short tokens)
   b. Score Polymarket candidates by keyword overlap + expiry within 120 days
   c. Take top 10 candidates by overlap score (must have overlap >= 1)
   d. Call OpenAI API with structured prompt (30s timeout, 3 retries)
   e. Parse response, accept match=true AND confidence >= 0.85
   f. Write matches to DB immediately (not batched)
7. Repeat for NO side
```

---

## Keyword Pre-filter

The keyword pre-filter eliminates ~90%+ of irrelevant comparisons before hitting the AI API.

### extractKeywords(title)
- Lowercase the title
- Split on non-alphanumeric characters
- Remove stop words: `will, the, be, by, at, of, in, to, a, an, before, more, than, least, between, and, or, how, many, what, when, this, that, for`
- Remove short tokens (< 3 chars) and pure numbers
- Return as `Set<string>`

### keywordOverlap(setA, setB)
- Count shared keywords between two sets
- Return the count (0 = no overlap)

### findCandidates(kalshiMarket, polymarketMarkets, expiryToleranceDays, maxCandidates)
- Extract keywords from Kalshi market title
- For each Polymarket candidate: check expiry within tolerance, compute keyword overlap
- Only include candidates with overlap >= 1
- Sort by overlap descending, return top `maxCandidates`

---

## AI Prompt Design

The system prompt focuses on **real-world outcome matching**, not superficial wording:

- Two markets MATCH if they resolve on the same real-world outcome:
  1. Same underlying event (e.g., both about a Fed rate decision)
  2. Same direction and threshold (e.g., both "cut by 25bps")
  3. Same time period (e.g., both about the March 2026 FOMC meeting)

- IGNORE superficial differences:
  - Different wording ("Federal Reserve" vs "Fed", "cut rates" vs "decrease interest rates")
  - Different contract expiry dates (exchanges set different close dates for the same event)
  - Different formatting/punctuation between exchanges

- Two markets DO NOT match if:
  - Different real-world outcomes ("cut by 25bps" vs "cut by 50bps")
  - Different time periods (March vs June meeting)
  - Broader/narrower questions ("any rate cut" vs "cut by exactly 25bps")

---

## Dependencies

### Prerequisites

1. Database migration must be run (add columns, change types, drop FKs)
2. `prediction_markets` table must be populated by listeners
3. `OPENAI_API_KEY` must be set

### Runtime Dependencies

| Component | Required For |
|-----------|-------------|
| PostgreSQL | Reading markets, writing mappings |
| OpenAI API | AI-powered market comparison |
| shared package | DB client, queries, logger, types |

---

## Package Structure

```
packages/market-matcher/
├── package.json              # @prediction-market/market-matcher
├── tsconfig.json             # extends ../../tsconfig.base.json
├── Dockerfile
└── src/
    ├── index.ts              # Entry: config -> initial run -> setInterval(5min) -> SIGTERM
    ├── config.ts             # Validate OPENAI_API_KEY + load env vars
    ├── types.ts              # AIResponse, MatchResult interfaces
    └── services/
        ├── matchingCycle.ts  # Main orchestrator: fetch -> pre-filter -> AI compare -> immediate write
        ├── preFilter.ts      # extractKeywords(), keywordOverlap(), findCandidates(), filterStandardOutcomes()
        ├── aiComparer.ts     # OpenAI API call: prompt construction, 30s timeout, 3 retries
        ├── mappingWriter.ts  # Generate canonical IDs (SHA256-based), call batch upsert
        └── __tests__/        # Unit tests for all services
```

---

## Migration Checklist

- [x] Run database migration (ALTER TABLE + change types + drop FKs)
- [x] Deploy shared package with new types/queries
- [x] Deploy market-matcher service
- [x] Verify matches are being written

---

## Rollback Plan

If issues arise:

```sql
-- Clear all AI-generated matches
DELETE FROM direct_exchanges_data.market_mappings WHERE model_id IS NOT NULL;

-- Remove added columns
ALTER TABLE direct_exchanges_data.market_mappings
DROP COLUMN IF EXISTS confidence_score,
DROP COLUMN IF EXISTS matched_at,
DROP COLUMN IF EXISTS model_id,
DROP COLUMN IF EXISTS match_version;
```

To stop the service:
```bash
docker compose stop market-matcher
```

---

## Testing Strategy

### Unit Tests

68 tests across 4 test files:
- `preFilter.test.ts` — keyword extraction, overlap scoring, candidate filtering (38 tests)
- `matchingCycle.test.ts` — orchestration, both sides, skip matched, confidence threshold (8 tests)
- `mappingWriter.test.ts` — canonical ID generation, row writing (14 tests)
- `aiComparer.test.ts` — prompt construction, response parsing, timeout handling (8 tests)

### Manual Verification

1. Check logs: `docker compose logs --tail 50 market-matcher`
2. Query matches: see usage.md for SQL queries

---

## Performance Considerations

- **Keyword pre-filter**: Eliminates ~90%+ of comparisons before AI API calls
- **Immediate writes**: Each match persisted as found — no data loss on restart
- **30s fetch timeout**: Prevents indefinite hangs on OpenAI API
- **Rate limiting**: Configurable RPM limit (default 50) prevents OpenAI throttling
- **Incremental matching**: Only processes new/unmatched markets each cycle
- **Batch upserts**: Uses multi-row INSERT ON CONFLICT (same pattern as other services)
- **Sort by market_id**: Prevents deadlocks on concurrent writes
- **Cycle duration**: ~30+ minutes for 32k markets at 1.2s per API call
