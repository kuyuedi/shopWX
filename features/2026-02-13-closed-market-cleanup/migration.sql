-- Migration: Closed Market Cleanup Indexes
-- Run on server before/after deploying the feature
-- These indexes are optional but recommended for performance

-- Index for Phase 2: Finding closed/resolved/cancelled markets to delete
-- Partial index only covers non-open statuses, so it's small
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prediction_markets_cleanup
  ON direct_exchanges_data.prediction_markets (source_id, exchange_id, status, updated_at)
  WHERE status IN ('Closed', 'Resolved', 'Cancelled');

-- Index for Phase 1: Finding stale open markets to mark as closed
-- Partial index only covers Open status
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prediction_markets_stale_check
  ON direct_exchanges_data.prediction_markets (source_id, exchange_id, updated_at)
  WHERE status = 'Open';
