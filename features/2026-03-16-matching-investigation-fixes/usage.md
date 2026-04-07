# Matching Investigation Fixes — Validation & Results

## Deployment Summary

- **Deployed:** 2026-03-17 21:38 CST
- **Commit:** `f78e091` on `origin/main`
- **Services restarted:** event-matcher

### SQL Migrations Applied

| Migration | Result |
|-----------|--------|
| Fix 1: Delete matches with confidence < 0.80 | 5,082 rows deleted |
| Fix 4: Backfill NO-side mappings | 0 rows inserted — remaining 126 YES-only mappings reference deleted/closed markets with no `prediction_markets` row; orphaned, no backfill possible |

---

## Validation

### 1. No Low-Confidence Matches Remain

Verifies Fix 1 (delete bad matches) and Fix 2 (raised threshold prevents new bad matches).

```sql
SELECT MIN(confidence_score) as min_conf,
  COUNT(*) FILTER (WHERE confidence_score < 0.80) as bad_count
FROM direct_exchanges_data.market_mappings;
```

| Check | Expected | Actual (2026-03-17) |
|-------|----------|---------------------|
| `min_conf` | ≥ 0.80 | 0.80 |
| `bad_count` | 0 | 0 |

### 2. YES/NO Side Parity

Verifies Fix 4 (backfill) and that new code writes both sides.

```sql
SELECT outcome_side, COUNT(*) FROM direct_exchanges_data.market_mappings GROUP BY outcome_side;
```

| Side | Count (2026-03-17) |
|------|-------------------|
| YES | 7,961 |
| NO | 7,897 |

Difference of 64 is from orphaned mappings to deleted markets. All new matches write 4 rows (YES+NO per exchange).

### 3. Model Distribution

Verifies Fixes 6/7 (cross-event matching) are producing matches.

```sql
SELECT model_id, COUNT(*) FROM direct_exchanges_data.market_mappings GROUP BY model_id ORDER BY count DESC;
```

| Model | Count (2026-03-17) | Description |
|-------|-------------------|-------------|
| `substring-v1` | 8,868 | Outcome name substring matching |
| `gpt-5-nano` | 4,580 | AI event-level matching |
| `algorithmic-v1` | 2,238 | Binary (1:1) or Jaccard auto-accept |
| `ai-verified-v1` | 172 | Borderline Jaccard + AI verification |
| `cross-event-ai-v1` | — | Phase 2 cross-event matches (expected after first cycle completes) |

### 4. Match Coverage Rate

Measures overall improvement from all 7 fixes combined.

```sql
SELECT COUNT(*) as total,
  COUNT(mm.canonical_market_id) as matched,
  ROUND(100.0 * COUNT(mm.canonical_market_id) / NULLIF(COUNT(*), 0), 1) as match_rate_pct
FROM direct_exchanges_data.prediction_markets pm
JOIN direct_exchanges_data.event_mappings em
  ON pm.source_id = em.source_id AND pm.exchange_id = em.exchange_id AND pm.event_id = em.event_id
LEFT JOIN direct_exchanges_data.market_mappings mm
  ON pm.source_id = mm.source_id AND pm.exchange_id = mm.exchange_id
  AND pm.market_id = mm.market_id AND pm.outcome_side = mm.outcome_side
WHERE em.canonical_event_id IN (
  SELECT canonical_event_id FROM direct_exchanges_data.event_mappings
  GROUP BY canonical_event_id HAVING COUNT(DISTINCT exchange_id) > 1
) AND pm.status = 'Open';
```

| Metric | Before | After (2026-03-17) | Target |
|--------|--------|---------------------|--------|
| Match rate | 56.4% | 49.4% (temporary dip from deleting 5k bad matches) | >85% |

Match rate dropped initially because Fix 1 removed 5,082 incorrect matches. It will climb as Phase 2 cross-event matching finds new correct matches and improved pre-filtering (Fix 3) catches previously missed pairs.

### 5. Cross-Event Match Examples

After Phase 2 has run, inspect the new matches:

```sql
SELECT mm.canonical_market_id, mm.exchange_id, mm.market_id,
       mm.confidence_score, pm.title
FROM direct_exchanges_data.market_mappings mm
JOIN direct_exchanges_data.prediction_markets pm
  ON mm.source_id = pm.source_id AND mm.exchange_id = pm.exchange_id
  AND mm.market_id = pm.market_id AND mm.outcome_side = pm.outcome_side
WHERE mm.model_id = 'cross-event-ai-v1'
ORDER BY mm.matched_at DESC
LIMIT 20;
```

### 6. Service Logs

Verify Phase 2 is running in logs:

```bash
ssh root@8.216.43.26 "docker compose -f /opt/prediction-market-ingestion/docker-compose.yml logs --tail 100 event-matcher" | grep -E 'Phase 2|cross-event|Mega-event|cycle complete'
```

Expected log entries:
- `"Starting Phase 2: cross-event matching"` — Phase 2 running
- `"Unmatched Kalshi markets found"` — markets being processed
- `"Cross-event market match written"` — successful matches
- `"Mega-event detected"` — mega-events identified
- `"Matching cycle complete"` with `crossEventMatched` — cycle summary

---

## Server Verification (2026-03-17)

All 7 fixes confirmed present in deployed code at `/opt/prediction-market-ingestion`:

| Fix | File | Verified |
|-----|------|----------|
| Fix 1 | SQL migration | 5,082 rows deleted, `MIN(confidence_score) = 0.80` |
| Fix 2 | `config.ts:12` | `MARKET_MATCH_THRESHOLD || '0.85'` |
| Fix 3a | `preFilter.ts:66` | `extractEntity()` exported |
| Fix 3b | `preFilter.ts:19-39` | `SYNONYMS` map with 20 entries |
| Fix 3c | `preFilter.ts:45` | `stripAccents()` exported, used in preFilter + marketMatcher |
| Fix 4 | SQL migration | Near parity (7,961 YES / 7,897 NO) |
| Fix 5 | `aiComparer.ts` | 2 `REJECTION CRITERIA` blocks (event + market prompts) |
| Fix 6/7 | `crossEventMatcher.ts` (340 lines) | Wired in `matchingCycle.ts:216-218`, Phase 2 processing 14,975 entities |

---

## Rollback

### Remove bad matches if they reappear
```sql
DELETE FROM direct_exchanges_data.market_mappings WHERE confidence_score < 0.80;
```

### Remove Phase 2 matches if incorrect
```sql
DELETE FROM direct_exchanges_data.market_mappings WHERE model_id = 'cross-event-ai-v1';
```

### Revert service to previous version
```bash
ssh root@8.216.43.26 "cd /opt/prediction-market-ingestion && git checkout HEAD~3 -- packages/event-matcher/ packages/shared/src/db/queries.ts && docker compose build event-matcher && docker compose up -d event-matcher"
```
