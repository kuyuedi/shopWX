import { createHash } from 'crypto';
import {
  createLogger,
  upsertMarketMappingsBatch,
  fetchExistingMappedMarketIds,
  findExistingCanonicalMarketId,
  PREDICT_SOURCE_ID,
  PREDICT_EXCHANGE_ID,
  KALSHI_SOURCE_ID,
  KALSHI_EXCHANGE_ID,
  POLYMARKET_SOURCE_ID,
  POLYMARKET_EXCHANGE_ID,
  type MarketMapping,
} from '@prediction-market/shared';
import type { PredictMarket } from '../types/api.js';
import {
  findKalshiMarketByTicker,
  findPolymarketByConditionId,
} from './lookupQueries.js';

const logger = createLogger('predict-cross-mapping');

/**
 * Generate a deterministic canonical market ID using the same algorithm
 * as event-matcher, so arb scanner sees a single canonical group.
 */
function generateCanonicalMarketId(
  entries: Array<{ exchangeId: string; id: string }>
): string {
  const keys = entries.map(e => `${e.exchangeId}:${e.id}`).sort();
  const hash = createHash('sha256')
    .update(keys.join('|'))
    .digest('hex')
    .substring(0, 16);
  return `CM-${hash}`;
}

/**
 * Auto-populate market_mappings from Predict.fun's built-in
 * kalshiMarketTicker and polymarketConditionIds fields.
 *
 * Uses hash-based canonical IDs (CM-<hash>) consistent with event-matcher,
 * so the arb scanner can group Predict + Kalshi + Polymarket markets
 * under a single canonical_market_id.
 */
export async function syncCrossExchangeMappings(markets: PredictMarket[]): Promise<void> {
  const existingMapped = await fetchExistingMappedMarketIds();
  const mappings: MarketMapping[] = [];
  const now = new Date();
  let kalshiLinks = 0;
  let polyLinks = 0;
  let skipped = 0;

  for (const market of markets) {
    const predictMarketId = String(market.id);

    // Skip if this Predict market is already mapped
    if (existingMapped.has(predictMarketId)) {
      skipped++;
      continue;
    }

    // Kalshi cross-mapping
    if (market.kalshiMarketTicker) {
      try {
        const kalshiMarket = await findKalshiMarketByTicker(market.kalshiMarketTicker);
        if (kalshiMarket) {
          // Check if either market already belongs to a canonical group
          const [existingPredict, existingKalshi] = await Promise.all([
            findExistingCanonicalMarketId(PREDICT_SOURCE_ID, PREDICT_EXCHANGE_ID, predictMarketId),
            findExistingCanonicalMarketId(kalshiMarket.source_id, KALSHI_EXCHANGE_ID, kalshiMarket.market_id),
          ]);
          const canonicalId = existingPredict || existingKalshi || generateCanonicalMarketId([
            { exchangeId: PREDICT_EXCHANGE_ID, id: predictMarketId },
            { exchangeId: KALSHI_EXCHANGE_ID, id: kalshiMarket.market_id },
          ]);

          // 4 rows: Predict YES, Predict NO, Kalshi YES, Kalshi NO
          for (const side of ['YES', 'NO'] as const) {
            mappings.push(
              {
                source_id: PREDICT_SOURCE_ID,
                exchange_id: PREDICT_EXCHANGE_ID,
                market_id: predictMarketId,
                outcome_side: side,
                canonical_market_id: canonicalId,
                confidence_score: 1.0,
                matched_at: now,
                model_id: 'predict-api-link-v1',
                match_version: 1,
              },
              {
                source_id: kalshiMarket.source_id,
                exchange_id: KALSHI_EXCHANGE_ID,
                market_id: kalshiMarket.market_id,
                outcome_side: side,
                canonical_market_id: canonicalId,
                confidence_score: 1.0,
                matched_at: now,
                model_id: 'predict-api-link-v1',
                match_version: 1,
              },
            );
          }
          kalshiLinks++;
        }
      } catch (err) {
        logger.warn({ err, ticker: market.kalshiMarketTicker }, 'Failed to look up Kalshi market');
      }
    }

    // Polymarket cross-mapping
    if (market.polymarketConditionIds?.length > 0) {
      for (const conditionId of market.polymarketConditionIds) {
        try {
          const polyMarket = await findPolymarketByConditionId(conditionId);
          if (polyMarket) {
            // Check if either market already belongs to a canonical group
            const [existingPredict, existingPoly] = await Promise.all([
              findExistingCanonicalMarketId(PREDICT_SOURCE_ID, PREDICT_EXCHANGE_ID, predictMarketId),
              findExistingCanonicalMarketId(polyMarket.source_id, POLYMARKET_EXCHANGE_ID, polyMarket.market_id),
            ]);
            const canonicalId = existingPredict || existingPoly || generateCanonicalMarketId([
              { exchangeId: PREDICT_EXCHANGE_ID, id: predictMarketId },
              { exchangeId: POLYMARKET_EXCHANGE_ID, id: polyMarket.market_id },
            ]);

            for (const side of ['YES', 'NO'] as const) {
              mappings.push(
                {
                  source_id: PREDICT_SOURCE_ID,
                  exchange_id: PREDICT_EXCHANGE_ID,
                  market_id: predictMarketId,
                  outcome_side: side,
                  canonical_market_id: canonicalId,
                  confidence_score: 1.0,
                  matched_at: now,
                  model_id: 'predict-api-link-v1',
                  match_version: 1,
                },
                {
                  source_id: polyMarket.source_id,
                  exchange_id: POLYMARKET_EXCHANGE_ID,
                  market_id: polyMarket.market_id,
                  outcome_side: side,
                  canonical_market_id: canonicalId,
                  confidence_score: 1.0,
                  matched_at: now,
                  model_id: 'predict-api-link-v1',
                  match_version: 1,
                },
              );
            }
            polyLinks++;
          }
        } catch (err) {
          logger.warn({ err, conditionId }, 'Failed to look up Polymarket market');
        }
      }
    }
  }

  // Batch upsert all mappings
  if (mappings.length > 0) {
    const CHUNK_SIZE = 100;
    for (let i = 0; i < mappings.length; i += CHUNK_SIZE) {
      await upsertMarketMappingsBatch(mappings.slice(i, i + CHUNK_SIZE));
    }
  }

  logger.info({
    kalshiLinks,
    polyLinks,
    skipped,
    totalMappings: mappings.length,
  }, 'Cross-exchange mapping sync complete');
}
