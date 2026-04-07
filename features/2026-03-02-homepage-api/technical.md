# Technical: Homepage API

Technical implementation details for the homepage API service.

---

## Database Schema Changes

### New Table: `market_titles`

```sql
CREATE TABLE direct_exchanges_data.market_titles (
    canonical_market_id VARCHAR(50) PRIMARY KEY,
    generated_title VARCHAR(500) NOT NULL,
    kalshi_title TEXT,
    polymarket_title TEXT,
    model_id VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_market_titles_updated
ON direct_exchanges_data.market_titles (updated_at);
```

| Column | Type | Description |
|--------|------|-------------|
| canonical_market_id | VARCHAR(50) | PK, matches market_mappings.canonical_market_id |
| generated_title | VARCHAR(500) | AI-generated unified title |
| kalshi_title | TEXT | Original Kalshi title at generation time |
| polymarket_title | TEXT | Original Polymarket title at generation time |
| model_id | VARCHAR(50) | OpenAI model used (e.g. gpt-5-nano) |
| created_at | TIMESTAMPTZ | Row creation time |
| updated_at | TIMESTAMPTZ | Last update time |

### New Table: `market_scores`

```sql
CREATE TABLE direct_exchanges_data.market_scores (
    id VARCHAR(255) PRIMARY KEY,
    score DOUBLE PRECISION NOT NULL DEFAULT 0,
    notional_24h DOUBLE PRECISION DEFAULT 0,
    depth DOUBLE PRECISION DEFAULT 0,
    trades_24h INTEGER DEFAULT 0,
    n_norm DOUBLE PRECISION DEFAULT 0,
    d_norm DOUBLE PRECISION DEFAULT 0,
    v_norm DOUBLE PRECISION DEFAULT 0,
    category VARCHAR(50),
    is_matched BOOLEAN DEFAULT false,
    canonical_market_id VARCHAR(50),
    exchange_id VARCHAR(255),
    source_id VARCHAR(255),
    market_id VARCHAR(255),
    event_id VARCHAR(255),
    outcome_side VARCHAR(10) DEFAULT 'YES',
    title VARCHAR(500),
    thumb VARCHAR(50),
    end_date TIMESTAMPTZ,
    end_date_formatted VARCHAR(50),
    volume_formatted VARCHAR(20),
    status VARCHAR(50),
    updated_at TIMESTAMPTZ,
    computed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_market_scores_score ON direct_exchanges_data.market_scores (score DESC, updated_at DESC, id ASC);
CREATE INDEX idx_market_scores_end_date ON direct_exchanges_data.market_scores (end_date ASC NULLS LAST, updated_at DESC, id ASC);
CREATE INDEX idx_market_scores_category ON direct_exchanges_data.market_scores (category, score DESC);
CREATE INDEX idx_market_scores_matched ON direct_exchanges_data.market_scores (is_matched, score DESC);
CREATE INDEX idx_market_scores_search ON direct_exchanges_data.market_scores USING gin (to_tsvector('english', title));
```

