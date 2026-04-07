# Sports Multi-Outcome Matching Fix — Usage & Cleanup

## Deploy

```bash
pnpm build
./deploy-event-matcher.sh
```

## Count Affected Matches (read-only)

```sql
SELECT COUNT(*) AS win_draw_mismatches
FROM direct_exchanges_data.market_mappings mm1
JOIN direct_exchanges_data.market_mappings mm2
  ON mm1.canonical_market_id = mm2.canonical_market_id
  AND mm2.exchange_id = 'POLYMARKET'
JOIN direct_exchanges_data.prediction_markets pm1
  ON mm1.source_id = pm1.source_id AND mm1.exchange_id = pm1.exchange_id
  AND mm1.market_id = pm1.market_id AND mm1.outcome_side = 'YES'
JOIN direct_exchanges_data.prediction_markets pm2
  ON mm2.source_id = pm2.source_id AND mm2.exchange_id = pm2.exchange_id
  AND mm2.market_id = pm2.market_id AND mm2.outcome_side = 'YES'
WHERE mm1.exchange_id = 'KALSHI'
  AND mm1.model_id = 'substring-v1'
  AND (
    (pm2.title ~* '\b(draw|tie|tied)\b' AND pm1.title !~* '\b(draw|tie|tied)\b')
    OR (pm1.title ~* '\b(draw|tie|tied)\b' AND pm2.title !~* '\b(draw|tie|tied)\b')
  );
```

## Delete Bad Matches

```sql
-- Delete bad market_mappings
WITH bad_matches AS (
  SELECT DISTINCT mm1.canonical_market_id
  FROM direct_exchanges_data.market_mappings mm1
  JOIN direct_exchanges_data.market_mappings mm2
    ON mm1.canonical_market_id = mm2.canonical_market_id
    AND mm2.exchange_id = 'POLYMARKET'
  JOIN direct_exchanges_data.prediction_markets pm1
    ON mm1.source_id = pm1.source_id AND mm1.exchange_id = pm1.exchange_id
    AND mm1.market_id = pm1.market_id AND mm1.outcome_side = 'YES'
  JOIN direct_exchanges_data.prediction_markets pm2
    ON mm2.source_id = pm2.source_id AND mm2.exchange_id = pm2.exchange_id
    AND mm2.market_id = pm2.market_id AND mm2.outcome_side = 'YES'
  WHERE mm1.exchange_id = 'KALSHI'
    AND mm1.model_id = 'substring-v1'
    AND (
      (pm2.title ~* '\b(draw|tie|tied)\b' AND pm1.title !~* '\b(draw|tie|tied)\b')
      OR (pm1.title ~* '\b(draw|tie|tied)\b' AND pm2.title !~* '\b(draw|tie|tied)\b')
    )
)
DELETE FROM direct_exchanges_data.market_mappings
WHERE canonical_market_id IN (SELECT canonical_market_id FROM bad_matches);

-- Delete associated market_titles
WITH bad_matches AS (
  SELECT DISTINCT mm1.canonical_market_id
  FROM direct_exchanges_data.market_mappings mm1
  JOIN direct_exchanges_data.market_mappings mm2
    ON mm1.canonical_market_id = mm2.canonical_market_id
    AND mm2.exchange_id = 'POLYMARKET'
  JOIN direct_exchanges_data.prediction_markets pm1
    ON mm1.source_id = pm1.source_id AND mm1.exchange_id = pm1.exchange_id
    AND mm1.market_id = pm1.market_id AND mm1.outcome_side = 'YES'
  JOIN direct_exchanges_data.prediction_markets pm2
    ON mm2.source_id = pm2.source_id AND mm2.exchange_id = pm2.exchange_id
    AND mm2.market_id = pm2.market_id AND mm2.outcome_side = 'YES'
  WHERE mm1.exchange_id = 'KALSHI'
    AND mm1.model_id = 'substring-v1'
    AND (
      (pm2.title ~* '\b(draw|tie|tied)\b' AND pm1.title !~* '\b(draw|tie|tied)\b')
      OR (pm1.title ~* '\b(draw|tie|tied)\b' AND pm2.title !~* '\b(draw|tie|tied)\b')
    )
)
DELETE FROM direct_exchanges_data.market_titles
WHERE canonical_market_id IN (SELECT canonical_market_id FROM bad_matches);

-- Delete phantom arbs
WITH bad_matches AS (
  SELECT DISTINCT mm1.canonical_market_id
  FROM direct_exchanges_data.market_mappings mm1
  JOIN direct_exchanges_data.market_mappings mm2
    ON mm1.canonical_market_id = mm2.canonical_market_id
    AND mm2.exchange_id = 'POLYMARKET'
  JOIN direct_exchanges_data.prediction_markets pm1
    ON mm1.source_id = pm1.source_id AND mm1.exchange_id = pm1.exchange_id
    AND mm1.market_id = pm1.market_id AND mm1.outcome_side = 'YES'
  JOIN direct_exchanges_data.prediction_markets pm2
    ON mm2.source_id = pm2.source_id AND mm2.exchange_id = pm2.exchange_id
    AND mm2.market_id = pm2.market_id AND mm2.outcome_side = 'YES'
  WHERE mm1.exchange_id = 'KALSHI'
    AND mm1.model_id = 'substring-v1'
    AND (
      (pm2.title ~* '\b(draw|tie|tied)\b' AND pm1.title !~* '\b(draw|tie|tied)\b')
      OR (pm1.title ~* '\b(draw|tie|tied)\b' AND pm2.title !~* '\b(draw|tie|tied)\b')
    )
)
DELETE FROM direct_exchanges_data.arb_opportunities
WHERE canonical_market_id IN (SELECT canonical_market_id FROM bad_matches);
```

