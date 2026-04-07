import 'dotenv/config';
import {
  createLogger, query, healthCheck, closePool,
  KALSHI_SOURCE_ID, KALSHI_EXCHANGE_ID,
  POLYMARKET_SOURCE_ID, POLYMARKET_EXCHANGE_ID,
} from '@prediction-market/shared';
import { getConfig } from '../config.js';
import { matchMarketsForSinglePair } from '../services/marketMatcher.js';

const logger = createLogger('backfill-market-matches');

async function main() {
  logger.info('Starting Phase 1.5: market re-match backfill');

  const config = getConfig();

  const dbHealthy = await healthCheck();
  if (!dbHealthy) {
    logger.error('Database health check failed, exiting');
    process.exit(1);
  }
  logger.info('Database connected');

  // Find matched event pairs with unmatched markets on both sides
  const sql = `
    SELECT
      k_em.source_id  AS kalshi_source_id,
      k_em.event_id   AS kalshi_event_id,
      p_em.source_id  AS poly_source_id,
      p_em.event_id   AS poly_event_id,
      k_em.canonical_event_id,
      k_unmatched.cnt AS kalshi_unmatched,
      p_unmatched.cnt AS poly_unmatched
    FROM direct_exchanges_data.event_mappings k_em
    JOIN direct_exchanges_data.event_mappings p_em
      ON k_em.canonical_event_id = p_em.canonical_event_id
      AND p_em.exchange_id = 'POLYMARKET'
    -- Count unmatched Kalshi markets in this event
    JOIN LATERAL (
      SELECT COUNT(*) AS cnt
      FROM direct_exchanges_data.prediction_markets pm
      LEFT JOIN direct_exchanges_data.market_mappings mm
        ON pm.source_id = mm.source_id
        AND pm.exchange_id = mm.exchange_id
        AND pm.market_id = mm.market_id
        AND pm.outcome_side = mm.outcome_side
      WHERE pm.source_id = k_em.source_id
        AND pm.exchange_id = 'KALSHI'
        AND pm.event_id = k_em.event_id
        AND pm.outcome_side = 'YES'
        AND pm.status = 'Open'
        AND mm.canonical_market_id IS NULL
    ) k_unmatched ON true
    -- Count unmatched Poly markets in this event
    JOIN LATERAL (
      SELECT COUNT(*) AS cnt
      FROM direct_exchanges_data.prediction_markets pm
      LEFT JOIN direct_exchanges_data.market_mappings mm
        ON pm.source_id = mm.source_id
        AND pm.exchange_id = mm.exchange_id
        AND pm.market_id = mm.market_id
        AND pm.outcome_side = mm.outcome_side
      WHERE pm.source_id = p_em.source_id
        AND pm.exchange_id = 'POLYMARKET'
        AND pm.event_id = p_em.event_id
        AND pm.outcome_side = 'YES'
        AND pm.status = 'Open'
        AND mm.canonical_market_id IS NULL
    ) p_unmatched ON true
    WHERE k_em.exchange_id = 'KALSHI'
      AND k_unmatched.cnt > 0
      AND p_unmatched.cnt > 0
    ORDER BY k_unmatched.cnt + p_unmatched.cnt DESC
  `;

  const result = await query(sql);
  const pairs = result.rows;

  logger.info({
    pairsToProcess: pairs.length,
    totalUnmatched: pairs.reduce(
      (s: number, r: Record<string, unknown>) =>
        s + Number(r.kalshi_unmatched) + Number(r.poly_unmatched), 0
    ),
  }, 'Found event pairs with unmatched markets');

  let totalMatched = 0;
  let pairsProcessed = 0;
  const CONCURRENCY = parseInt(process.env.BACKFILL_CONCURRENCY || '10');

  logger.info({ concurrency: CONCURRENCY }, 'Starting parallel backfill');

  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < pairs.length) {
      const idx = nextIndex++;
      const pair = pairs[idx]!;

      const matched = await matchMarketsForSinglePair(
        pair.kalshi_source_id as string,
        KALSHI_EXCHANGE_ID,
        pair.kalshi_event_id as string,
        pair.poly_source_id as string,
        POLYMARKET_EXCHANGE_ID,
        pair.poly_event_id as string,
        config
      );

      totalMatched += matched;
      pairsProcessed++;

      if (matched > 0) {
        logger.info({
          kalshiEvent: pair.kalshi_event_id,
          polyEvent: pair.poly_event_id,
          matched,
          progress: `${pairsProcessed}/${pairs.length}`,
        }, 'Backfill matched markets for event pair');
      }

      if (pairsProcessed % 50 === 0) {
        logger.info({
          pairsProcessed,
          totalPairs: pairs.length,
          totalMatched,
        }, 'Backfill progress');
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  logger.info({
    pairsProcessed,
    totalMatched,
  }, 'Phase 1.5 backfill complete');

  await closePool();
  process.exit(0);
}

main().catch(async (err) => {
  logger.error({ err }, 'Backfill failed');
  await closePool();
  process.exit(1);
});