| Column | Type | Description |
|--------|------|-------------|
| id | VARCHAR(255) | `CM-{hash}` for matched, `K:{market_id}` or `P:{market_id}` for unmatched |
| score | DOUBLE PRECISION | Composite score (0.0–1.0) for ranking |
| notional_24h | DOUBLE PRECISION | Raw 24h notional value (used for volume sort) |
| depth | DOUBLE PRECISION | Raw band liquidity average: (bid + ask) / 2 |
| trades_24h | INTEGER | volume_traded from market_latest_data (stored in trades_24h column for compat) |
| n_norm | DOUBLE PRECISION | Max-normalized notional (0.0–1.0): value / max_value |
| d_norm | DOUBLE PRECISION | Max-normalized depth (0.0–1.0): value / max_value |
| v_norm | DOUBLE PRECISION | Max-normalized volume (0.0–1.0): value / max_value |
| category | VARCHAR(50) | Mapped 17B category slug |
| is_matched | BOOLEAN | Has cross-exchange match |
| canonical_market_id | VARCHAR(50) | NULL for unmatched markets |
| exchange_id | VARCHAR(255) | For unmatched: the exchange. For matched: NULL |
| source_id | VARCHAR(255) | For unmatched: the source. For matched: NULL |
| market_id | VARCHAR(255) | For unmatched: the exchange market_id. For matched: NULL |
| event_id | VARCHAR(255) | Event grouping ID (for multi-outcome events) |
| outcome_side | VARCHAR(10) | Always YES (NO side is implied inverse) |
| title | VARCHAR(500) | Display title (generated for matched, source for unmatched) |
| thumb | VARCHAR(50) | Emoji or image URL for market thumbnail |
| end_date | TIMESTAMPTZ | Market end date (for sorting) |
| end_date_formatted | VARCHAR(50) | Pre-formatted date string (e.g., "Dec 31, 2026") |
| volume_formatted | VARCHAR(20) | Pre-formatted volume string (e.g., "$21.3M") |
| status | VARCHAR(50) | Market status (Open, Closed) |
| updated_at | TIMESTAMPTZ | Most recent data update |
| computed_at | TIMESTAMPTZ | When this score row was computed |

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Score Computation (every 30s)                    │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ prediction_  │  │ market_      │  │ market_      │  │ trades     │ │
│  │ markets      │  │ latest_data  │  │ mappings     │  │            │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘ │
│         │                 │                  │                │        │
│         └────────┬────────┴──────────┬───────┘                │        │
│                  │                   │                         │        │
│         ┌────────▼───────────────────▼─────────────────────────▼──────┐ │
│         │  1. Build matched market set (via canonical_market_id)      │ │
│         │  2. Build unmatched market set (K:id, P:id)                │ │
│         │  3. Group multi-outcome events (via event_id/series_id)    │ │
│         │  4. Compute raw metrics per market (notional, depth, vol)   │ │
│         │  5. Max-based normalize all metrics (value/max, clamped)   │ │
│         │  6. Compute composite score: 0.55n + 0.30d + 0.15v        │ │
│         │  7. Apply category mapping                                  │ │
│         │  8. Format volume strings and dates                         │ │
│         │  9. TRUNCATE + INSERT into market_scores (atomic swap)      │ │
│         └────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
                          ┌──────────────────┐
                          │  market_scores   │
                          │  (pre-computed)  │
                          └────────┬─────────┘
                                   │
┌──────────────────────────────────▼──────────────────────────────────────┐
│                          Fastify API Server                             │
│                                                                         │
│  GET /api/v1/markets ──────────────────────────────────────────────     │
│    1. SELECT from market_scores (with filters + cursor pagination)      │
│    2. LEFT JOIN market_titles (for generated titles)                    │
│    3. For each market: fetch outcomes from prediction_markets           │
│       - Matched: query all exchanges via market_mappings               │
│       - Unmatched: query single exchange's outcomes                    │
│    4. For each outcome × exchange: get price from prediction_markets   │
│    5. Normalize prices: Polymarket * 100, Kalshi as-is                 │
│    6. Assemble response with outcome × exchange price matrix           │
│                                                                         │
│  GET /api/v1/markets/ticker ──► Top N by score, format ticker strings  │
│  GET /api/v1/categories ──► SELECT category, count from market_scores  │
│  GET /api/v1/stats ──► Aggregate from market_scores + format           │
│  GET /health ──► DB ping + last computed_at from market_scores         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Title Generation Flow (extends market-matcher)

