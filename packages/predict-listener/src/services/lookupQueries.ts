import { query, createLogger } from '@prediction-market/shared';

const logger = createLogger('predict-lookup');

interface MarketRow {
  source_id: string;
  exchange_id: string;
  market_id: string;
}

/**
 * Find a Kalshi market by its ticker (market_id in our DB).
 * Kalshi tickers are stored directly as market_id.
 */
export async function findKalshiMarketByTicker(ticker: string): Promise<MarketRow | null> {
  const sql = `
    SELECT source_id, exchange_id, market_id
    FROM prediction_markets
    WHERE exchange_id = 'KALSHI'
      AND market_id = $1
      AND outcome_side = 'YES'
    LIMIT 1
  `;

  const result = await query<MarketRow>(sql, [ticker]);
  return result.rows[0] || null;
}

/**
 * Find a Polymarket market by condition ID stored in source_specific_data.
 */
export async function findPolymarketByConditionId(conditionId: string): Promise<MarketRow | null> {
  const sql = `
    SELECT source_id, exchange_id, market_id
    FROM prediction_markets
    WHERE exchange_id = 'POLYMARKET'
      AND outcome_side = 'YES'
      AND source_specific_data::jsonb->>'condition_id' = $1
    LIMIT 1
  `;

  const result = await query<MarketRow>(sql, [conditionId]);
  return result.rows[0] || null;
}
