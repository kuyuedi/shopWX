# Usage: AI-Powered Cross-Exchange Market Matching

How to use, query, and verify the market matcher service.

---

## Deployment

```bash
# Deploy market-matcher to production (Japan server)
./deploy-matcher.sh
```

The deploy script will:
1. Run all unit tests locally
2. SSH to server, pull latest code
3. Build Docker container
4. Restart market-matcher service

---

## Database Table

**Table:** `direct_exchanges_data.market_mappings`

### Columns

| Column | Type | Description |
|--------|------|-------------|
| mapping_id | UUID | Primary key |
| source_id | VARCHAR(255) | KALSHI_DIRECT or POLY_DIRECT |
| exchange_id | VARCHAR(255) | KALSHI or POLYMARKET |
| market_id | VARCHAR(255) | Exchange-specific market identifier |
| outcome_side | VARCHAR(10) | YES or NO |
| canonical_market_id | VARCHAR(50) | Shared ID linking equivalent markets (format: CM-{hash}) |
| confidence_score | DOUBLE PRECISION | AI match confidence (0.0-1.0) |
| matched_at | TIMESTAMPTZ | When the match was detected |
| model_id | VARCHAR(50) | Model used (e.g. gpt-5-nano) |
| match_version | INTEGER | Prompt/schema version |
| is_active | BOOLEAN | Whether the mapping is active |
| created_at | TIMESTAMPTZ | Row creation time |
| updated_at | TIMESTAMPTZ | Row last update time |

### How Matches Are Stored

Each match creates **2 rows** in `market_mappings` — one for Kalshi, one for Polymarket — linked by the same `canonical_market_id`. The canonical ID is deterministic: `CM-` + first 16 chars of SHA256(sorted market keys + outcome_side).

---

## SQL Queries

### List all matched pairs

```sql
SELECT a.market_id AS kalshi, b.market_id AS polymarket,
       a.outcome_side, a.confidence_score, a.model_id, a.created_at
FROM direct_exchanges_data.market_mappings a
JOIN direct_exchanges_data.market_mappings b
  ON a.canonical_market_id = b.canonical_market_id
WHERE a.exchange_id = 'KALSHI' AND b.exchange_id = 'POLYMARKET'
ORDER BY a.created_at DESC;
```

### List matched pairs with market titles

```sql
SELECT a.market_id AS kalshi_id, ka.title AS kalshi_title,
       b.market_id AS poly_id, pa.title AS poly_title,
       a.confidence_score, a.outcome_side
FROM direct_exchanges_data.market_mappings a
JOIN direct_exchanges_data.market_mappings b
  ON a.canonical_market_id = b.canonical_market_id
JOIN direct_exchanges_data.prediction_markets ka
  ON a.source_id = ka.source_id AND a.exchange_id = ka.exchange_id
  AND a.market_id = ka.market_id AND a.outcome_side = ka.outcome_side
JOIN direct_exchanges_data.prediction_markets pa
  ON b.source_id = pa.source_id AND b.exchange_id = pa.exchange_id
  AND b.market_id = pa.market_id AND b.outcome_side = pa.outcome_side
WHERE a.exchange_id = 'KALSHI' AND b.exchange_id = 'POLYMARKET'
ORDER BY a.created_at DESC;
```

### Count total matched pairs

```sql
SELECT COUNT(*) / 2 AS match_pairs
FROM direct_exchanges_data.market_mappings;
```

### Count matches by outcome side

```sql
SELECT exchange_id, outcome_side, COUNT(*) AS match_count
FROM direct_exchanges_data.market_mappings
WHERE model_id IS NOT NULL
GROUP BY exchange_id, outcome_side
ORDER BY exchange_id, outcome_side;
```

### Match statistics