```
┌────────────────────────────┐
│  market-matcher cycle      │
│  (existing pipeline)       │
│                            │
│  match found (conf >= 0.85)│
│         │                  │
│         ▼                  │
│  ┌──────────────────────┐  │
│  │ Check market_titles  │  │
│  │ for canonical_id     │  │
│  └──────┬───────────────┘  │
│         │                  │
│    (not exists?)           │
│         │                  │
│         ▼                  │
│  ┌──────────────────────┐  │
│  │ Call OpenAI with     │  │
│  │ title gen prompt     │  │
│  │ (same rate limiter)  │  │
│  └──────┬───────────────┘  │
│         │                  │
│         ▼                  │
│  ┌──────────────────────┐  │
│  │ UPSERT into         │  │
│  │ market_titles        │  │
│  └──────────────────────┘  │
└────────────────────────────┘
```

---

## Multi-Outcome Event Grouping

The UI shows markets as events with multiple outcomes. This requires grouping individual binary markets.

### Grouping Strategy

```
Step 1: Identify event groups
  - Kalshi: Group by event_id (populated by Kalshi API)
  - Polymarket: Group by condition_id or series_id

Step 2: For each event group with >1 market:
  - Each market in the group becomes an "outcome" in the API response
  - Use the market's outcome_name as the outcome label
  - If outcome_name is "Yes"/"No", use the market's title as the label instead

Step 3: Cross-exchange event matching
  - For matched markets: group by canonical_market_id across exchanges
  - Multiple canonical_market_ids within the same event_id = multi-outcome matched event

Step 4: Standalone markets (not part of an event group)
  - Binary Yes/No: show 2 outcomes (Yes, No)
  - Named outcome: show as single outcome with the market title
```

### Outcome Assembly Query

For a matched market:
```sql
-- Get all outcomes for a matched event
SELECT
    mm.exchange_id,
    pm.market_id,
    pm.outcome_name,
    pm.title,
    pm.price,
    pm.outcome_side
FROM direct_exchanges_data.market_mappings mm
JOIN direct_exchanges_data.prediction_markets pm
    ON mm.source_id = pm.source_id AND mm.exchange_id = pm.exchange_id
    AND mm.market_id = pm.market_id AND mm.outcome_side = pm.outcome_side
WHERE mm.canonical_market_id = $1
    AND mm.outcome_side = 'YES';
```

For an unmatched multi-outcome event:
```sql
-- Get all outcomes in an event group (same exchange)
SELECT
    market_id,
    outcome_name,
    title,
    price,
    outcome_side
FROM direct_exchanges_data.prediction_markets
WHERE exchange_id = $1
    AND event_id = $2
    AND outcome_side = 'YES'
    AND status = 'Open'
ORDER BY price DESC;
```

### Price Normalization

```typescript
function normalizePrice(price: number, exchangeId: string): number {
    if (exchangeId === 'POLYMARKET') {
        // Polymarket stores decimal (0-1), UI needs percentage (0-100)
        return Math.round(price * 100);
    }
    // Kalshi stores cents (0-100), already percentage
    return Math.round(price);
}
```

---

## Score Computation Query

The score computation background task runs every 30 seconds:

### Step 1: Gather matched markets with combined metrics (Spec V1)

The queries accept a configurable `recentWindowMinutes` parameter (default 10). Depth uses `(bid + ask) / 2` (average). Volume uses `SUM(volume_traded)` from `market_latest_data`.

```sql
-- See packages/shared/src/db/queries.ts: fetchMatchedMarketsRawData()
-- Key changes from initial implementation:
-- - Depth: MAX((bid + ask) / 2) instead of MAX(bid + ask)
-- - Volume: SUM(volume_traded) from market_latest_data instead of COUNT(trades)
-- - Notional: parameterized window (NOW() - INTERVAL '1 minute' * $1) instead of 24h
```

### Step 2: Gather unmatched markets (Spec V1)

```sql
-- See packages/shared/src/db/queries.ts: fetchUnmatchedMarketsRawData()
-- Same Spec V1 changes as matched:
-- - Depth: (bid + ask) / 2
-- - Volume: volume_traded from market_latest_data
-- - Notional: parameterized window
```

