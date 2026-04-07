# N-Exchange Matching — Usage & Verification

## Configuration

### Enable/Disable Exchange Pairs

Set environment variables in `docker-compose.yml` or pass to the event-matcher container:

```yaml
environment:
  ENABLE_PREDICT_MATCHING: "true"    # Predict derived pairs (default: true)
  ENABLE_OPINION_MATCHING: "false"   # Opinion AI pairs (default: false)
  ENABLE_PHASE2: "false"             # Phase 2 cross-event matching
```

### Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `MATCHER_CONCURRENCY` | `20` | AI matching workers per pair |
| `MATCHER_INTERVAL_MS` | `300000` | Cycle interval (5 min) |
| `MATCHER_CONFIDENCE_THRESHOLD` | `0.85` | Min confidence for AI event match |
| `MATCHER_RECHECK_INTERVAL_MS` | `86400000` | Recheck unmatched events after 24h |

---

## Database Tables

### `event_mappings`

| Column | Type | Description |
|--------|------|-------------|
| `source_id` | VARCHAR(50) | Source identifier |
| `exchange_id` | VARCHAR(50) | Exchange (KALSHI, POLYMARKET, PREDICT, OPINIONTRADE) |
| `event_id` | VARCHAR(255) | Exchange-specific event ID |
| `canonical_event_id` | VARCHAR(50) | Shared group ID (e.g., `CE-a1b2c3d4e5f67890`) |
| `confidence_score` | NUMERIC | 0–1, 1.0 for derived matches |
| `model_id` | VARCHAR(100) | Matching method used |
| `is_active` | BOOLEAN | Whether mapping is active |
| `match_checked_at` | TIMESTAMPTZ | Last time event was checked for matches |

### `market_mappings`

| Column | Type | Description |
|--------|------|-------------|
| `source_id` | VARCHAR(50) | Source identifier |
| `exchange_id` | VARCHAR(50) | Exchange |
| `market_id` | VARCHAR(255) | Exchange-specific market ID |
| `outcome_side` | VARCHAR(10) | YES or NO |
| `canonical_market_id` | VARCHAR(50) | Shared group ID (e.g., `CM-a1b2c3d4e5f67890`) |

**Key `model_id` values:**

| model_id | Strategy | Description |
|----------|----------|-------------|
| `gpt-5-nano` (or configured model) | AI | OpenAI event comparison |
| `derived-from-market-mappings-v1` | Derived | Inferred from market_mappings |
| `predict-api-link-v1` | API link | Predict cross-mapping (market level) |
| `algorithmic-v1` | Algorithmic | Binary 1:1 or Jaccard >= 0.85 |
| `substring-v1` | Algorithmic | Substring market matching |
| `ai-verified-v1` | AI | Borderline Jaccard + AI verification |

---

## Verification Queries

### 1. Event mappings by exchange

```sql
SELECT exchange_id, COUNT(*)
FROM direct_exchanges_data.event_mappings
WHERE is_active = TRUE
GROUP BY exchange_id
ORDER BY exchange_id;
```

**Expected:** Rows for KALSHI, POLYMARKET, and PREDICT. OPINIONTRADE appears only if Opinion matching is enabled.

### 2. Canonical groups with 3+ exchanges

```sql
SELECT canonical_event_id, array_agg(DISTINCT exchange_id) as exchanges, COUNT(*)
FROM direct_exchanges_data.event_mappings
WHERE is_active = TRUE
GROUP BY canonical_event_id
HAVING COUNT(DISTINCT exchange_id) >= 3
ORDER BY COUNT(*) DESC;
```

**Expected:** Rows showing `{KALSHI,POLYMARKET,PREDICT}` — these are events matched transitively across all three exchanges.

### 3. Derived vs AI match counts

```sql
SELECT model_id, COUNT(*)
FROM direct_exchanges_data.event_mappings
WHERE is_active = TRUE
GROUP BY model_id
ORDER BY COUNT(*) DESC;
```

**Expected:** `derived-from-market-mappings-v1` entries for Predict pairs, configured OpenAI model for K↔P pairs.

### 4. Market mappings with 3+ exchanges

```sql
SELECT canonical_market_id, array_agg(DISTINCT exchange_id) as exchanges
FROM direct_exchanges_data.market_mappings
GROUP BY canonical_market_id
HAVING COUNT(DISTINCT exchange_id) >= 3
LIMIT 20;
```

### 5. Recent matching activity

```sql
SELECT exchange_id, model_id, COUNT(*), MAX(matched_at) as last_match
FROM direct_exchanges_data.event_mappings
WHERE matched_at > NOW() - INTERVAL '24 hours'
GROUP BY exchange_id, model_id
ORDER BY last_match DESC;
```

---

## Predict Data Fetching

The predict-listener fetches both events and markets from a single paginated API:

```
GET /v1/categories?status=OPEN   (paginated, ~449 categories, 23 pages)
```

Each category = 1 event. Markets are nested inside each category and extracted client-side (only `tradingStatus=OPEN` + `status=REGISTERED`). No separate `/v1/markets` call is needed.

**Key file:** `packages/predict-listener/src/services/marketSync.ts`

Cross-exchange links (`kalshiMarketTicker`, `polymarketConditionIds`) on each market drive the `predict-api-link-v1` market_mappings, which in turn drive derived event matching.

---

## Deployment

```bash
# Deploy event-matcher with changes
./deploy-event-matcher.sh

# Deploy predict-listener (categories fetch, cross-mapping)
./deploy-predict.sh
```

No database migration required — existing tables support N-exchange matching.

### Verify after deployment

```bash
# Check logs for pair matching
ssh root@8.216.43.26 "docker compose -f /opt/prediction-market-ingestion/docker-compose.yml logs --tail 50 event-matcher | grep -E 'pair matching|derived'"
```

Look for log lines like:
```
Starting AI pair matching {"source":"KALSHI","target":"POLYMARKET"}
Starting derived pair matching {"source":"KALSHI","target":"PREDICT"}
Starting derived pair matching {"source":"POLYMARKET","target":"PREDICT"}
Derived pair matching complete {"eventMatchesCreated":5}
```

---

## Troubleshooting

### No Predict event mappings appearing

1. Check that `ENABLE_PREDICT_MATCHING` is not set to `"false"`
2. Verify Predict events exist (should be ~449 Open):
   ```sql
   SELECT status, COUNT(*) FROM direct_exchanges_data.events
   WHERE exchange_id = 'PREDICT' GROUP BY status;
   ```
3. If very few Open events, check predict-listener logs for categories pagination — it should fetch ~23 pages
4. Verify Predict market_mappings exist:
   ```sql
   SELECT COUNT(*) FROM direct_exchanges_data.market_mappings
   WHERE exchange_id = 'PREDICT';
   ```
5. If zero, check predict-listener logs — crossMapping may be failing

### Transitive grouping not working (separate canonical groups instead of merged)

This happens when the first pair's match hasn't been written before the second pair runs. Since pairs run sequentially, this should not occur in normal operation. Check for errors in the first pair's matching that might prevent writes.

### Opinion matching not running

Opinion pairs are disabled by default. Set `ENABLE_OPINION_MATCHING=true` in the event-matcher environment. Ensure Opinion events exist in the `events` table first.

### Canonical ID mismatch with old data

The new `generateCanonicalId()` is backward compatible with old K↔P IDs. If you see duplicate canonical groups for the same K↔P pair, check whether the old hardcoded functions were modified before the migration.
