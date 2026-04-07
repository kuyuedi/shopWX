# Usage: Homepage API

How to run, query, and verify the homepage API service.

---

## Local Development

### Prerequisites

```bash
# Install dependencies
pnpm install

# Ensure DATABASE_URL is set (or copy from .env.example)
export DATABASE_URL="postgresql://..."
export DB_SCHEMA="direct_exchanges_data"
```

### Run locally

```bash
# Dev mode with hot reload
pnpm dev:homepage-api

# Or build and run
pnpm build
node packages/homepage-api/dist/index.js
```

The API starts on `http://localhost:3100` by default.

### Verify locally

```bash
curl http://localhost:3100/health
curl http://localhost:3100/api/v1/markets?limit=3
curl http://localhost:3100/api/v1/categories
curl http://localhost:3100/api/v1/stats
```

---

## Docker Deployment

### Build and run

```bash
docker compose up -d homepage-api
```

### View logs

```bash
docker compose logs --tail 50 homepage-api
docker compose logs -f homepage-api
```

### Restart

```bash
docker compose restart homepage-api
```

### Deploy to production

```bash
./deploy-homepage-api.sh
```

---

## Database Tables

### `market_scores`

Pre-computed ranking scores, refreshed every 30s.

| Column | Type | Description |
|--------|------|-------------|
| id | VARCHAR(255) | `CM-{hash}` for matched, `K:{id}` or `P:{id}` for unmatched |
| score | DOUBLE PRECISION | Composite ranking score (0.0–1.0) |
| notional_24h | DOUBLE PRECISION | Recent notional (price × qty, configurable window) |
| depth | DOUBLE PRECISION | Average band liquidity: (bid + ask) / 2 |
| trades_24h | INTEGER | volume_traded from market_latest_data |
| category | VARCHAR(50) | Mapped 17B category |
| is_matched | BOOLEAN | Has cross-exchange match |
| volume_formatted | VARCHAR(20) | Pre-formatted (e.g., "$21.3M") |
| end_date_formatted | VARCHAR(50) | Pre-formatted (e.g., "Dec 31, 2026") |
| title | VARCHAR(500) | Display title |
| computed_at | TIMESTAMPTZ | When this computation ran |

### `market_titles`

AI-generated unified titles for matched market pairs.

| Column | Type | Description |
|--------|------|-------------|
| canonical_market_id | VARCHAR(50) | PK, links to market_mappings |
| generated_title | VARCHAR(500) | AI-generated title |
| kalshi_title | TEXT | Original Kalshi title |
| polymarket_title | TEXT | Original Polymarket title |
| model_id | VARCHAR(50) | OpenAI model used |

---

## API Endpoint Examples

### List markets (default: sorted by score DESC per Spec V1)

```bash
curl 'http://localhost:3100/api/v1/markets?limit=5'
```

### Filter by category

```bash
curl 'http://localhost:3100/api/v1/markets?category=crypto&limit=5'
```

### Filter by exchange

```bash
# Only markets available on Kalshi
curl 'http://localhost:3100/api/v1/markets?exchange=kal&limit=5'

# Markets on Kalshi or Polymarket
curl 'http://localhost:3100/api/v1/markets?exchange=kal,poly&limit=5'
```

### Search by title

```bash
curl 'http://localhost:3100/api/v1/markets?search=bitcoin&limit=5'
```

### Sort by deadline

```bash
curl 'http://localhost:3100/api/v1/markets?sort=closes_soon&limit=5'
```

### Include all markets (matched + unmatched)

```bash
# Default returns matched (cross-exchange) markets only
curl 'http://localhost:3100/api/v1/markets?limit=5'

# Explicitly include all markets
curl 'http://localhost:3100/api/v1/markets?matched=all&limit=5'

# Only single-exchange (unmatched) markets
curl 'http://localhost:3100/api/v1/markets?matched=false&limit=5'
```

### Paginate (infinite scroll)

```bash
# First page
curl 'http://localhost:3100/api/v1/markets?limit=10'
# Response includes next_cursor

# Next page
curl 'http://localhost:3100/api/v1/markets?limit=10&cursor=eyJzIj...'
```

### Ticker

```bash
curl 'http://localhost:3100/api/v1/markets/ticker'
```