### Step 3: Normalize and compute scores (Spec V1: Max-Based)

```typescript
// Max-based normalization per Spec V1: n = value / max_value, clamped to [0, 1]
function maxNormalize(value: number, maxValue: number): number {
    if (maxValue <= 0) return 0;
    return Math.min(value / maxValue, 1);
}

function computeScores(markets: RawMarketData[]): ScoredMarket[] {
    const nMax = Math.max(...markets.map(m => m.notional_recent), 0);
    const dMax = Math.max(...markets.map(m => m.depth), 0);
    const vMax = Math.max(...markets.map(m => m.volume_24h), 0);

    return markets.map(m => {
        const n_norm = maxNormalize(m.notional_recent, nMax);
        const d_norm = maxNormalize(m.depth, dMax);
        const v_norm = maxNormalize(m.volume_24h, vMax);
        const score = 0.55 * n_norm + 0.30 * d_norm + 0.15 * v_norm;

        return {
            ...m,
            n_norm, d_norm, v_norm, score,
            category: mapCategory(m.category),
            volume_formatted: formatVolume(m.volume_24h),
            end_date_formatted: formatDate(m.end_date),
        };
    });
}
```

### Step 4: Atomic table swap

```sql
BEGIN;
TRUNCATE direct_exchanges_data.market_scores;
INSERT INTO direct_exchanges_data.market_scores
    (id, score, notional_24h, depth, trades_24h, n_norm, d_norm, v_norm,
     category, is_matched, canonical_market_id, exchange_id, source_id,
     market_id, event_id, outcome_side, title, thumb, end_date,
     end_date_formatted, volume_formatted, status, updated_at, computed_at)
VALUES ($1, $2, ...);
COMMIT;
```

---

## Category Mapping (Application Code)

```typescript
const KALSHI_CATEGORY_MAP: Record<string, string> = {
    'Sports': 'sports',
    'Crypto': 'crypto',
    'Entertainment': 'entertainment',
    'Politics': 'politics',
    'Elections': 'politics',
    'Economics': 'economics',
    'Financials': 'economics',
    'Companies': 'economics',
};

function mapCategory(kalshiCategory: string | null): string | null {
    if (!kalshiCategory) return null;
    return KALSHI_CATEGORY_MAP[kalshiCategory] ?? null;
}
```

Categories not in the map (Climate and Weather, Mentions, Science and Technology, Social, World, Health, Transportation) return `null` — included in "All" view but no named category pill.

---

## Ticker Item Generation

The ticker endpoint builds pre-formatted text strings from the top markets:

```typescript
function buildTickerItems(topMarkets: ScoredMarket[]): TickerItem[] {
    return topMarkets.map(m => {
        const tag = getTickerTag(m.category);
        const pricesText = buildPriceComparisonText(m);
        return {
            tag,
            text: `${m.title}: ${pricesText}`,
        };
    });
}

function getTickerTag(category: string | null): string {
    switch (category) {
        case 'crypto': return '₿ CRYPTO';
        case 'politics': return '🗳️ ELECTION';
        case 'sports': return '🏀 SPORTS';
        case 'economics': return '📊 DATA';
        default: return '🔴 LIVE';
    }
}
```

---

## Package Structure

