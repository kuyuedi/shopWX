-- Fix 1: Delete bad low-confidence matches
-- Priority: P0 — Run this first, no code deploy needed
-- Impact: Removes incorrect threshold-vs-exact matches from homepage display
--
-- Run from server:
-- ssh root@8.216.43.26
-- PGPASSWORD='HAH2#mwzay_8a' psql -h pgm-0iwbjigj740ve1e5.pgsql.japan.rds.aliyuncs.com -U direct_exchanges -d direct_exchanges -f fix-1-delete-bad-matches.sql

-- Step 1: Check what will be deleted
SELECT
  confidence_score,
  COUNT(*) as count
FROM direct_exchanges_data.market_mappings
WHERE confidence_score < 0.80
GROUP BY confidence_score
ORDER BY confidence_score;

-- Step 2: Delete all matches with confidence below 0.80
DELETE FROM direct_exchanges_data.market_mappings
WHERE confidence_score < 0.80;

-- Step 3: Verify — check how many remain
SELECT
  COUNT(*) as total_remaining,
  MIN(confidence_score) as min_confidence,
  AVG(confidence_score)::numeric(4,2) as avg_confidence
FROM direct_exchanges_data.market_mappings;