### Categories

```bash
curl 'http://localhost:3100/api/v1/categories'
```

### Stats

```bash
curl 'http://localhost:3100/api/v1/stats'
```

### Health check

```bash
curl 'http://localhost:3100/health'
```

### OpenAPI spec (for frontend team / Postman)

```bash
curl 'http://localhost:3100/api/v1/openapi.json'
```

### Swagger UI

Open in browser: `http://localhost:3100/api/v1/docs`

---

## Verification Queries

Run these SQL queries on the database to verify the system is working.

### Check score computation is running

```sql
SELECT
    COUNT(*) AS total_scored,
    COUNT(*) FILTER (WHERE is_matched) AS matched,
    COUNT(*) FILTER (WHERE NOT is_matched) AS unmatched,
    MAX(computed_at) AS last_computation,
    NOW() - MAX(computed_at) AS time_since_last
FROM direct_exchanges_data.market_scores;
```

Expected: `time_since_last` should be < 60 seconds.

### Score distribution

```sql
SELECT
    CASE
        WHEN score >= 0.8 THEN 'High (0.8+)'
        WHEN score >= 0.5 THEN 'Medium (0.5-0.8)'
        WHEN score >= 0.2 THEN 'Low (0.2-0.5)'
        ELSE 'Minimal (<0.2)'
    END AS tier,
    COUNT(*) AS count,
    AVG(notional_24h)::BIGINT AS avg_notional,
    AVG(trades_24h)::INTEGER AS avg_trades
FROM direct_exchanges_data.market_scores
GROUP BY 1
ORDER BY MIN(score) DESC;
```

### Category breakdown

```sql
SELECT
    COALESCE(category, 'uncategorized') AS category,
    COUNT(*) AS count,
    SUM(notional_24h)::BIGINT AS total_notional
FROM direct_exchanges_data.market_scores
GROUP BY 1
ORDER BY count DESC;
```

### Top markets by score (Spec V1 default sort)

```sql
SELECT id, title, volume_formatted, score, n_norm, d_norm, v_norm, category, is_matched
FROM direct_exchanges_data.market_scores
ORDER BY score DESC, updated_at DESC, id ASC
LIMIT 20;
```

### Check titles are being generated

```sql
SELECT
    COUNT(*) AS total_titles,
    MAX(created_at) AS latest_title,
    AVG(LENGTH(generated_title))::INTEGER AS avg_title_length
FROM direct_exchanges_data.market_titles;
```

### Sample titles with comparison

```sql
SELECT
    mt.canonical_market_id,
    mt.generated_title,
    mt.kalshi_title,
    mt.polymarket_title,
    mt.model_id,
    mt.created_at
FROM direct_exchanges_data.market_titles mt
ORDER BY mt.created_at DESC
LIMIT 10;
```

### Matched market price comparison

```sql
SELECT
    ms.id,
    ms.title,
    ms.volume_formatted,
    mm_k.market_id AS kalshi_id,
    pm_k.price AS kalshi_price,
    mm_p.market_id AS poly_id,
    pm_p.price AS poly_price,
    ABS(pm_k.price - pm_p.price * 100) AS price_diff_pct
FROM direct_exchanges_data.market_scores ms
JOIN direct_exchanges_data.market_mappings mm_k
    ON ms.canonical_market_id = mm_k.canonical_market_id
    AND mm_k.exchange_id = 'KALSHI' AND mm_k.outcome_side = 'YES'
JOIN direct_exchanges_data.market_mappings mm_p
    ON ms.canonical_market_id = mm_p.canonical_market_id
    AND mm_p.exchange_id = 'POLYMARKET' AND mm_p.outcome_side = 'YES'
JOIN direct_exchanges_data.prediction_markets pm_k
    ON mm_k.source_id = pm_k.source_id AND mm_k.exchange_id = pm_k.exchange_id
    AND mm_k.market_id = pm_k.market_id AND mm_k.outcome_side = pm_k.outcome_side
JOIN direct_exchanges_data.prediction_markets pm_p
    ON mm_p.source_id = pm_p.source_id AND mm_p.exchange_id = pm_p.exchange_id
    AND mm_p.market_id = pm_p.market_id AND mm_p.outcome_side = pm_p.outcome_side
WHERE ms.is_matched = true
ORDER BY ms.notional_24h DESC
LIMIT 10;
```

