# Phase 1.5 — Usage & Validation

## How to Run

```bash
# Deploy first (to get latest code on server)
./deploy-event-matcher.sh

# Run the backfill inside the running container
docker compose exec event-matcher npx tsx src/scripts/backfillMarketMatches.ts
```

No database migrations needed.

## Verification Queries

```sql
-- 1. Match rate (target: >85%, currently ~52%)
SELECT COUNT(*) AS total, COUNT(mm.canonical_market_id) AS matched,
  ROUND(100.0 * COUNT(mm.canonical_market_id) / NULLIF(COUNT(*), 0), 1) AS pct
FROM direct_exchanges_data.prediction_markets pm
JOIN direct_exchanges_data.event_mappings em
  ON pm.source_id = em.source_id AND pm.exchange_id = em.exchange_id AND pm.event_id = em.event_id
LEFT JOIN direct_exchanges_data.market_mappings mm
  ON pm.source_id = mm.source_id AND pm.exchange_id = mm.exchange_id
  AND pm.market_id = mm.market_id AND pm.outcome_side = mm.outcome_side
WHERE em.canonical_event_id IN (
  SELECT canonical_event_id FROM direct_exchanges_data.event_mappings
  GROUP BY canonical_event_id HAVING COUNT(DISTINCT exchange_id) > 1
) AND pm.status = 'Open' AND pm.outcome_side = 'YES';

-- 2. Matches by model (expect growth in substring-v1)
SELECT model_id, COUNT(*) FROM direct_exchanges_data.market_mappings GROUP BY model_id ORDER BY 2 DESC;

-- 3. YES/NO parity
SELECT outcome_side, COUNT(*) FROM direct_exchanges_data.market_mappings GROUP BY outcome_side;
```

## Post-Run Results

_(To be filled after running the backfill)_

- Match rate before: _%
- Match rate after: _%
- Markets matched: _
- Event pairs processed: _
- Runtime: _
- Arb count change: _
