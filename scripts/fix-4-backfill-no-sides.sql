-- Fix 4: Backfill missing NO-side matches for existing YES-only mappings
-- Priority: P1 — Fixes split-row display bug on homepage
--
-- The current code already writes both YES+NO sides for NEW matches.
-- This script backfills OLD matches that only have YES side.
--
-- Run from server:
-- ssh root@8.216.43.26
-- PGPASSWORD='HAH2#mwzay_8a' psql -h pgm-0iwbjigj740ve1e5.pgsql.japan.rds.aliyuncs.com -U direct_exchanges -d direct_exchanges -f fix-4-backfill-no-sides.sql

-- Step 1: Check how many asymmetric matches exist
SELECT outcome_side, COUNT(*) as count
FROM direct_exchanges_data.market_mappings
GROUP BY outcome_side;

-- Step 2: Insert missing NO-side mappings
INSERT INTO direct_exchanges_data.market_mappings
  (source_id, exchange_id, market_id, outcome_side,
   canonical_market_id, confidence_score, matched_at,
   model_id, match_version)
SELECT
  mm_yes.source_id,
  mm_yes.exchange_id,
  pm_no.market_id,
  'NO',
  mm_yes.canonical_market_id,
  mm_yes.confidence_score,
  NOW(),
  mm_yes.model_id,
  mm_yes.match_version
FROM direct_exchanges_data.market_mappings mm_yes
-- Find the YES-side prediction_market row
JOIN direct_exchanges_data.prediction_markets pm_yes
  ON mm_yes.source_id = pm_yes.source_id
  AND mm_yes.exchange_id = pm_yes.exchange_id
  AND mm_yes.market_id = pm_yes.market_id
  AND pm_yes.outcome_side = 'YES'
-- Find the corresponding NO-side prediction_market row (same event, same title)
JOIN direct_exchanges_data.prediction_markets pm_no
  ON pm_yes.source_id = pm_no.source_id
  AND pm_yes.exchange_id = pm_no.exchange_id
  AND pm_yes.event_id = pm_no.event_id
  AND pm_no.outcome_side = 'NO'
  AND pm_yes.title = pm_no.title
WHERE mm_yes.outcome_side = 'YES'
-- Only insert if NO-side mapping doesn't already exist
AND NOT EXISTS (
  SELECT 1 FROM direct_exchanges_data.market_mappings mm_no
  WHERE mm_no.canonical_market_id = mm_yes.canonical_market_id
  AND mm_no.exchange_id = mm_yes.exchange_id
  AND mm_no.outcome_side = 'NO'
)
ON CONFLICT (source_id, exchange_id, market_id, outcome_side) DO NOTHING;

-- Step 3: Verify — YES and NO counts should now be equal
SELECT outcome_side, COUNT(*) as count
FROM direct_exchanges_data.market_mappings
GROUP BY outcome_side;