```sql
SELECT
    model_id,
    match_version,
    COUNT(DISTINCT canonical_market_id) AS unique_matches,
    COUNT(*) AS total_rows,
    AVG(confidence_score) AS avg_confidence,
    MIN(confidence_score) AS min_confidence,
    MAX(matched_at) AS latest_match
FROM direct_exchanges_data.market_mappings
WHERE model_id IS NOT NULL
GROUP BY model_id, match_version;
```

### Price spreads for matched markets (arbitrage opportunities)

```sql
SELECT
    mm.canonical_market_id,
    MAX(CASE WHEN mm.exchange_id = 'KALSHI' THEN pm.title END) AS kalshi_title,
    MAX(CASE WHEN mm.exchange_id = 'KALSHI' THEN pm.price END) AS kalshi_price,
    MAX(CASE WHEN mm.exchange_id = 'POLYMARKET' THEN pm.price END) AS poly_price,
    ABS(
      MAX(CASE WHEN mm.exchange_id = 'KALSHI' THEN pm.price END) -
      MAX(CASE WHEN mm.exchange_id = 'POLYMARKET' THEN pm.price END)
    ) AS price_spread,
    mm.outcome_side
FROM direct_exchanges_data.market_mappings mm
JOIN direct_exchanges_data.prediction_markets pm
  ON mm.source_id = pm.source_id AND mm.exchange_id = pm.exchange_id
  AND mm.market_id = pm.market_id AND mm.outcome_side = pm.outcome_side
WHERE mm.model_id IS NOT NULL
GROUP BY mm.canonical_market_id, mm.outcome_side
ORDER BY price_spread DESC;
```

### Recent matches (last hour)

```sql
SELECT a.market_id AS kalshi, b.market_id AS polymarket,
       a.confidence_score, a.outcome_side, a.matched_at
FROM direct_exchanges_data.market_mappings a
JOIN direct_exchanges_data.market_mappings b
  ON a.canonical_market_id = b.canonical_market_id
WHERE a.exchange_id = 'KALSHI' AND b.exchange_id = 'POLYMARKET'
  AND a.matched_at > NOW() - INTERVAL '1 hour'
ORDER BY a.matched_at DESC;
```

---

## Monitoring

### Check service logs

```bash
# SSH to server
ssh root@8.216.43.26

# View recent logs
docker compose logs --tail 50 market-matcher

# Follow logs in real-time
docker compose logs -f market-matcher
```

### Key log messages to look for

| Message | Meaning |
|---------|---------|
| `Fetched markets for matching` | Cycle started, shows market counts |
| `Pre-filter: standard outcomes` | Shows how many markets passed outcome filter |
| `Filtered already-matched markets` | Shows skip count for existing matches |
| `Match found` | AI found a match — includes both market IDs and confidence |
| `Matches written to DB` | Match persisted to database |
| `Matching cycle completed for side` | Side finished — shows total matches and API calls |
| `OpenAI request failed, retrying` | Timeout or API error — will retry up to 3 times |

---

## Troubleshooting

### No matches being written

1. Check service logs: `docker compose logs --tail 50 market-matcher`
2. Verify markets exist:
```sql
SELECT exchange_id, COUNT(*)
FROM direct_exchanges_data.prediction_markets
WHERE status = 'Open'
GROUP BY exchange_id;
```
3. Check OPENAI_API_KEY is set and valid
4. Check for pre-filter exclusions in logs (no keyword overlap, expiry mismatches)

### Service not starting

1. Verify `OPENAI_API_KEY` is set (required)
2. Verify database is accessible
3. Check Docker logs: `docker compose logs market-matcher`

### Cycle taking too long

- Expected: ~30+ minutes for 32k markets at ~1.2s per API call
- Keyword pre-filter skips most markets (no overlap = no API call)
- Matches are written immediately, so partial progress is preserved

### Clear all matches and re-run

```sql
DELETE FROM direct_exchanges_data.market_mappings WHERE model_id IS NOT NULL;
```

Then restart the service:
```bash
docker compose restart market-matcher
```