## Re-run Backfill

After deleting bad matches, re-run the Phase 1.5 backfill to re-match those markets with the fixed code:

```bash
# On server
cd /opt/prediction-market-ingestion/packages/event-matcher
DATABASE_URL=$DATABASE_URL node dist/scripts/backfillMarketMatches.js
```

## Verification

```sql
-- No Win↔Draw mismatches remaining (expected: 0)
SELECT COUNT(*) FROM direct_exchanges_data.market_mappings mm1
JOIN direct_exchanges_data.market_mappings mm2
  ON mm1.canonical_market_id = mm2.canonical_market_id AND mm2.exchange_id = 'POLYMARKET'
JOIN direct_exchanges_data.prediction_markets pm1
  ON mm1.source_id = pm1.source_id AND mm1.exchange_id = pm1.exchange_id
  AND mm1.market_id = pm1.market_id AND mm1.outcome_side = 'YES'
JOIN direct_exchanges_data.prediction_markets pm2
  ON mm2.source_id = pm2.source_id AND mm2.exchange_id = pm2.exchange_id
  AND mm2.market_id = pm2.market_id AND mm2.outcome_side = 'YES'
WHERE mm1.exchange_id = 'KALSHI' AND mm1.model_id = 'substring-v1'
  AND (
    (pm2.title ~* '\b(draw|tie|tied)\b' AND pm1.title !~* '\b(draw|tie|tied)\b')
    OR (pm1.title ~* '\b(draw|tie|tied)\b' AND pm2.title !~* '\b(draw|tie|tied)\b')
  );

-- No unrealistic arbs (expected: 0 or near-zero)
SELECT COUNT(*) FROM direct_exchanges_data.arb_opportunities
WHERE status = 'ACTIVE' AND gross_spread_pct > 0.20;

-- Spot-check Rangers example
SELECT mm1.market_id as kalshi_market, pm1.title as kalshi_title,
       mm2.market_id as poly_market, pm2.title as poly_title
FROM direct_exchanges_data.market_mappings mm1
JOIN direct_exchanges_data.market_mappings mm2
  ON mm1.canonical_market_id = mm2.canonical_market_id AND mm2.exchange_id = 'POLYMARKET'
JOIN direct_exchanges_data.prediction_markets pm1
  ON mm1.source_id = pm1.source_id AND mm1.exchange_id = pm1.exchange_id
  AND mm1.market_id = pm1.market_id AND mm1.outcome_side = 'YES'
JOIN direct_exchanges_data.prediction_markets pm2
  ON mm2.source_id = pm2.source_id AND mm2.exchange_id = pm2.exchange_id
  AND mm2.market_id = pm2.market_id AND mm2.outcome_side = 'YES'
WHERE mm1.exchange_id = 'KALSHI' AND mm1.outcome_side = 'YES'
  AND pm1.title ILIKE '%rangers%'
LIMIT 5;
```
