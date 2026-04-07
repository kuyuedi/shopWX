-- Add exchange_titles JSONB column to market_titles for N-exchange support.
-- Existing kalshi_title/polymarket_title columns are kept for backward compatibility.
ALTER TABLE direct_exchanges_data.market_titles
  ADD COLUMN IF NOT EXISTS exchange_titles JSONB DEFAULT '{}';