### Data freshness check

```sql
SELECT
    'market_scores' AS source,
    MAX(computed_at) AS latest_update,
    NOW() - MAX(computed_at) AS staleness
FROM direct_exchanges_data.market_scores
UNION ALL
SELECT
    'market_titles',
    MAX(updated_at),
    NOW() - MAX(updated_at)
FROM direct_exchanges_data.market_titles
UNION ALL
SELECT
    'prediction_markets',
    MAX(updated_at),
    NOW() - MAX(updated_at)
FROM direct_exchanges_data.prediction_markets
WHERE status = 'Open';
```

---

## Monitoring

### Key log messages

| Message | Meaning |
|---------|---------|
| `Server listening on port 3100` | API started successfully |
| `Score computation started` | Background score cycle beginning |
| `Score computation completed` | Cycle done — shows market count and duration |
| `Score computation failed` | Error in score cycle — check DB connectivity |
| `Title generated for CM-xxx` | New AI title written to market_titles |
| `Title generation failed for CM-xxx` | OpenAI call failed — will retry next cycle |

### Health check monitoring

```bash
# Quick health check (returns 200 if healthy)
curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/health

# Full health response
curl -s http://localhost:3100/health | jq .
```

### Check on server

```bash
# SSH to server
ssh root@8.216.43.26

# View recent logs
docker compose logs --tail 50 homepage-api

# Follow logs in real-time
docker compose logs -f homepage-api

# Check container status
docker compose ps homepage-api
```

---

## Troubleshooting

### API returns empty markets

1. Check score computation is running:
```sql
SELECT COUNT(*), MAX(computed_at)
FROM direct_exchanges_data.market_scores;
```
2. If count is 0, check if prediction_markets has data:
```sql
SELECT exchange_id, COUNT(*)
FROM direct_exchanges_data.prediction_markets
WHERE status = 'Open'
GROUP BY exchange_id;
```
3. Check service logs for score computation errors

### Scores are all 0

1. Check if trades exist in the recent window (default 10 min):
```sql
SELECT COUNT(*)
FROM direct_exchanges_data.trades
WHERE timestamp > NOW() - INTERVAL '10 minutes';
```
2. Check if band metrics are populated:
```sql
SELECT COUNT(*)
FROM direct_exchanges_data.market_latest_data
WHERE band_liquidity_qty_bid IS NOT NULL;
```
3. Check if volume_traded is populated:
```sql
SELECT COUNT(*), SUM(volume_traded)
FROM direct_exchanges_data.market_latest_data
WHERE volume_traded > 0;
```

### No matched markets showing

1. Verify market_mappings has data:
```sql
SELECT COUNT(*) FROM direct_exchanges_data.market_mappings;
```
2. Check market-matcher is running:
```bash
docker compose logs --tail 20 market-matcher
```

### Titles not being generated

1. Check market_titles table:
```sql
SELECT COUNT(*) FROM direct_exchanges_data.market_titles;
```
2. Check market-matcher logs for title generation errors
3. Verify OPENAI_API_KEY is set in market-matcher config

### Score computation taking too long

- Expected: < 10 seconds for ~50k markets
- If slower: check database connection pooling and index creation
- The trades JOIN is the heaviest — ensure partition pruning is working

### API returning stale data

- Scores refresh every 30s — data is expected to be up to 30s stale
- If `last_score_computation` in /health is more than 2 minutes old, the score loop may have crashed
- Check logs for errors and restart the service

---

## Integration Test Runner

After deployment, run the integration test suite:

```bash
# Run all integration tests against production
HOMEPAGE_API_URL=http://localhost:3100 pnpm test:integration --filter homepage-api

# Or run against the server directly
HOMEPAGE_API_URL=http://8.216.43.26:3100 pnpm test:integration --filter homepage-api
```

The tests (T1–T16 from requirements.md) verify:
- All endpoints return valid responses
- Filtering, sorting, and pagination work correctly
- Data is fresh and prices are in the correct range
- Error handling returns proper status codes

See `packages/homepage-api/test/integration/` for the test files.