```
packages/homepage-api/
├── package.json              # @prediction-market/homepage-api
├── tsconfig.json             # extends ../../tsconfig.base.json
├── Dockerfile
└── src/
    ├── index.ts              # Entry: config -> start server -> start score loop -> SIGTERM
    ├── config.ts             # Validate DATABASE_URL + load env vars
    ├── server.ts             # Fastify setup, @fastify/swagger, @fastify/cors, route registration
    ├── types.ts              # API response types, ScoredMarket, TickerItem, etc.
    ├── categoryMap.ts        # KALSHI_CATEGORY_MAP constant + mapCategory()
    ├── routes/
    │   ├── markets.ts        # GET /api/v1/markets (ranked list with pagination)
    │   ├── ticker.ts         # GET /api/v1/markets/ticker (pre-formatted ticker strings)
    │   ├── categories.ts     # GET /api/v1/categories (counts per category)
    │   ├── stats.ts          # GET /api/v1/stats (aggregate platform stats)
    │   └── health.ts         # GET /health
    ├── services/
    │   ├── scoreComputer.ts  # Background loop: query raw data -> normalize -> write market_scores
    │   ├── outcomeAssembler.ts # Build outcome × exchange price matrix for API response
    │   └── tickerBuilder.ts  # Generate ticker item text from top markets
    └── utils/
        ├── cursor.ts         # encodeCursor(), decodeCursor() (base64 JSON)
        ├── pagination.ts     # buildPaginationQuery() (keyset WHERE clause)
        └── formatters.ts     # formatVolume(), formatDate(), normalizePrice()
```

---

## Dependencies

### Prerequisites

1. Database migrations must be run (`market_titles` and `market_scores` tables)
2. `prediction_markets` table must be populated by listeners
3. `market_mappings` table must be populated by market-matcher
4. `market_latest_data` table must have band metrics

### Runtime Dependencies

| Component | Required For |
|-----------|-------------|
| PostgreSQL | All data reads/writes |
| shared package | DB client, logger, types |
| market-matcher | Populates market_mappings and market_titles |

### npm Dependencies

| Package | Purpose |
|---------|---------|
| `fastify` | HTTP server framework |
| `@fastify/swagger` | OpenAPI spec generation |
| `@fastify/swagger-ui` | Swagger UI at /api/v1/docs |
| `@fastify/cors` | CORS headers for browser clients |

---

## Title Generation Extension (market-matcher changes)

### New file: `packages/market-matcher/src/services/titleGenerator.ts`

```typescript
export async function generateTitle(
    kalshiTitle: string,
    polymarketTitle: string,
    apiKey: string,
    model: string,
    rateLimitDelayMs: number
): Promise<string | null> {
    // Uses same OpenAI call pattern as aiComparer.ts
    // System prompt: financial market title editor
    // Returns generated title or null on failure
}
```

### Changes to `matchingCycle.ts`

After `writeMatches()` succeeds:

```typescript
if (batchMatches.length > 0) {
    const written = await writeMatches(batchMatches, config.matchVersion);

    for (const match of batchMatches) {
        const existingTitle = await checkExistingTitle(match.canonicalMarketId);
        if (!existingTitle) {
            const title = await generateTitle(
                kalshiMarket.title,
                polymarketCandidate.title,
                config.openaiApiKey,
                config.titleGenerationModel ?? config.openaiModel,
                rateLimitDelayMs
            );
            if (title) {
                await upsertMarketTitle(
                    match.canonicalMarketId, title,
                    kalshiMarket.title, polymarketCandidate.title,
                    config.openaiModel
                );
            }
        }
    }
}
```

### New shared query: `upsertMarketTitle()`

