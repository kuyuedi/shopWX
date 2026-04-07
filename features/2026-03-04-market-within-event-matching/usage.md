# Usage: Market-Within-Event Matching

How to use and verify this feature.

---

## Verification Queries

### 1. Verify event matches exist (source_id fix working)

```sql
SELECT COUNT(*) FROM direct_exchanges_data.event_mappings WHERE is_active = TRUE;
```

**Expected:** Non-zero count (was 0 before source_id fix).

### 2. View matched event pairs

```sql
SELECT a.event_id as kalshi_event, b.event_id as poly_event,
       a.confidence_score, a.canonical_event_id
FROM direct_exchanges_data.event_mappings a
JOIN direct_exchanges_data.event_mappings b
  ON a.canonical_event_id = b.canonical_event_id
WHERE a.exchange_id = 'KALSHI' AND b.exchange_id = 'POLYMARKET'
  AND a.is_active = TRUE AND b.is_active = TRUE
ORDER BY a.confidence_score DESC
LIMIT 20;
```

### 3. View market mappings from algorithmic matcher

```sql
SELECT mm.canonical_market_id, mm.exchange_id, mm.market_id,
       mm.outcome_side, mm.confidence_score
FROM direct_exchanges_data.market_mappings mm
WHERE mm.model_id = 'algorithmic-v1'
ORDER BY mm.matched_at DESC LIMIT 20;
```

### 4. View market titles

```sql
SELECT mt.canonical_market_id, mt.generated_title,
       mt.kalshi_title, mt.polymarket_title
FROM direct_exchanges_data.market_titles mt
WHERE mt.model_id = 'algorithmic-v1'
ORDER BY mt.updated_at DESC LIMIT 20;
```

### 5. View AI-verified market matches

```sql
SELECT mm.canonical_market_id, mm.exchange_id, mm.market_id,
       mm.outcome_side, mm.confidence_score, mm.model_id
FROM direct_exchanges_data.market_mappings mm
WHERE mm.model_id = 'ai-verified-v1'
ORDER BY mm.matched_at DESC LIMIT 20;
```

### 6. Full cross-exchange market view

```sql
SELECT mt.generated_title,
       k.market_id as kalshi_market, p.market_id as poly_market,
       km.confidence_score
FROM direct_exchanges_data.market_titles mt
JOIN direct_exchanges_data.market_mappings km
  ON mt.canonical_market_id = km.canonical_market_id AND km.exchange_id = 'KALSHI' AND km.outcome_side = 'YES'
JOIN direct_exchanges_data.market_mappings pm
  ON mt.canonical_market_id = pm.canonical_market_id AND pm.exchange_id = 'POLYMARKET' AND pm.outcome_side = 'YES'
JOIN direct_exchanges_data.prediction_markets k
  ON km.source_id = k.source_id AND km.exchange_id = k.exchange_id AND km.market_id = k.market_id AND km.outcome_side = k.outcome_side
JOIN direct_exchanges_data.prediction_markets p
  ON pm.source_id = p.source_id AND pm.exchange_id = p.exchange_id AND pm.market_id = p.market_id AND pm.outcome_side = p.outcome_side
WHERE mt.model_id = 'algorithmic-v1'
ORDER BY mt.updated_at DESC LIMIT 20;
```

---

## Troubleshooting

### No market mappings being created

1. Check event mappings exist: `SELECT COUNT(*) FROM event_mappings WHERE is_active = TRUE`
2. Check markets exist for matched events: query `prediction_markets` filtered by event_id
3. Check logs: `docker compose logs --tail 100 event-matcher | grep market-matcher`
4. Check if events are being skipped by recheck interval: look for `match_checked_at` values in logs

### Low match count for multi-outcome events

Two thresholds control matching:
- `MARKET_MATCH_THRESHOLD` (default `0.5`) — Jaccard auto-accept threshold
- `MARKET_MATCH_AI_THRESHOLD` (default `0.3`) — minimum Jaccard to trigger AI verification

Matches between 0.3–0.5 are sent to AI for verification (requires confidence >= 0.8). To accept more matches algorithmically, lower `MARKET_MATCH_THRESHOLD`. To send fewer borderline matches to AI, raise `MARKET_MATCH_AI_THRESHOLD`.

### AI-verified matches not appearing

1. Check if `verifyMarketMatch()` is being called: look for `ai-verified` in logs
2. Verify the AI confidence threshold — only matches with confidence >= 0.8 are accepted
3. Check rate limits — if workers are gated, AI verification may be delayed

### Markets matched but not showing in API

Verify the homepage-api is reading from `market_mappings` and the markets have `status = 'Open'`.
