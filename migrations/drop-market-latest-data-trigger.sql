-- Run AFTER deploying the code changes (Fix 2a + 2b).
-- While the trigger exists, it overrides updated_at with NOW() — same as current behavior.
-- After dropping, the application-side entryTime timestamps take effect.

DROP TRIGGER IF EXISTS trigger_market_latest_data_updated_at
  ON direct_exchanges_data.market_latest_data;

DROP FUNCTION IF EXISTS direct_exchanges_data.update_market_latest_data_updated_at();