```typescript
export async function upsertMarketTitle(
    canonicalMarketId: string,
    generatedTitle: string,
    kalshiTitle: string,
    polymarketTitle: string,
    modelId: string
): Promise<void> {
    await pool.query(`
        INSERT INTO direct_exchanges_data.market_titles
            (canonical_market_id, generated_title, kalshi_title, polymarket_title, model_id, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (canonical_market_id) DO UPDATE SET
            generated_title = EXCLUDED.generated_title,
            kalshi_title = EXCLUDED.kalshi_title,
            polymarket_title = EXCLUDED.polymarket_title,
            model_id = EXCLUDED.model_id,
            updated_at = NOW()
    `, [canonicalMarketId, generatedTitle, kalshiTitle, polymarketTitle, modelId]);
}
```

---

## Migration Checklist

- [x] Run `CREATE TABLE market_titles` migration on server
- [x] Run `CREATE TABLE market_scores` migration with indexes
- [x] Deploy updated shared package (new query functions, types)
- [x] Deploy updated market-matcher (title generation extension)
- [x] Verify titles being generated: `SELECT COUNT(*) FROM market_titles`
- [x] Deploy homepage-api service
- [x] Add homepage-api to docker-compose.yml
- [x] Verify score computation running: 51,207 markets scored with max-based normalization
- [x] Verify API responds: `curl http://localhost:3100/api/v1/markets`
- [x] Verify health endpoint: `curl http://localhost:3100/health`
- [x] Create `idx_market_scores_score` index for Spec V1 sort order
- [x] Add OpenAPI JSON schemas to all routes
- [x] Add `GET /api/v1/openapi.json` endpoint
- [ ] Open port 3100 in Alibaba Cloud security group (pending)
- [ ] Run integration test suite (see requirements.md T1–T16)

---

## Rollback Plan

### Stop homepage-api

```bash
docker compose stop homepage-api
```

### Clear computed scores

```sql
TRUNCATE direct_exchanges_data.market_scores;
```

### Remove title generation (revert market-matcher)

```bash
docker compose stop market-matcher
# Deploy previous version without title generation
docker compose up -d market-matcher
```

### Drop new tables (full rollback)

```sql
DROP TABLE IF EXISTS direct_exchanges_data.market_scores;
DROP TABLE IF EXISTS direct_exchanges_data.market_titles;
```

---

## Testing Strategy

### Unit Tests

| File | Test Cases |
|------|-----------|
| `scoreComputer.test.ts` | Max-based normalization (maxNormalize), score formula, clamping, zero-data, edge cases |
| `cursor.test.ts` | Encode/decode round-trip, invalid cursor, special characters in IDs |
| `categoryMap.test.ts` | All 15 Kalshi categories map correctly, null/unknown returns null |
| `outcomeAssembler.test.ts` | Multi-outcome events, binary markets, price normalization per exchange |
| `tickerBuilder.test.ts` | Tag selection, price comparison text, empty data handling |
| `formatters.test.ts` | formatVolume ($K/$M/$B), formatDate, normalizePrice (Kalshi vs Polymarket) |
| `pagination.test.ts` | Keyset WHERE clause generation, volume sort, closes_soon sort |

### Integration Tests (Post-Deployment)

See requirements.md section "Integration Test Scenarios" (T1–T16). These tests:
- Run against the live API after each deployment
- Use real data from the database
- Verify response structure, filtering, sorting, pagination, and data freshness
- Should be automated as a test script in `packages/homepage-api/test/integration/`

### Manual Verification

1. Check score computation: see usage.md for SQL queries
2. Check API responses: see usage.md for curl examples
3. Check title generation: see usage.md for title verification queries

---

## Performance Considerations

- **Score pre-computation** — The ranking query involves JOINs across 4 tables + aggregation. Pre-computing every 30s avoids 2–5s latency per API request.
- **TRUNCATE + INSERT** — Atomic swap ensures consistent reads. No partial writes visible.
- **Indexed pagination** — Composite indexes on `(score DESC, updated_at DESC, id ASC)` and `(end_date ASC NULLS LAST, updated_at DESC, id ASC)` support efficient keyset pagination.
- **Category index** — Separate index on `(category, score DESC)` avoids full scan when filtering.
- **Outcome assembly** — Per-exchange prices are fetched in batch per page using `IN (id_list)`, not per-market.
- **Connection pooling** — Reuses shared package DB client (10 connections default).
- **Title generation rate** — Shares the matcher's OpenAI rate limiter (50 RPM). Each title adds ~1.2s.
- **Trades table partitioning** — 24h trade aggregation benefits from existing hourly partition pruning.
- **GIN index for search** — `to_tsvector('english', title)` enables fast full-text search on market titles.
